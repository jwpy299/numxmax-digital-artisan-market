/**
 * packages —— 迭代 27「数字员工套餐售卖」服务端路由（契约 §1）。
 *
 * 表结构（db/sync-ops.mts 幂等创建，本文件一律 raw SQL 访问，不改 drizzle schema）：
 * - pkg_packages      套餐目录（key 唯一，features JSON）
 * - pkg_orders        订单（order_no 唯一；认领码库内只存 sha256(claim_hash)，
 *                     claim_code 明文列仅用于「凭手机号重复查回认领码」的契约要求）
 * - pkg_entitlements  企业套餐权益（claim 成功后写入，additive，不改 wb_factories）
 *
 * 约定：
 * - token 仅在请求体；管理接口 requireAdmin（wb_users.authToken + role='admin'，复用 terminal）；
 * - claim 需要工作台 session（sessionMe）；认领成功后组织配置由工作台前端调用
 *   既有 wbOrg.orgSmartSetup/orgAutoSetup 完成（前端职责，后端不做循环依赖）；
 * - adminSeed 幂等（INSERT ... ON DUPLICATE KEY UPDATE）。
 */
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { createHash } from "node:crypto";
import { screenText } from "./contentScreen"; // UGC 初筛共享面（portal 仓同件——M36 等保硬项[wb#97 high③ 同律]）
import { getDb } from "../queries/connection";
import { pickRecommendations, fallbackRecommend, toRecommendItem, buildAdvisorTask, catalogLiteText } from "@contracts/recommendAdvisor"; // 导购逻辑契约件（双仓同轨[SYNC_LOCK wb#98/portal 同改]——厚逻辑单源不双写）
import { rawRows, requireAdmin } from "./terminal";
import type { DeptCode } from "@contracts/deptCodes"; // 部门键契约单源（wb#79 复审票）
import { sessionMe, sha256 } from "./wbSession";
import { rateIpDigest } from "../lib/clientIp";

const tokenInput = z.object({ token: z.string().trim().min(1) });

// ─── 工具 ────────────────────────────────────────────────────────────────────
/** 认领码字符集：大写字母数字，去掉易混淆字符（0/O/1/I/L） */
const CLAIM_CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomGroup(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += CLAIM_CHARSET[bytes[i] % CLAIM_CHARSET.length];
  return out;
}

/** claimCode 形如 PKG-XXXXXX-XXXXXX */
function newClaimCode(): string {
  return `PKG-${randomGroup(6)}-${randomGroup(6)}`;
}

function newOrderNo(): string {
  return `PO${Date.now().toString(36).toUpperCase()}${randomBytes(3).toString("hex").toUpperCase()}`;
}

/** period_label → 月数（含3个月 / 含6个月 / 含1年），无法解析默认 3 个月 */
function periodMonths(periodLabel: string): number {
  const year = periodLabel.match(/(\d+)\s*年/);
  if (year) return parseInt(year[1], 10) * 12;
  const month = periodLabel.match(/(\d+)\s*个?月/);
  if (month) return parseInt(month[1], 10);
  return 3;
}

function addMonths(from: Date, months: number): Date {
  const d = new Date(from);
  d.setMonth(d.getMonth() + months);
  return d;
}

/** features 列兼容：mysql2 对 JSON 列可能返回对象或字符串 */
/** team_spec JSON 对象解析+形态验（与 parseFeatures 数组面分家——对象≠数组形态错配面封死；
 *  形态验钉（wb#79 复审 bug·med 票：{} 或 {members:null} 过闸=卡片 deref 炸面封死）——
 *  lead 对象[有 duty]+members 数组才放行，否则 null 兜底；NULL/坏串=null） */
function parseTeamSpec(raw: unknown): DeptTeamSpec | null {
  if (raw === null || raw === undefined) return null;
  const obj = typeof raw === "string" && raw.trim() ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null; // 数组面拒（team_spec 是对象面）
  const spec = obj as Partial<DeptTeamSpec>;
  // 形态验：lead 对象[有 duty 字符串]+members 数组才放行——坏形态=null（钩子/卡片不炸面）
  if (!spec.lead || typeof spec.lead !== "object" || typeof (spec.lead as { duty?: unknown }).duty !== "string") return null;
  if (!Array.isArray(spec.members)) return null;
  return spec as DeptTeamSpec;
}

function parseFeatures(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

interface PkgRow {
  id: number;
  key: string;
  name: string;
  price_yuan: number;
  period_label: string;
  agents_count: number;
  scope_label: string;
  synergy_label: string;
  monetize_label: string;
  scale_label: string;
  poster_url: string;
  dept_code: string | null; // 部门键（部门级订阅包面——2.1 加列；非部门包=NULL）
  package_tier: string | null; // 子包级（wb#81 同面搬链——门户体系页分区锚；portal#58 配套漏面修：不透=前端按 tier 分区全空）
  team_spec: unknown; // 团队规格 JSON（1 主管+N 专员——购买后自动组建军团的编制面；2.4 钩子消费）
  features: unknown;
  sort_order: number;
}

function toPackageDto(r: PkgRow) {
  return {
    id: Number(r.id),
    key: r.key,
    name: r.name,
    priceYuan: Number(r.price_yuan),
    periodLabel: r.period_label,
    agentsCount: Number(r.agents_count),
    scopeLabel: r.scope_label,
    synergyLabel: r.synergy_label,
    monetizeLabel: r.monetize_label,
    scaleLabel: r.scale_label,
    posterUrl: r.poster_url,
    deptCode: r.dept_code ?? null, // 部门键透出（部门包页按部门组织面——2.3 消费）
    packageTier: r.package_tier ?? null, // 子包级透出（wb#81 同面——门户只渲 tier 非空件[退役面]）
    teamSpec: parseTeamSpec(r.team_spec), // 团队规格透出（对象面单点 parseTeamSpec——与 features 数组面分家，钉教训面封死）
    features: parseFeatures(r.features),
    sortOrder: Number(r.sort_order),
  };
}

// ─── 五套餐种子数据（契约 §1 表格；features 含通用两项）─────────────────────
const COMMON_FEATURES = ["含数字匠市+智能工作台", "首批100家企业通道开放中"];

/** 部门包团队规格（彭总策略面：1 主管+N 专员——对齐 corps.ts CorpsMemberSpec 行业模板面） */
export interface DeptTeamSpec {
  lead: { role: "co"; deptKey: string; duty: string; skillHints: string[] }; // 部门主管（协调面）
  members: Array<{ role: "ex" | "va" | "ev"; deptKey: string; duty: string; skillHints: string[] }>; // 专员清单
}

const SEED_PACKAGES: Array<{
  key: string;
  name: string;
  priceYuan: number;
  periodLabel: string;
  agentsCount: number;
  scopeLabel: string;
  synergyLabel: string;
  monetizeLabel: string;
  scaleLabel: string;
  posterUrl: string;
  features: string[];
  sortOrder: number;
  deptCode?: DeptCode; // 部门键（部门级订阅包面——契约层单源直引[wb#79 复审票：型不绑=字面漂移面封死]；规模包缺省空=非部门包）
  packageTier?: string; // 子包级（旧种子件不带=NULL=非文档体系件语义面；文档体系种子=wb 侧 PKG_CATALOG 单源[portal 仓种子源切换挂账 P-PORTAL-SEED-SOURCE]）
  teamSpec?: DeptTeamSpec; // 团队规格（部门包带——购买后自动组建军团的编制面）
}> = [
  {
    key: "core_exp",
    name: "核心经验包",
    priceYuan: 5800,
    periodLabel: "含3个月",
    agentsCount: 1,
    scopeLabel: "单点经验",
    synergyLabel: "无",
    monetizeLabel: "无",
    scaleLabel: "10人以下团队",
    posterUrl: "/pkg/pkg-core.png",
    features: [
      "覆盖范围：单点经验",
      "协同能力：无",
      "对外变现：无",
      "适用规模：10人以下团队",
      "Token激活后签发",
      ...COMMON_FEATURES,
    ],
    sortOrder: 1,
  },
  {
    key: "key_posts",
    name: "关键岗位包",
    priceYuan: 9800,
    periodLabel: "含6个月",
    agentsCount: 4,
    scopeLabel: "关键岗位",
    synergyLabel: "岗位间协同",
    monetizeLabel: "无",
    scaleLabel: "10-50人团队",
    posterUrl: "/pkg/pkg-key.png",
    features: [
      "覆盖范围：关键岗位",
      "协同能力：岗位间协同",
      "对外变现：无",
      "适用规模：10-50人团队",
      "Token激活后签发",
      ...COMMON_FEATURES,
    ],
    sortOrder: 2,
  },
  {
    key: "dept_synergy",
    name: "主部门协同包",
    priceYuan: 13800,
    periodLabel: "含6个月",
    agentsCount: 5,
    scopeLabel: "全部门",
    synergyLabel: "部门间协同",
    monetizeLabel: "无",
    scaleLabel: "30-100人团队",
    posterUrl: "/pkg/pkg-dept.png",
    features: [
      "覆盖范围：全部门",
      "协同能力：部门间协同",
      "对外变现：无",
      "适用规模：30-100人团队",
      "Token激活后签发",
      ...COMMON_FEATURES,
    ],
    sortOrder: 3,
  },
  // ─── 部门级订阅包（彭总 2026-10-14 策略：单员工展示+部门包主调——买部门团队=1 主管+N 专员）─────
  {
    key: "dept_finance",
    name: "财务部团队订阅包",
    priceYuan: 19800,
    periodLabel: "含6个月",
    agentsCount: 4,
    scopeLabel: "财务部团队",
    synergyLabel: "主管统筹+专员协同",
    monetizeLabel: "无",
    scaleLabel: "财务全流程",
    posterUrl: "/pkg/pkg-dept-finance.png",
    features: [
      "覆盖范围：财务部团队（1 主管+3 专员）",
      "协同能力：主管统筹+专员协同",
      "对外变现：无",
      "适用规模：财务全流程",
      "Token激活后签发",
      "购买后自动组建军团（部门编制落户）",
      ...COMMON_FEATURES,
    ],
    sortOrder: 10,
    deptCode: "finance",
    teamSpec: {
      lead: { role: "co", deptKey: "finance", duty: "财务主管：团队统筹与质量终审", skillHints: ["财务统筹", "质量终审", "跨部门协同"] },
      members: [
        { role: "ex", deptKey: "finance", duty: "记账核算专员", skillHints: ["记账", "核算", "凭证"] },
        { role: "ex", deptKey: "finance", duty: "报税申报专员", skillHints: ["报税", "申报", "合规"] },
        { role: "va", deptKey: "finance", duty: "审单评估专员", skillHints: ["审单", "评估", "风控"] },
      ],
    },
  },
  {
    key: "dept_legal",
    name: "法务部团队订阅包",
    priceYuan: 22800,
    periodLabel: "含6个月",
    agentsCount: 3,
    scopeLabel: "法务部团队",
    synergyLabel: "主管统筹+专员协同",
    monetizeLabel: "无",
    scaleLabel: "法务全流程",
    posterUrl: "/pkg/pkg-dept-legal.png",
    features: [
      "覆盖范围：法务部团队（1 主管+2 专员）",
      "协同能力：主管统筹+专员协同",
      "对外变现：无",
      "适用规模：法务全流程",
      "Token激活后签发",
      "购买后自动组建军团（部门编制落户）",
      ...COMMON_FEATURES,
    ],
    sortOrder: 11,
    deptCode: "legal",
    teamSpec: {
      lead: { role: "co", deptKey: "legal", duty: "法务主管：团队统筹与合规终审", skillHints: ["法务统筹", "合规终审", "风险把控"] },
      members: [
        { role: "ex", deptKey: "legal", duty: "合同审查专员", skillHints: ["合同审查", "条款比对", "风险识别"] },
        { role: "ex", deptKey: "legal", duty: "法规检索专员", skillHints: ["法规检索", "案例比对", "合规咨询"] },
      ],
    },
  },
  {
    key: "dept_marketing",
    name: "市场部团队订阅包",
    priceYuan: 18800,
    periodLabel: "含6个月",
    agentsCount: 4,
    scopeLabel: "市场部团队",
    synergyLabel: "主管统筹+专员协同",
    monetizeLabel: "无",
    scaleLabel: "市场全流程",
    posterUrl: "/pkg/pkg-dept-marketing.png",
    features: [
      "覆盖范围：市场部团队（1 主管+3 专员）",
      "协同能力：主管统筹+专员协同",
      "对外变现：无",
      "适用规模：市场全流程",
      "Token激活后签发",
      "购买后自动组建军团（部门编制落户）",
      ...COMMON_FEATURES,
    ],
    sortOrder: 12,
    deptCode: "marketing",
    teamSpec: {
      lead: { role: "co", deptKey: "marketing", duty: "市场主管：团队统筹与品牌终审", skillHints: ["市场统筹", "品牌终审", "投放策略"] },
      members: [
        { role: "ex", deptKey: "marketing", duty: "内容文案专员", skillHints: ["文案", "内容策划", "种草"] },
        { role: "ex", deptKey: "marketing", duty: "投放运营专员", skillHints: ["投放", "运营", "数据分析"] },
        { role: "va", deptKey: "marketing", duty: "舆情监测专员", skillHints: ["舆情监测", "危机预警", "口碑"] },
      ],
    },
  },
];

// ─── 路由 ────────────────────────────────────────────────────────────────────
/** 导购顾问工位调用壳（portal 面——厚逻辑=契约件；本壳=fetch 调用 harness svc-advisor；token 复用 DSH_SERVICE_TOKEN 单点[wb#94 同律]） */
/** 导购超时单源（冷工位首答真时 10-25s——两帽同引[发散面封死]） */
export const ADVISOR_TIMEOUT_MS = 35_000; // 出口面（钉件同引）

export async function callAdvisorPoolPortal(need: string, visitorKey: string): Promise<{ pkgKey: string; reason: string }[] | null> {
  const base = (process.env.HARNESS_POOL_URL?.trim() || "http://127.0.0.1:18800").replace(/\/+$/, "");
  const token = process.env.DSH_SERVICE_TOKEN?.trim();
  if (!token) return null;
  try {
    const r = await fetch(`${base}/station/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        stationKey: `adv-${createHash("sha256").update(String(visitorKey || "anon")).digest("hex").slice(0, 16)}`, // 会话隔离派生键（wb#94/wb#97 同律——异客异会话不串味）
        task: buildAdvisorTask(need, catalogLiteText()), // 任务构建契约件单源
        timeoutSec: ADVISOR_TIMEOUT_MS / 1000, // 单源（NumX low-1：两处 35 只钉一处=发散面封死——常量单源）
      }),
      signal: AbortSignal.timeout(ADVISOR_TIMEOUT_MS),
    });
    const j = await r.json().catch(() => null) as { ok?: boolean; answer?: string; guarded?: boolean } | null;
    if (j?.guarded || !j?.ok || typeof j.answer !== "string") return null;
    const m = /\[[\s\S]*\]/.exec(j.answer);
    if (!m) return null;
    const arr = JSON.parse(m[0]) as unknown[];
    if (!Array.isArray(arr)) return null;
    const out: { pkgKey: string; reason: string }[] = [];
    for (const it of arr.slice(0, 3)) {
      const pkgKey = String((it as { pkgKey?: unknown })?.pkgKey ?? "").trim().slice(0, 40);
      const reason = String((it as { reason?: unknown })?.reason ?? "").trim().slice(0, 80);
      if (pkgKey) out.push({ pkgKey, reason: reason || "导购顾问匹配" });
    }
    return out.length ? out : null;
  } catch { return null; }
}

/** 导购限流桶（st_qr_rate 同表同款——wb bumpQrRate 的原子判+计一体语义同轨[数据面同轨=同库同表同桶；代码面 portal 薄壳]） */
async function bumpRecommendRate(ip: string, bucket: string): Promise<number> {
  const db = getDb();
  const rateKey = `rec-portal:${rateIpDigest(ip).slice(0, 32)}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`INSERT INTO st_qr_rate (ip, bucket_min, n) VALUES (${rateKey}, ${bucket}, 1) ON DUPLICATE KEY UPDATE n = n + 1`);
    const [rows] = (await tx.execute(sql`SELECT n FROM st_qr_rate WHERE ip=${rateKey} AND bucket_min=${bucket} LIMIT 1`)) as unknown as [Record<string, unknown>[]];
    return Number((rows as Record<string, unknown>[])[0]?.n ?? 0);
  });
}

/** 转化漏斗留痕（nh_recommend_queries 同库同表=wb 端点同账；fire-and-forget 不挡推荐） */
async function logRecommendQueryPortal(need: string, pkgKeys: string[], source: string): Promise<void> {
  try {
    const db = getDb();
    await db.execute(sql`INSERT INTO nh_recommend_queries (need, pkg_keys, source) VALUES (${need.slice(0, 200)}, ${pkgKeys.join(",").slice(0, 255)}, ${`portal-${source}`})`);
  } catch { /* 留痕故障不挡推荐 */ }
}

export const packagesRouter = createRouter({
  /** 导购顾问（③A 端面——门户公网访客面：客户说痛点→导购专员推荐部门包）：
   *  会话隔离工位键派生（wb#97 同律）+幻觉键拒（契约件纯函数）+关键词兜底（契约件）+**screenText UGC 初筛**（wb#97 high③ 同律——命中转人工不直连导购）+**IP 限流**（st_qr_rate 同表同款——匿名刷算力封死[wb#97 high① 同律]）+留痕 nh_recommend_queries（同库同表=转化漏斗同账）。 */
  recommendByNeed: publicQuery
    .input(z.object({
      need: z.string().trim().min(2).max(500),
      sessionId: z.string().trim().max(64).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // ① UGC 初筛先行（等保硬项——命中转人工不直连导购）
      const screen = screenText(input.need);
      if (!screen.ok) return { ok: false as const, error: "screened", message: screen.reason };
      // ② IP 限流（st_qr_rate 同表同款——匿名刷算力封死；每小时 10 次）
      const ip = ctx.clientIp ?? "";
      if (!ip) return { ok: false as const, error: "ip_unavailable", message: "请求来源不可识别——请检查网络后重试；持续失败请联系运维" };
      const ua = (ctx as { req?: { headers?: Headers } })?.req?.headers?.get?.("user-agent") ?? "";
      const hourBucket = new Date().toISOString().slice(0, 13);
      const rateN = await bumpRecommendRate(ip, hourBucket).catch(() => 0);
      if (rateN > 10) return { ok: false as const, error: "rate_limited", message: "导购咨询每 IP 每小时限 10 次——稍后或先逛逛套餐矩阵。" };
      // ③ 访客键收敛（high③：sessionId 混入 ip|ua——伪造 sessionId 逃不出 IP+UA 面=派生键仍按访客网络面收敛）
      const visitorKey = `${ip}|${ua}|${input.sessionId ?? ""}`;
      // ④ 导购顾问工位（fail-soft 兜底）
      const advisorAns = await callAdvisorPoolPortal(input.need, visitorKey).catch(() => null);
      const valid = pickRecommendations(advisorAns);
      if (valid) {
        void logRecommendQueryPortal(input.need, valid.map((v) => v.pkgKey), "advisor").catch(() => false);
        return { ok: true as const, source: "advisor" as const, items: valid.map((v) => toRecommendItem(v)).filter((x) => x !== null) }; // null 过滤面（find! 摘除后——清单外键不落透出[P-ADVISOR-TYPE]）
      }
      const fb = fallbackRecommend(input.need);
      void logRecommendQueryPortal(input.need, fb.map((f) => f.key), "fallback").catch(() => false);
      return { ok: true as const, source: "fallback" as const, items: fb.map((p) => toRecommendItem({ pkgKey: p.key, reason: "按你的描述关键词匹配（智能导购暂忙——标准匹配面）" })).filter((x) => x !== null) };
    }),

  /** list（public query）：全部套餐，按 sortOrder 升序 */
  list: publicQuery.query(async () => {
    const rows = rawRows(
      await getDb().execute(sql`SELECT * FROM pkg_packages ORDER BY sort_order ASC, id ASC`),
    ) as unknown as PkgRow[];
    return rows.map(toPackageDto);
  }),

  /**
   * createOrder（public mutation）：创建待支付订单并签发认领码。
   * 认领码明文只在本响应与 orderStatus（凭手机号回查）出现，库内 claim_hash 仅存 sha256。
   */
  createOrder: publicQuery
    .input(
      z.object({
        packageId: z.number().int().positive(),
        buyerName: z.string().trim().min(1).max(64),
        buyerPhone: z.string().trim().regex(/^1[3-9]\d{9}$/, "手机号格式不正确"),
        companyName: z.string().trim().min(1).max(128),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const pkgs = rawRows(
        await db.execute(sql`SELECT * FROM pkg_packages WHERE id = ${input.packageId} LIMIT 1`),
      ) as unknown as PkgRow[];
      const pkg = pkgs[0];
      if (!pkg) {
        throw new TRPCError({ code: "NOT_FOUND", message: "套餐不存在" });
      }
      const orderNo = newOrderNo();
      const claimCode = newClaimCode();
      await db.execute(
        sql`INSERT INTO pkg_orders
            (order_no, package_id, buyer_name, buyer_phone, company_name, amount_yuan, claim_hash, claim_code, status)
            VALUES (${orderNo}, ${pkg.id}, ${input.buyerName}, ${input.buyerPhone}, ${input.companyName},
                    ${Number(pkg.price_yuan)}, ${sha256(claimCode)}, ${claimCode}, 'pending')`,
      );
      const inserted = rawRows(
        await db.execute(sql`SELECT id FROM pkg_orders WHERE order_no = ${orderNo} LIMIT 1`),
      );
      return {
        orderId: Number(inserted[0]?.id ?? 0),
        orderNo,
        claimCode,
        amountYuan: Number(pkg.price_yuan),
        status: "pending" as const,
      };
    }),

  /** orderStatus（public query）：凭订单号+手机号查回订单与认领码 */
  orderStatus: publicQuery
    .input(
      z.object({
        orderNo: z.string().trim().min(1).max(40),
        buyerPhone: z.string().trim().min(1).max(20),
      }),
    )
    .query(async ({ input }) => {
      const rows = rawRows(
        await getDb().execute(
          sql`SELECT o.order_no, o.status, o.amount_yuan, o.claim_code, o.factory_id, p.name AS package_name
              FROM pkg_orders o JOIN pkg_packages p ON p.id = o.package_id
              WHERE o.order_no = ${input.orderNo} AND o.buyer_phone = ${input.buyerPhone} LIMIT 1`,
        ),
      );
      const row = rows[0];
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "订单不存在或手机号不匹配" });
      }
      const factoryId = row.factory_id === null || row.factory_id === undefined ? null : Number(row.factory_id);
      return {
        orderNo: String(row.order_no),
        status: String(row.status),
        packageName: String(row.package_name),
        amountYuan: Number(row.amount_yuan),
        claimCode: String(row.claim_code ?? ""),
        ...(factoryId ? { configuredFactoryId: factoryId } : {}),
      };
    }),

  /**
   * claim（mutation，需要工作台 session）：认领订单到本企业。
   * 幂等：已 configured 且属本企业 → 直接返回 ok；属他人 → 报错。
   * 认领后仅写 pkg_entitlements + 订单状态（additive，不改 wb_factories 结构）；
   * 组织配置由工作台前端在认领成功后调用既有 wbOrg.orgSmartSetup/orgAutoSetup 完成。
   */
  claim: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        claimCode: z.string().trim().min(1).max(32),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { factory } = await sessionMe(input.token);
      const hash = sha256(input.claimCode.trim().toUpperCase());
      const rows = rawRows(
        await db.execute(
          sql`SELECT o.*, p.key AS package_key, p.name AS package_name, p.agents_count AS pkg_agents, p.period_label AS pkg_period, p.dept_code AS pkg_dept_code, p.team_spec AS pkg_team_spec
              FROM pkg_orders o JOIN pkg_packages p ON p.id = o.package_id
              WHERE o.claim_hash = ${hash} LIMIT 1`,
        ),
      );
      const order = rows[0];
      if (!order) {
        throw new TRPCError({ code: "NOT_FOUND", message: "认领码无效" });
      }
      const status = String(order.status);
      const orderFactory = order.factory_id === null || order.factory_id === undefined ? null : Number(order.factory_id);
      if (status === "configured") {
        if (orderFactory === factory.id) {
          return {
            ok: true as const,
            orderNo: String(order.order_no),
            packageName: String(order.package_name),
            agentsCount: Number(order.pkg_agents),
            configured: true as const,
          };
        }
        throw new TRPCError({ code: "BAD_REQUEST", message: "该认领码已被使用" });
      }
      if (status !== "pending" && status !== "paid") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "订单已取消，无法认领" });
      }
      const expiresAt = addMonths(new Date(), periodMonths(String(order.pkg_period)));
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE pkg_orders
              SET status = 'configured', factory_id = ${factory.id}, configured_at = NOW()
              WHERE id = ${order.id} AND status IN ('pending','paid')`,
        );
        await tx.execute(
          sql`INSERT INTO pkg_entitlements (factory_id, package_key, agents_count, period_label, expires_at)
              VALUES (${factory.id}, ${String(order.package_key)}, ${Number(order.pkg_agents)},
                      ${String(order.pkg_period)}, ${expiresAt})`,
        );
      });
      // 战区② 2.4 钩子：部门包（teamSpec 非空）→ 购买后自动组建部门军团（异步不阻塞认领主链——
      // 与 P1 落户同律[败=记日志不致命]；彭总策略闭环：买部门团队=1 主管+N 专员自动落户上岗）
      const pkgTeamSpec = parseTeamSpec(order.pkg_team_spec);
      if (pkgTeamSpec) {
        const deptName = String(order.pkg_dept_code ?? "");
        void import("./corps")
          .then((m) => m.formCorpsForFactory({
            factoryId: factory.id,
            name: String(order.package_name),
            industry: deptName || "通用",
            actor: `pkg-claim:${String(order.order_no)}`,
            teamSpec: pkgTeamSpec,
          }))
          .catch((e) => console.warn("[packages] 部门包组建军团失败（认领主链已闭环——组建面异步重试面封死）", { orderNo: order.order_no, err: String(e) }));
      }
      return {
        ok: true as const,
        orderNo: String(order.order_no),
        packageName: String(order.package_name),
        agentsCount: Number(order.pkg_agents),
        configured: true as const,
      };
    }),

  /** myEntitlement（query，需要工作台 session）：本企业最新套餐权益（工作台前端显示用） */
  myEntitlement: publicQuery.input(tokenInput).query(async ({ input }) => {
    const { factory } = await sessionMe(input.token);
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT e.package_key, e.agents_count, e.expires_at, p.name AS package_name
            FROM pkg_entitlements e LEFT JOIN pkg_packages p ON p.\`key\` = e.package_key
            WHERE e.factory_id = ${factory.id}
            ORDER BY e.id DESC LIMIT 1`,
      ),
    );
    const row = rows[0];
    if (!row) return null;
    return {
      packageKey: String(row.package_key),
      packageName: row.package_name ? String(row.package_name) : String(row.package_key),
      agentsCount: Number(row.agents_count),
      expiresAt: row.expires_at ? new Date(String(row.expires_at)) : null,
    };
  }),

  /** adminList（query，requireAdmin）：全订单（含企业名、状态、时间） */
  adminList: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT o.id, o.order_no, o.buyer_name, o.buyer_phone, o.company_name, o.amount_yuan,
                   o.status, o.factory_id, o.created_at, o.paid_at, o.configured_at,
                   p.name AS package_name, p.\`key\` AS package_key
            FROM pkg_orders o JOIN pkg_packages p ON p.id = o.package_id
            ORDER BY o.id DESC LIMIT 500`,
      ),
    );
    return rows.map((r) => ({
      id: Number(r.id),
      orderNo: String(r.order_no),
      buyerName: String(r.buyer_name),
      buyerPhone: String(r.buyer_phone),
      companyName: String(r.company_name),
      amountYuan: Number(r.amount_yuan),
      status: String(r.status),
      packageName: String(r.package_name),
      packageKey: String(r.package_key),
      factoryId: r.factory_id === null || r.factory_id === undefined ? null : Number(r.factory_id),
      createdAt: r.created_at ? new Date(String(r.created_at)) : null,
      paidAt: r.paid_at ? new Date(String(r.paid_at)) : null,
      configuredAt: r.configured_at ? new Date(String(r.configured_at)) : null,
    }));
  }),

  /** adminSetStatus（mutation，requireAdmin）：人工调整订单状态 */
  adminSetStatus: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        orderNo: z.string().trim().min(1).max(40),
        status: z.enum(["paid", "pending", "cancelled"]),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      const rows = rawRows(
        await db.execute(sql`SELECT id, status FROM pkg_orders WHERE order_no = ${input.orderNo} LIMIT 1`),
      );
      if (!rows[0]) {
        throw new TRPCError({ code: "NOT_FOUND", message: "订单不存在" });
      }
      if (String(rows[0].status) === "configured") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "订单已完成配置，不可再调整状态" });
      }
      await db.execute(
        sql`UPDATE pkg_orders
            SET status = ${input.status}, paid_at = IF(${input.status} = 'paid', NOW(), paid_at)
            WHERE id = ${rows[0].id}`,
      );
      return { ok: true as const };
    }),

  /** adminSeed（mutation，requireAdmin）：幂等 seed 五套餐 */
  adminSeed: publicQuery.input(tokenInput).mutation(async ({ input }) => {
    await requireAdmin(input.token);
    const db = getDb();
    for (const p of SEED_PACKAGES) {
      const features = JSON.stringify(p.features);
      const teamSpec = p.teamSpec ? JSON.stringify(p.teamSpec) : null; // 部门包团队规格（幻影不养钉：列有真消费面=种子写入+list 读出）
      await db.execute(
        sql`INSERT INTO pkg_packages
            (\`key\`, name, price_yuan, period_label, agents_count, scope_label, synergy_label,
             monetize_label, scale_label, poster_url, dept_code, package_tier, team_spec, features, sort_order)
            VALUES (${p.key}, ${p.name}, ${p.priceYuan}, ${p.periodLabel}, ${p.agentsCount},
                    ${p.scopeLabel}, ${p.synergyLabel}, ${p.monetizeLabel}, ${p.scaleLabel},
                    ${p.posterUrl}, ${p.deptCode ?? null}, ${p.packageTier ?? null}, ${teamSpec}, ${features}, ${p.sortOrder})
            ON DUPLICATE KEY UPDATE
              name = VALUES(name), price_yuan = VALUES(price_yuan), period_label = VALUES(period_label),
              agents_count = VALUES(agents_count), scope_label = VALUES(scope_label),
              synergy_label = VALUES(synergy_label), monetize_label = VALUES(monetize_label),
              scale_label = VALUES(scale_label), poster_url = VALUES(poster_url),
              dept_code = VALUES(dept_code), package_tier = VALUES(package_tier), team_spec = VALUES(team_spec),
              features = VALUES(features), sort_order = VALUES(sort_order)`,
      );
    }
    return { ok: true as const, count: SEED_PACKAGES.length };
  }),
});
