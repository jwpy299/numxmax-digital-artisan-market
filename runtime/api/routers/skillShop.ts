/**
 * skillShop —— 迭代 31「技能商店 + 能力资产化 + 三方分账」服务端路由（契约 §2）。
 *
 * 数据表（db/sync-ops.mts 幂等创建，一律 raw SQL 访问，不改 drizzle schema）：
 * - st_skill_packs       技能包商品（pack_key 唯一，content_json=五件套快照）
 * - st_pack_applications 上架申请与确权（staff/factory 双轨，企业主确认）
 * - st_pack_purchases    购买与分账流水（同厂同 pack 幂等）
 * - st_pack_mounts       已购挂载（UNIQUE(pack_key, buyer_factory_id, agent_id) 幂等）
 * - st_creator_income    创作者/企业/平台收益台账（accrued/settled；结算兑换「未来开放」）
 *
 * 鉴权约定：
 * - 商店 list/detail 免登录；
 * - 购买/挂载/确认/收益（企业视角）走 wb 企业 token（wb_users.authToken → user.factoryId，
 *   参照 evo.ts feedbackActor 第二轨）；
 * - 上架申请/员工收益走 requireStaff（st_staff_accounts.authToken，复用 staff.ts）；
 * - 审核/种子/分账总览 requireAdmin（复用 terminal.ts）。
 *
 * 分账纯确定性整数运算（先算 platform/factory，staff=剩余，避免舍入误差）：
 * - track A（岗位技能）：企业 50% / 创作者 30% / 平台 20%
 * - track B（个人方法论）：创作者 60% / 企业 20% / 平台 20%
 * - creator_type=platform：平台 100%，其余 0
 *
 * LLM 仅用于上架脱敏报告（callSlotChat brain 槽 = kimi-k3，temperature=1 已有封装）；
 * 失败/超时静默回退为规则扫描报告（手机号/身份证/客户名/合同等模式匹配），绝不向上抛错。
 *
 * 合规：金额一律称「Token（调用计量）」；结算/兑换通道标注「未来开放」。
 */
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { resolveWbUserByToken } from "./wbSession"; // portal#86 必修：双轨解析单点同引（明文直读退役）
import { rawRows, requireAdmin } from "./terminal";
import { requireStaff, type StaffAccount } from "./staff";
import { callSlotChat } from "./modelGateway";
import { writeAdminAudit, adminDisplayName } from "./adminAnalytics";
import { applyRecommendOrder, loadRecommendSlots } from "./opsRecommend";
import { buildSkillMetas, executorKindOf, type SkillMarketMeta } from "./skillStats";
import { debitForPurchase, noteEnterpriseDebit } from "./tokenLedger";
import { screenText } from "./contentScreen";

const tokenInput = z.object({ token: z.string().trim().min(1) });

/** st_ 表查询兜底：表缺失按空集降级（seed/迁移窗口） */
async function stRows(statement: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  try {
    return rawRows(await getDb().execute(statement));
  } catch {
    return [];
  }
}

/** 台账周期（YYYY-MM） */
function currentPeriod(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ─── 工作台企业 token 鉴权（参照 evo.ts feedbackActor 第二轨）─────────────────
interface FactoryActor {
  userId: number;
  username: string;
  factoryId: number;
}

async function requireFactoryToken(token: string): Promise<FactoryActor> {
  const user = await resolveWbUserByToken(getDb(), token); // portal#86 必修：明文直读→双轨单点（指纹迁移行可读面封死）
  if (!user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "需要企业工作台账号权限" });
  }
  return {
    userId: Number(user.id),
    username: String(user.username ?? "enterprise"),
    factoryId: Number(user.factoryId),
  };
}

// ─── 分账（纯确定性整数运算）────────────────────────────────────────────────
interface Shares {
  sharePlatform: number;
  shareFactory: number;
  shareStaff: number;
}

/**
 * 先算 platform 与 factory（向下取整），staff = 剩余，保证三项之和恒等于 price。
 * creator_type=platform：平台 100%。
 */
export function splitShares(track: string, creatorType: string, price: number): Shares {
  if (creatorType === "platform") {
    return { sharePlatform: price, shareFactory: 0, shareStaff: 0 };
  }
  const sharePlatform = Math.floor((price * 20) / 100);
  const shareFactory = track === "A" ? Math.floor((price * 50) / 100) : Math.floor((price * 20) / 100);
  return { sharePlatform, shareFactory, shareStaff: price - sharePlatform - shareFactory };
}

/** 分账比例说明文案（detail 用，不暴露 content_json） */
function splitDescription(track: string, creatorType: string): string {
  if (creatorType === "platform") return "平台官方技能包：Token（调用计量）100% 归平台";
  return track === "A"
    ? "岗位共创技能包（赛道A）：企业 50% / 创作者 30% / 平台 20%（Token 调用计量）"
    : "个人创作技能包（赛道B）：创作者 60% / 企业 20% / 平台 20%（Token 调用计量）";
}

// ─── pack_key 生成（SP-+10 位去歧义字符，参照 packages.ts claimCode 风格）────
const PACK_CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 去 0/O/1/I/L

function newPackKey(): string {
  const bytes = randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i++) out += PACK_CHARSET[bytes[i] % PACK_CHARSET.length];
  return `SP-${out}`;
}

// ─── 脱敏报告：规则扫描兜底（绝不抛错）──────────────────────────────────────
const SENSITIVE_RULES: Array<{ label: string; re: RegExp; advice: string }> = [
  { label: "手机号", re: /1[3-9]\d{9}/g, advice: "请替换为占位符（如 {联系人电话}）" },
  { label: "身份证号", re: /\d{17}[\dXx]/g, advice: "请删除或替换为占位符" },
  { label: "银行卡号", re: /\d{16,19}/g, advice: "请删除，技能包不应包含银行账户信息" },
  { label: "邮箱地址", re: /[\w.+-]+@[\w-]+\.[\w.]+/g, advice: "建议替换为 {联系邮箱}" },
  { label: "合同/协议引用", re: /(合同编号|协议编号|订单号[:：]?\s*[A-Z0-9-]{6,})/gi, advice: "请泛化为 {合同编号} 等占位符" },
  { label: "客户/公司名线索", re: /(客户名称|甲方|乙方)[:：]/g, advice: "请删除具体主体名，保留方法描述" },
  { label: "内部系统地址", re: /(https?:\/\/[^\s)"']+|内网|IP[:：]?\s*\d+\.\d+\.\d+\.\d+)/gi, advice: "请移除具体地址/内网信息" },
];

function ruleSanitizeReport(text: string): string {
  const hits: string[] = [];
  for (const rule of SENSITIVE_RULES) {
    const m = text.match(rule.re);
    if (m && m.length > 0) {
      hits.push(`- 检出「${rule.label}」${m.length} 处：${rule.advice}`);
    }
  }
  if (hits.length === 0) {
    return "【规则脱敏扫描】未检出手机号/身份证/客户名/合同编号等敏感信息。建议上架前人工复核一次企业特有数据。";
  }
  return `【规则脱敏扫描】检出 ${hits.length} 类潜在敏感信息，建议按以下意见改写后再提交：\n${hits.join("\n")}`;
}

/** LLM 脱敏报告（brain 槽 kimi-k3）；失败/超时静默回退规则扫描报告，绝不抛错 */
async function buildSanitizeReport(pack: { title: string; description: string; contentText: string }): Promise<string> {
  const material = `标题：${pack.title}\n描述：${pack.description}\n内容：\n${pack.contentText}`.slice(0, 6000);
  try {
    const res = await callSlotChat("brain", {
      messages: [
        {
          role: "system",
          content:
            "你是技能商店的合规审核助手。扫描用户提交的技能包内容中的企业敏感信息" +
            "（手机号、身份证号、银行卡、客户/公司具体名称、合同/订单编号、内部地址、账号密码等），" +
            "逐项列出并给出改写建议（建议用占位符泛化）。若未检出，明确说明未检出。" +
            "输出格式：首行【脱敏扫描】结论一句话，随后分点列出问题与改写建议。不超过 400 字。",
        },
        { role: "user", content: material },
      ],
      maxTokens: 1200,
      timeoutMs: 60_000,
    });
    if (res.ok && res.content) return res.content;
  } catch {
    // 静默回退
  }
  return ruleSanitizeReport(material);
}

// ─── 行映射 ─────────────────────────────────────────────────────────────────
function parseJson(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

const toDate = (v: unknown) => (v ? new Date(String(v)) : null);

function toPackDto(r: Record<string, unknown>, withContent: boolean) {
  return {
    packKey: String(r.pack_key),
    sourceSkillKey: r.source_skill_key == null ? null : String(r.source_skill_key),
    title: String(r.title),
    description: r.description == null ? "" : String(r.description),
    layer: String(r.layer),
    track: String(r.track),
    creatorType: String(r.creator_type),
    factoryId: r.factory_id == null ? null : Number(r.factory_id),
    priceTokens: Number(r.price_tokens),
    salesCount: Number(r.sales_count ?? 0),
    status: String(r.status),
    reviewNote: r.review_note == null ? null : String(r.review_note),
    sanitizeReport: r.sanitize_report == null ? null : String(r.sanitize_report),
    listedAt: toDate(r.listed_at),
    createdAt: toDate(r.created_at),
    splitDescription: splitDescription(String(r.track), String(r.creator_type)),
    ...(withContent ? { contentJson: parseJson(r.content_json) } : {}),
  };
}

// ─── 平台包种子价格（按 layer 分档，契约 §2 seedShop）────────────────────────
const SEED_PRICE: Record<string, number> = { general: 500, professional: 800, industry: 1200 };

/**
 * Harness H1「技能真实化审计」：list/detail 响应附加 executorKind/badge/realSuccessRate。
 * 口径：pack.source_skill_key → st_skills.skill_key；真实成功率取近 90 天 st_skill_calls，
 * 样本不足 5 次为 null（前端展示「样本不足」，不回退种子 98）。失败静默不阻断列表/详情。
 */
async function withRealMeta<T extends { sourceSkillKey: string | null }>(
  dtos: T[],
): Promise<Array<T & SkillMarketMeta>> {
  try {
    const metas = await buildSkillMetas(
      dtos.map((d) => ({
        rateKey: d.sourceSkillKey,
        executorKind: d.sourceSkillKey ? executorKindOf(d.sourceSkillKey) : null,
      })),
    );
    return dtos.map((d, i) => ({ ...d, ...(metas[i] ?? { executorKind: null, badge: "generative" as const, realSuccessRate: null }) }));
  } catch {
    return dtos.map((d) => ({ ...d, executorKind: null, badge: "generative" as const, realSuccessRate: null }));
  }
}

export const skillShopRouter = createRouter({
  // ═══ 商店侧（匠市，公开免登录）══════════════════════════════════════════

  /** list：status='listed' 商品（不暴露 content_json） */
  list: publicQuery
    .input(
      z.object({
        track: z.enum(["A", "B"]).optional(),
        layer: z.string().trim().max(16).optional(),
        q: z.string().trim().max(64).optional(),
      }),
    )
    .query(async ({ input }) => {
      const rows = await stRows(
        sql`SELECT pack_key, source_skill_key, title, description, layer, track, creator_type,
                   factory_id, price_tokens, sales_count, status, listed_at, created_at
            FROM st_skill_packs
            WHERE status = 'listed'
            ${input.track ? sql`AND track = ${input.track}` : sql``}
            ${input.layer ? sql`AND layer = ${input.layer}` : sql``}
            ${input.q ? sql`AND (title LIKE ${"%" + input.q + "%"} OR description LIKE ${"%" + input.q + "%"})` : sql``}
            ORDER BY sales_count DESC, id DESC LIMIT 200`,
      );
      // 迭代 35 批次B：推荐位运营（shop_packs）只影响排序不滤除条目
      const dtos = await withRealMeta(rows.map((r) => toPackDto(r, false)));
      return applyRecommendOrder(dtos, await loadRecommendSlots("shop_packs"), (d) => d.packKey);
    }),

  /** detail：详情 + 分账比例说明（不暴露 content_json） */
  detail: publicQuery
    .input(z.object({ packKey: z.string().trim().min(1).max(64) }))
    .query(async ({ input }) => {
      const rows = await stRows(
        sql`SELECT pack_key, source_skill_key, title, description, layer, track, creator_type,
                   factory_id, price_tokens, sales_count, status, review_note, sanitize_report,
                   listed_at, created_at
            FROM st_skill_packs WHERE pack_key = ${input.packKey} AND status = 'listed' LIMIT 1`,
      );
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "技能包不存在或未上架" });
      // Harness H1：附加 executorKind/badge/realSuccessRate（失败静默）
      return (await withRealMeta([toPackDto(rows[0], false)]))[0]!;
    }),

  // ═══ 购买与挂载（wb 企业 token）════════════════════════════════════════

  /**
   * purchase：校验 listed + 同厂同 pack 幂等（重复购买返回已存在 purchaseId，不报错不重复记账）；
   * 按 track 确定性计算三方份额 → sales_count+1 → 写 3 条台账（accrued）。
   */
  purchase: publicQuery
    .input(tokenInput.extend({ packKey: z.string().trim().min(1).max(64) }))
    .mutation(async ({ input }) => {
      const actor = await requireFactoryToken(input.token);
      const db = getDb();
      const packs = await stRows(
        sql`SELECT pack_key, track, creator_type, creator_id, factory_id, price_tokens, status
            FROM st_skill_packs WHERE pack_key = ${input.packKey} LIMIT 1`,
      );
      const pack = packs[0];
      if (!pack || String(pack.status) !== "listed") {
        throw new TRPCError({ code: "NOT_FOUND", message: "技能包不存在或未上架" });
      }
      const existing = await stRows(
        sql`SELECT id FROM st_pack_purchases
            WHERE pack_key = ${input.packKey} AND buyer_factory_id = ${actor.factoryId}
            ORDER BY id LIMIT 1`,
      );
      if (existing[0]) {
        return { purchaseId: Number(existing[0].id), duplicated: true as const };
      }
      const price = Number(pack.price_tokens);
      const track = String(pack.track);
      const creatorType = String(pack.creator_type);
      const shares = splitShares(track, creatorType, price);
      // M34 站内支付闭环：购买先扣买家钱包（原子不透支，余额不足人话拦截）
      const { balanceBefore, balanceAfter } = await debitForPurchase({
        factoryId: actor.factoryId,
        amount: price,
        packKey: input.packKey,
      });
      // M45：企业出账流水落台账（可回放审计；此前只有扣费没有流水）
      await noteEnterpriseDebit({
        factoryId: actor.factoryId,
        amount: price,
        balanceAfter,
        bizType: "purchase_debit",
        refId: `pack:${input.packKey}`,
        note: `购买技能包 ${input.packKey}`,
      });
      const res = (await db.execute(
        sql`INSERT INTO st_pack_purchases
              (pack_key, buyer_factory_id, price_tokens, share_platform, share_factory, share_staff, status)
            VALUES (${input.packKey}, ${actor.factoryId}, ${price},
              ${shares.sharePlatform}, ${shares.shareFactory}, ${shares.shareStaff}, 'paid')`,
      )) as unknown;
      const header = Array.isArray(res) ? (res[0] as { insertId?: number }) : {};
      let purchaseId = Number(header?.insertId ?? 0);
      if (!purchaseId) {
        const back = await stRows(
          sql`SELECT id FROM st_pack_purchases
              WHERE pack_key = ${input.packKey} AND buyer_factory_id = ${actor.factoryId}
              ORDER BY id DESC LIMIT 1`,
        );
        purchaseId = Number(back[0]?.id ?? 0);
      }
      await db.execute(
        sql`UPDATE st_skill_packs SET sales_count = sales_count + 1 WHERE pack_key = ${input.packKey}`,
      );
      // M34：购买响应透出钱包流水（余额变动可审计）
      // 三方台账（accrued；结算兑换通道未来开放）
      const period = currentPeriod();
      const ledger: Array<{ ownerType: string; ownerId: number | null; amount: number }> = [
        { ownerType: "platform", ownerId: null, amount: shares.sharePlatform },
        {
          ownerType: "factory",
          ownerId: pack.factory_id == null ? null : Number(pack.factory_id),
          amount: shares.shareFactory,
        },
        {
          ownerType: "staff",
          ownerId: creatorType === "staff" && pack.creator_id != null ? Number(pack.creator_id) : null,
          amount: shares.shareStaff,
        },
      ];
      for (const entry of ledger) {
        if (entry.amount <= 0) continue;
        await db.execute(
          sql`INSERT INTO st_creator_income (purchase_id, owner_type, owner_id, amount, period, status)
              VALUES (${purchaseId}, ${entry.ownerType}, ${entry.ownerId}, ${entry.amount}, ${period}, 'accrued')`,
        );
      }
      return { purchaseId, duplicated: false as const, priceTokens: price, ...shares, balanceBefore, balanceAfter };
    }),

  /** myPurchases：本厂购买流水 */
  myPurchases: publicQuery.input(tokenInput).query(async ({ input }) => {
    const actor = await requireFactoryToken(input.token);
    const rows = await stRows(
      sql`SELECT p.id, p.pack_key, p.price_tokens, p.share_platform, p.share_factory, p.share_staff,
                 p.status, p.created_at, k.title, k.track, k.layer, k.creator_type
          FROM st_pack_purchases p
          LEFT JOIN st_skill_packs k ON k.pack_key = p.pack_key
          WHERE p.buyer_factory_id = ${actor.factoryId}
          ORDER BY p.id DESC LIMIT 200`,
    );
    return rows.map((r) => ({
      purchaseId: Number(r.id),
      packKey: String(r.pack_key),
      title: r.title == null ? String(r.pack_key) : String(r.title),
      track: r.track == null ? null : String(r.track),
      layer: r.layer == null ? null : String(r.layer),
      creatorType: r.creator_type == null ? null : String(r.creator_type),
      priceTokens: Number(r.price_tokens),
      sharePlatform: Number(r.share_platform),
      shareFactory: Number(r.share_factory),
      shareStaff: Number(r.share_staff),
      status: String(r.status),
      createdAt: toDate(r.created_at),
    }));
  }),

  /** myMounts：本厂已挂载列表 */
  myMounts: publicQuery.input(tokenInput).query(async ({ input }) => {
    const actor = await requireFactoryToken(input.token);
    const rows = await stRows(
      sql`SELECT m.id, m.purchase_id, m.pack_key, m.agent_id, m.enabled, m.created_at,
                 k.title AS pack_title, a.name AS agent_name
          FROM st_pack_mounts m
          LEFT JOIN st_skill_packs k ON k.pack_key = m.pack_key
          LEFT JOIN agents a ON a.id = m.agent_id
          WHERE m.buyer_factory_id = ${actor.factoryId}
          ORDER BY m.id DESC LIMIT 200`,
    );
    return rows.map((r) => ({
      mountId: Number(r.id),
      purchaseId: Number(r.purchase_id),
      packKey: String(r.pack_key),
      packTitle: r.pack_title == null ? String(r.pack_key) : String(r.pack_title),
      agentId: Number(r.agent_id),
      agentName: r.agent_name == null ? null : String(r.agent_name),
      enabled: Number(r.enabled) === 1,
      createdAt: toDate(r.created_at),
    }));
  }),

  /**
   * mount：校验 purchase 属本厂 + agent 属本厂（agent 存在 且
   * 本厂有有效 pkg_entitlements 或 agent_hire_records 有效雇佣记录任一即可，
   * 工厂归属判断参照 packages.myEntitlement 的 factory 口径）→ UNIQUE 幂等插入。
   */
  mount: publicQuery
    .input(
      tokenInput.extend({
        purchaseId: z.number().int().positive(),
        agentId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ input }) => {
      const actor = await requireFactoryToken(input.token);
      const db = getDb();
      const purchases = await stRows(
        sql`SELECT id, pack_key, buyer_factory_id FROM st_pack_purchases WHERE id = ${input.purchaseId} LIMIT 1`,
      );
      const purchase = purchases[0];
      if (!purchase || Number(purchase.buyer_factory_id) !== actor.factoryId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "该购买记录不属于当前企业" });
      }
      const packKey = String(purchase.pack_key);
      const agentRows = await stRows(
        sql`SELECT id FROM agents WHERE id = ${input.agentId} LIMIT 1`,
      );
      if (!agentRows[0]) {
        throw new TRPCError({ code: "NOT_FOUND", message: "智能体不存在" });
      }
      // 本厂归属校验：有效套餐权益 或 有效雇佣记录 任一
      const [entitlements, hires] = await Promise.all([
        stRows(
          sql`SELECT id FROM pkg_entitlements
              WHERE factory_id = ${actor.factoryId}
                AND (expires_at IS NULL OR expires_at > NOW())
              ORDER BY id DESC LIMIT 1`,
        ),
        stRows(
          sql`SELECT id FROM agent_hire_records
              WHERE agentId = ${input.agentId} AND enterpriseId = ${actor.factoryId}
                AND status = 'active' AND endsAt > NOW()
              LIMIT 1`,
        ),
      ]);
      if (entitlements.length === 0 && hires.length === 0) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "该智能体不属于当前企业（无有效套餐权益或雇佣记录），无法挂载",
        });
      }
      // UNIQUE(pack_key, buyer_factory_id, agent_id) 幂等：重复挂载返回已存在记录
      const dup = await stRows(
        sql`SELECT id FROM st_pack_mounts
            WHERE pack_key = ${packKey} AND buyer_factory_id = ${actor.factoryId} AND agent_id = ${input.agentId}
            LIMIT 1`,
      );
      if (dup[0]) {
        return { mountId: Number(dup[0].id), duplicated: true as const };
      }
      const res = (await db.execute(
        sql`INSERT INTO st_pack_mounts (purchase_id, pack_key, buyer_factory_id, agent_id, enabled)
            VALUES (${input.purchaseId}, ${packKey}, ${actor.factoryId}, ${input.agentId}, 1)`,
      )) as unknown;
      const header = Array.isArray(res) ? (res[0] as { insertId?: number }) : {};
      let mountId = Number(header?.insertId ?? 0);
      if (!mountId) {
        const back = await stRows(
          sql`SELECT id FROM st_pack_mounts
              WHERE pack_key = ${packKey} AND buyer_factory_id = ${actor.factoryId} AND agent_id = ${input.agentId}
              LIMIT 1`,
        );
        mountId = Number(back[0]?.id ?? 0);
      }
      return { mountId, duplicated: false as const };
    }),

  /** unmount：删除本厂挂载记录 */
  unmount: publicQuery
    .input(tokenInput.extend({ mountId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const actor = await requireFactoryToken(input.token);
      const rows = await stRows(
        sql`SELECT id, buyer_factory_id FROM st_pack_mounts WHERE id = ${input.mountId} LIMIT 1`,
      );
      if (!rows[0] || Number(rows[0].buyer_factory_id) !== actor.factoryId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "挂载记录不存在" });
      }
      await getDb().execute(sql`DELETE FROM st_pack_mounts WHERE id = ${input.mountId}`);
      return { ok: true as const, mountId: input.mountId };
    }),

  /** setMountEnabled：启停本厂挂载 */
  setMountEnabled: publicQuery
    .input(
      tokenInput.extend({
        mountId: z.number().int().positive(),
        enabled: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const actor = await requireFactoryToken(input.token);
      const rows = await stRows(
        sql`SELECT id, buyer_factory_id FROM st_pack_mounts WHERE id = ${input.mountId} LIMIT 1`,
      );
      if (!rows[0] || Number(rows[0].buyer_factory_id) !== actor.factoryId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "挂载记录不存在" });
      }
      await getDb().execute(
        sql`UPDATE st_pack_mounts SET enabled = ${input.enabled ? 1 : 0} WHERE id = ${input.mountId}`,
      );
      return { ok: true as const, mountId: input.mountId, enabled: input.enabled };
    }),

  // ═══ 上架申请（员工/企业 双轨）══════════════════════════════════════════

  /**
   * apply（双轨）：requireStaff → applicant_type=staff（track 可自选默认 B）；
   * wb 企业 token → applicant_type=factory（track 固定 'A'）。
   * 生成 pack_key（SP-XXXX）→ packs(draft) + applications(pending) →
   * 触发 LLM 脱敏报告（失败→规则扫描报告）写回 packs.sanitize_report。
   */
  applyPack: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        title: z.string().trim().min(1, "标题不能为空").max(64),
        description: z.string().trim().max(255).default(""),
        layer: z.string().trim().min(1).max(16),
        sourceSkillKey: z.string().trim().max(64).optional(),
        priceTokens: z.number().int().min(0).max(1_000_000),
        contentJson: z.unknown(),
        track: z.enum(["A", "B"]).optional(),
        applicantKind: z.enum(["staff", "factory"]).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // M36 UGC 本地初筛：上架标题/描述先过筛（命中转人工复审口径，不泄露命中词）
      const screen = screenText(`${input.title}\n${input.description}`);
      if (!screen.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: screen.reason });
      }
      // 双轨判定：先 staff，失败回退 wb token（企业员工）
      let staff: StaffAccount | null = null;
      try {
        staff = await requireStaff(input.token);
      } catch (err) {
        if (!(err instanceof TRPCError)) throw err;
      }
      let applicantType: "staff" | "factory";
      let applicantId: number;
      let factoryId: number | null;
      let track: "A" | "B";
      let creatorType: "staff" | "factory";
      if (staff) {
        applicantType = "staff";
        applicantId = staff.id;
        // st_staff_accounts 无 factory 归属列：staff 申请的 factory_id 置 NULL（确权由 admin 兜底）
        factoryId = null;
        track = input.track ?? "B";
        creatorType = "staff";
      } else {
        const actor = await requireFactoryToken(input.token);
        factoryId = actor.factoryId;
        // wb 企业员工：track B（或显式 applicantKind='staff'）→ 个人方法论轨，
        // creator_type='staff'（分账 60% 归员工本人台账），factory_id=本厂（企业主可确权）
        const asStaff = input.track === "B" || input.applicantKind === "staff";
        if (asStaff) {
          applicantType = "staff";
          applicantId = actor.userId;
          track = "B";
          creatorType = "staff";
        } else {
          applicantType = "factory";
          applicantId = actor.userId;
          track = "A";
          creatorType = "factory";
        }
      }
      const db = getDb();
      // 生成唯一 pack_key（SP-+10 位去歧义字符）
      let packKey = newPackKey();
      for (let i = 0; i < 5; i++) {
        const dup = await stRows(
          sql`SELECT id FROM st_skill_packs WHERE pack_key = ${packKey} LIMIT 1`,
        );
        if (dup.length === 0) break;
        packKey = newPackKey();
      }
      const contentText = JSON.stringify(input.contentJson ?? {});
      await db.execute(
        sql`INSERT INTO st_skill_packs
              (pack_key, source_skill_key, title, description, layer, track,
               creator_type, creator_id, factory_id, price_tokens, content_json, status)
            VALUES (${packKey}, ${input.sourceSkillKey ?? null}, ${input.title}, ${input.description},
              ${input.layer}, ${track}, ${creatorType}, ${applicantId}, ${factoryId},
              ${input.priceTokens}, ${contentText}, 'draft')`,
      );
      await db.execute(
        sql`INSERT INTO st_pack_applications (pack_key, applicant_type, applicant_id, factory_id, track, confirm_status)
            VALUES (${packKey}, ${applicantType}, ${applicantId}, ${factoryId}, ${track}, 'pending')`,
      );
      // LLM 脱敏报告（失败/超时静默回退规则扫描，绝不抛错）
      const report = await buildSanitizeReport({
        title: input.title,
        description: input.description,
        contentText,
      });
      await db.execute(
        sql`UPDATE st_skill_packs SET sanitize_report = ${report} WHERE pack_key = ${packKey}`,
      );
      return { packKey, applicantType, track, sanitizeReport: report };
    }),

  /** myApplications（双轨）：staff 看自己 / factory 看本厂 */
  myApplications: publicQuery.input(tokenInput).query(async ({ input }) => {
    let staff: StaffAccount | null = null;
    try {
      staff = await requireStaff(input.token);
    } catch (err) {
      if (!(err instanceof TRPCError)) throw err;
    }
    const rows = staff
      ? await stRows(
          sql`SELECT a.id, a.pack_key, a.applicant_type, a.applicant_id, a.factory_id, a.track,
                     a.confirm_by, a.confirm_at, a.confirm_status, a.created_at,
                     k.title, k.status AS pack_status, k.price_tokens
              FROM st_pack_applications a
              LEFT JOIN st_skill_packs k ON k.pack_key = a.pack_key
              WHERE a.applicant_type = 'staff' AND a.applicant_id = ${staff.id}
              ORDER BY a.id DESC LIMIT 200`,
        )
      : await (async () => {
          const actor = await requireFactoryToken(input.token);
          return stRows(
            sql`SELECT a.id, a.pack_key, a.applicant_type, a.applicant_id, a.factory_id, a.track,
                       a.confirm_by, a.confirm_at, a.confirm_status, a.created_at,
                       k.title, k.status AS pack_status, k.price_tokens
                FROM st_pack_applications a
                LEFT JOIN st_skill_packs k ON k.pack_key = a.pack_key
                WHERE a.factory_id = ${actor.factoryId}
                ORDER BY a.id DESC LIMIT 200`,
          );
        })();
    return rows.map((r) => ({
      applicationId: Number(r.id),
      packKey: String(r.pack_key),
      title: r.title == null ? String(r.pack_key) : String(r.title),
      applicantType: String(r.applicant_type),
      track: String(r.track),
      priceTokens: r.price_tokens == null ? null : Number(r.price_tokens),
      packStatus: r.pack_status == null ? null : String(r.pack_status),
      confirmStatus: String(r.confirm_status),
      confirmBy: r.confirm_by == null ? null : String(r.confirm_by),
      confirmAt: toDate(r.confirm_at),
      createdAt: toDate(r.created_at),
    }));
  }),

  // ═══ 确权（企业主：wb 企业 token，application.factory_id=本厂）═══════════

  /** confirm：confirmed → packs.track=最终值、status='pending_review'；rejected → packs.status='rejected' */
  confirm: publicQuery
    .input(
      tokenInput.extend({
        applicationId: z.number().int().positive(),
        action: z.enum(["confirmed", "rejected"]),
        track: z.enum(["A", "B"]).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const actor = await requireFactoryToken(input.token);
      const db = getDb();
      const rows = await stRows(
        sql`SELECT id, pack_key, factory_id, track, confirm_status
            FROM st_pack_applications WHERE id = ${input.applicationId} LIMIT 1`,
      );
      const app = rows[0];
      if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "申请不存在" });
      if (app.factory_id == null || Number(app.factory_id) !== actor.factoryId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "该申请不属于当前企业，无权确权" });
      }
      if (String(app.confirm_status) !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "该申请已确权，不可重复操作" });
      }
      const finalTrack = input.track ?? String(app.track);
      await db.execute(
        sql`UPDATE st_pack_applications
            SET confirm_status = ${input.action}, confirm_by = ${actor.username},
                confirm_at = NOW(), track = ${finalTrack}
            WHERE id = ${input.applicationId}`,
      );
      if (input.action === "confirmed") {
        await db.execute(
          sql`UPDATE st_skill_packs SET track = ${finalTrack}, status = 'pending_review'
              WHERE pack_key = ${String(app.pack_key)}`,
        );
      } else {
        await db.execute(
          sql`UPDATE st_skill_packs SET status = 'rejected' WHERE pack_key = ${String(app.pack_key)}`,
        );
      }
      return { ok: true as const, applicationId: input.applicationId, confirmStatus: input.action, track: finalTrack };
    }),

  // ═══ 审核与管理（admin）═════════════════════════════════════════════════

  /** reviewList：默认 pending_review，含 sanitize_report 与 content_json */
  reviewList: publicQuery
    .input(
      tokenInput.extend({
        status: z.enum(["draft", "pending_review", "listed", "rejected", "delisted"]).optional(),
      }),
    )
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const status = input.status ?? "pending_review";
      const rows = await stRows(
        sql`SELECT pack_key, source_skill_key, title, description, layer, track, creator_type,
                   creator_id, factory_id, price_tokens, content_json, sanitize_report, status,
                   review_note, sales_count, listed_at, created_at
            FROM st_skill_packs WHERE status = ${status} ORDER BY id DESC LIMIT 200`,
      );
      return rows.map((r) => toPackDto(r, true));
    }),

  /** review：listed 需确权 confirmed（平台包豁免）+ listed_at；写 review_note */
  review: publicQuery
    .input(
      tokenInput.extend({
        packKey: z.string().trim().min(1).max(64),
        action: z.enum(["listed", "rejected", "delisted"]),
        note: z.string().trim().max(255).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const db = getDb();
      const rows = await stRows(
        sql`SELECT pack_key, creator_type, status FROM st_skill_packs WHERE pack_key = ${input.packKey} LIMIT 1`,
      );
      const pack = rows[0];
      if (!pack) throw new TRPCError({ code: "NOT_FOUND", message: "技能包不存在" });
      if (input.action === "listed" && String(pack.creator_type) !== "platform") {
        const apps = await stRows(
          sql`SELECT confirm_status FROM st_pack_applications
              WHERE pack_key = ${input.packKey} ORDER BY id DESC LIMIT 1`,
        );
        if (String(apps[0]?.confirm_status ?? "") !== "confirmed") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "该技能包尚未完成企业主确权，不能上架",
          });
        }
      }
      await db.execute(
        sql`UPDATE st_skill_packs
            SET status = ${input.action}, review_note = ${input.note ?? null}
                ${input.action === "listed" ? sql`, listed_at = NOW()` : sql``}
            WHERE pack_key = ${input.packKey}`,
      );
      // 迭代 35：管理审计（fire-and-forget，失败静默）
      writeAdminAudit(Number(admin.id), adminDisplayName(admin), "skillShop.review", input.packKey, {
        action: input.action,
        note: input.note ?? null,
      });
      return { ok: true as const, packKey: input.packKey, status: input.action };
    }),

  /**
   * seedShop：幂等上架平台包（creator_type=platform、status='listed'、
   * price 按 layer 分档 general 500 / professional 800 / industry 1200，
   * content_json 从 st_skills 快照五件套；ON DUPLICATE KEY UPDATE 不重置 sales_count/status/listed_at）。
   */
  seedShop: publicQuery.input(tokenInput).mutation(async ({ input }) => {
    const admin = await requireAdmin(input.token);
    const db = getDb();
    const skills = await stRows(
      sql`SELECT skill_key, name, layer, category, description, trigger_hints, flow_steps, slot,
                 output_template, quality_checklist
          FROM st_skills WHERE status = 'active' ORDER BY layer, skill_key`,
    );
    let seeded = 0;
    for (const s of skills) {
      const skillKey = String(s.skill_key);
      const layer = String(s.layer);
      const packKey = `SP-${skillKey.toUpperCase()}`;
      const price = SEED_PRICE[layer] ?? 500;
      const content = JSON.stringify({
        triggerHints: parseJson(s.trigger_hints) ?? [],
        flowSteps: parseJson(s.flow_steps) ?? [],
        slot: String(s.slot ?? "chat"),
        outputTemplate: s.output_template == null ? "" : String(s.output_template),
        qualityChecklist: parseJson(s.quality_checklist) ?? [],
      });
      await db.execute(
        sql`INSERT INTO st_skill_packs
              (pack_key, source_skill_key, title, description, layer, track, creator_type,
               creator_id, factory_id, price_tokens, content_json, status)
            VALUES (${packKey}, ${skillKey}, ${String(s.name)}, ${String(s.description ?? "")},
              ${layer}, 'A', 'platform', NULL, NULL, ${price}, ${content}, 'listed')
            ON DUPLICATE KEY UPDATE
              source_skill_key = VALUES(source_skill_key),
              title = VALUES(title), description = VALUES(description), layer = VALUES(layer),
              price_tokens = VALUES(price_tokens), content_json = VALUES(content_json)`,
      );
      // 首次上架补 listed_at（不覆盖已有值与 status/sales_count）
      await db.execute(
        sql`UPDATE st_skill_packs SET listed_at = NOW()
            WHERE pack_key = ${packKey} AND status = 'listed' AND listed_at IS NULL`,
      );
      seeded += 1;
    }
    writeAdminAudit(Number(admin.id), adminDisplayName(admin), "skillShop.seedShop", "platform", { seeded });
    return { ok: true as const, seeded };
  }),

  /** incomeOverview：按 owner_type/period 聚合台账 + 待结算/已结算合计 */
  incomeOverview: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const [byGroup, totals] = await Promise.all([
      stRows(
        sql`SELECT owner_type, period, status, COUNT(*) AS entries, SUM(amount) AS amount
            FROM st_creator_income GROUP BY owner_type, period, status
            ORDER BY period DESC, owner_type, status LIMIT 500`,
      ),
      stRows(
        sql`SELECT status, SUM(amount) AS amount FROM st_creator_income GROUP BY status`,
      ),
    ]);
    return {
      groups: byGroup.map((r) => ({
        ownerType: String(r.owner_type),
        period: String(r.period),
        status: String(r.status),
        entries: Number(r.entries ?? 0),
        amount: Number(r.amount ?? 0),
      })),
      accruedTotal: Number(totals.find((t) => String(t.status) === "accrued")?.amount ?? 0),
      settledTotal: Number(totals.find((t) => String(t.status) === "settled")?.amount ?? 0),
      note: "金额单位为 Token（调用计量）；结算兑换通道未来开放",
    };
  }),

  // ═══ 收益查询 ═══════════════════════════════════════════════════════════

  /** staffIncome（双轨）：requireStaff → staff 账号；回退 wb token → 企业员工（owner_id=wb userId） */
  staffIncome: publicQuery.input(tokenInput).query(async ({ input }) => {
    let ownerId: number;
    try {
      const account = await requireStaff(input.token);
      ownerId = account.id;
    } catch (err) {
      if (!(err instanceof TRPCError)) throw err;
      const actor = await requireFactoryToken(input.token);
      ownerId = actor.userId;
    }
    const [totals, items] = await Promise.all([
      stRows(
        sql`SELECT status, SUM(amount) AS amount, COUNT(*) AS entries
            FROM st_creator_income WHERE owner_type = 'staff' AND owner_id = ${ownerId}
            GROUP BY status`,
      ),
      stRows(
        sql`SELECT i.id, i.purchase_id, i.amount, i.period, i.status, i.created_at,
                   p.pack_key, k.title
            FROM st_creator_income i
            LEFT JOIN st_pack_purchases p ON p.id = i.purchase_id
            LEFT JOIN st_skill_packs k ON k.pack_key = p.pack_key
            WHERE i.owner_type = 'staff' AND i.owner_id = ${ownerId}
            ORDER BY i.id DESC LIMIT 200`,
      ),
    ]);
    return {
      accruedTotal: Number(totals.find((t) => String(t.status) === "accrued")?.amount ?? 0),
      settledTotal: Number(totals.find((t) => String(t.status) === "settled")?.amount ?? 0),
      note: "金额单位为 Token（调用计量）；结算兑换通道未来开放",
      items: items.map((r) => ({
        id: Number(r.id),
        purchaseId: Number(r.purchase_id),
        packKey: r.pack_key == null ? null : String(r.pack_key),
        title: r.title == null ? null : String(r.title),
        amount: Number(r.amount),
        period: String(r.period),
        status: String(r.status),
        createdAt: toDate(r.created_at),
      })),
    };
  }),

  /** factoryIncome（wb 企业 token）：本厂台账聚合 */
  factoryIncome: publicQuery.input(tokenInput).query(async ({ input }) => {
    const actor = await requireFactoryToken(input.token);
    const [totals, items] = await Promise.all([
      stRows(
        sql`SELECT status, SUM(amount) AS amount, COUNT(*) AS entries
            FROM st_creator_income WHERE owner_type = 'factory' AND owner_id = ${actor.factoryId}
            GROUP BY status`,
      ),
      stRows(
        sql`SELECT i.id, i.purchase_id, i.amount, i.period, i.status, i.created_at,
                   p.pack_key, k.title
            FROM st_creator_income i
            LEFT JOIN st_pack_purchases p ON p.id = i.purchase_id
            LEFT JOIN st_skill_packs k ON k.pack_key = p.pack_key
            WHERE i.owner_type = 'factory' AND i.owner_id = ${actor.factoryId}
            ORDER BY i.id DESC LIMIT 200`,
      ),
    ]);
    return {
      accruedTotal: Number(totals.find((t) => String(t.status) === "accrued")?.amount ?? 0),
      settledTotal: Number(totals.find((t) => String(t.status) === "settled")?.amount ?? 0),
      note: "金额单位为 Token（调用计量）；结算兑换通道未来开放",
      items: items.map((r) => ({
        id: Number(r.id),
        purchaseId: Number(r.purchase_id),
        packKey: r.pack_key == null ? null : String(r.pack_key),
        title: r.title == null ? null : String(r.title),
        amount: Number(r.amount),
        period: String(r.period),
        status: String(r.status),
        createdAt: toDate(r.created_at),
      })),
    };
  }),
});
