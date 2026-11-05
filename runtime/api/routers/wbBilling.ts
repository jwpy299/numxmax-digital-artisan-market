/**
 * wbBilling —— 迭代 34「Token 充值入口」服务端路由（API-CONTRACT-v10 §2）。
 *
 * - topupRequest({amount})   企业主提交充值申请（档位 100/500/2000/5000 或自定义 ≥100，
 *                            status=pending，不即时到账，人工确认后入账）
 * - topupList()              本企业充值记录（倒序）
 * - billingConfirm({topupId})        admin 确认：给企业钱包真实入账 + st_admin_audit + 工单联动
 * - billingReject({topupId, reason}) admin 驳回：不加余额 + st_admin_audit + 工单联动
 *
 * 表：st_token_topups（db/sync-ops.mts 幂等创建，raw SQL 访问，不改 drizzle schema）。
 *
 * 鉴权：
 * - 充值申请/记录仅企业主（wb_users.role==='owner'），普通员工/管理员以外的角色 FORBIDDEN；
 * - 确认/驳回/处理队列走 requireHqAdmin（验收战役 P1 修复：充值确认是平台侧收款确认，
 *   必须本厂闸 fail-closed，杜绝他厂 admin 跨厂探知/确认充值单的财务越权）；
 * - token 仅在请求体，明文绝不落日志（审计 detail 只含 id/金额/状态，不含 token）。
 *
 * 入账路径（复用既有 Token 余额机制）：企业钱包 = enterprises.tokenBalance
 * （db/schema.ts 既有字段；enterpriseId 与 wb_factories.id 按 factoryHealth 既有口径对齐），
 * 确认时 UPSERT 累加（INSERT ... ON DUPLICATE KEY UPDATE tokenBalance = tokenBalance + amount，
 * 幂等由 status 前置校验 pending 保证，重复确认直接 BAD_REQUEST）。
 *
 * 定价口径：price_cny 为应付金额快照，按平台公示计量标准 1 Token = 1 元（整数），
 * 申请时落库固化，后续调价不影响已提交申请（参照 packages.ts price_yuan 快照模式）。
 *
 * 文案合规：Token 为平台内结算点数，结算兑换通道未来开放；不接真实支付网关，
 * 线下/人工确认；禁止炒作/投机/金融化词汇。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows, requireHqAdmin } from "./terminal";
import { writeAdminAudit, adminDisplayName } from "./adminAnalytics";
import { creditPersona } from "./tokenLedger";
import { getFactoryTokenBalance } from "./tokenLedger";
import { normalizeRole, resolveWbUserByToken } from "./wbSession";

const tokenInput = z.object({ token: z.string().trim().min(1) });

/** 合规说明文案（所有充值相关响应必带） */
export const TOPUP_NOTICE =
  "Token 为平台内结算点数，结算兑换通道未来开放；充值申请提交后由平台人工确认，确认前不计入企业余额。";

/** 公示计量标准快照：1 Token = 1 元（整数，申请时固化 price_cny） */
const TOKEN_UNIT_CNY = 1;

/** 推荐档位（自定义 ≥100 亦可） */
const TOPUP_TIERS = [100, 500, 2000, 5000] as const;

/** 查询兜底：表缺失按空集降级（seed/迁移窗口） */
async function rows(statement: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  try {
    return rawRows(await getDb().execute(statement));
  } catch {
    return [];
  }
}

const toDate = (v: unknown) => (v ? new Date(String(v)) : null);

/** 企业主鉴权：wb token → role==='owner'，其余一律 FORBIDDEN */
async function requireOwnerToken(token: string) {
  const user = await resolveWbUserByToken(getDb(), token); // P3-6 双轨单点同引
  if (!user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "需要企业工作台账号权限" });
  }
  // M16 归一兼容：新写入一律 admin，存量 owner 读侧归一为 admin（此前只认 owner，
  // 导致新规企业主无法充值/查余额——2026-08-13 M34 连带修复）
  if (normalizeRole(user.role) !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "仅企业主可发起 Token 充值" });
  }
  return { userId: Number(user.id), username: String(user.username ?? "owner"), factoryId: Number(user.factoryId) };
}

/** 批次B工单联动（尽力而为 try/catch，绝不阻断主流程）：建单即结单 */
async function linkTicket(factoryId: number, topupId: number, title: string, note: string): Promise<void> {
  try {
    await getDb().execute(
      sql`INSERT INTO st_ops_tickets (source, factory_id, ref_id, title, status, note, closed_at)
          VALUES ('manual', ${factoryId}, ${topupId}, ${title}, 'done', ${note}, NOW())`,
    );
  } catch {
    // 静默：工单表未建/写入失败不影响充值确认主流程
  }
}

export const wbBillingRouter = createRouter({
  /** topupRequest：企业主提交充值申请（pending，不到账） */
  topupRequest: publicQuery
    .input(
      tokenInput.extend({
        amount: z.number().int().min(100, "充值金额至少 100 Token").max(1_000_000),
        remark: z.string().trim().max(255).optional(),
        proof: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const actor = await requireOwnerToken(input.token);
      const priceCny = input.amount * TOKEN_UNIT_CNY;
      const res = (await getDb().execute(
        sql`INSERT INTO st_token_topups (factory_id, amount, price_cny, status, remark, proof)
            VALUES (${actor.factoryId}, ${input.amount}, ${priceCny}, 'pending',
                    ${input.remark ?? ""}, ${input.proof ?? null})`,
      )) as unknown;
      const header = Array.isArray(res) ? (res[0] as { insertId?: number }) : {};
      let topupId = Number(header?.insertId ?? 0);
      if (!topupId) {
        const back = await rows(
          sql`SELECT id FROM st_token_topups WHERE factory_id = ${actor.factoryId}
              ORDER BY id DESC LIMIT 1`,
        );
        topupId = Number(back?.[0]?.id ?? 0);
      }
      return {
        ok: true as const,
        topupId,
        amount: input.amount,
        priceCny,
        status: "pending" as const,
        tiers: TOPUP_TIERS,
        priceNote: `应付金额快照：${input.amount} Token = ¥${priceCny}（平台公示计量标准 1 Token = 1 元，申请时固化）`,
        notice: TOPUP_NOTICE,
      };
    }),

  /** balance（query）：本企业 Token 钱包余额（M34 闭环读数；enterprises.tokenBalance 单一事实源） */
  balance: publicQuery.input(tokenInput).query(async ({ input }) => {
    const actor = await requireOwnerToken(input.token);
    const balance = await getFactoryTokenBalance(actor.factoryId);
    return { factoryId: actor.factoryId, balance, notice: TOPUP_NOTICE };
  }),

  /**
   * costBreakdown（query）：M43 分厂成本看板——本企业近 7 日技能调用成本
   * （st_skill_calls 按日 × 技能双维聚合，单位 Token；定价决策的真实数据源，绝不拍脑袋）。
   */
  costBreakdown: publicQuery.input(tokenInput).query(async ({ input }) => {
    const actor = await requireOwnerToken(input.token);
    const byDay = await rows(
      sql`SELECT DATE(created_at) AS day, COUNT(*) AS calls, SUM(price) AS tokens
          FROM st_skill_calls WHERE factory_id = ${actor.factoryId} AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
          GROUP BY DATE(created_at) ORDER BY day ASC`,
    );
    const bySkill = await rows(
      sql`SELECT skill_name AS skillName, COUNT(*) AS calls, SUM(price) AS tokens
          FROM st_skill_calls WHERE factory_id = ${actor.factoryId} AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
          GROUP BY skill_name ORDER BY tokens DESC LIMIT 12`,
    );
    const totalTokens = (byDay as Array<Record<string, unknown>>).reduce((a, r) => a + Number(r.tokens ?? 0), 0);
    const totalCalls = (byDay as Array<Record<string, unknown>>).reduce((a, r) => a + Number(r.calls ?? 0), 0);
    return {
      factoryId: actor.factoryId,
      days: (byDay as Array<Record<string, unknown>>).map((r) => ({
        day: String(r.day).slice(0, 10),
        calls: Number(r.calls),
        tokens: Number(r.tokens),
      })),
      skills: (bySkill as Array<Record<string, unknown>>).map((r) => ({
        skillName: String(r.skillName),
        calls: Number(r.calls),
        tokens: Number(r.tokens),
      })),
      total7d: { calls: totalCalls, tokens: totalTokens, avgTokensPerDay: Math.round((totalTokens / 7) * 10) / 10 },
    };
  }),

  /** topupList：本企业充值记录（倒序） */
  topupList: publicQuery.input(tokenInput).query(async ({ input }) => {
    const actor = await requireOwnerToken(input.token);
    const list = await rows(
      sql`SELECT id, amount, price_cny, status, remark, proof,
                 confirmed_by, confirmed_at, created_at
          FROM st_token_topups WHERE factory_id = ${actor.factoryId}
          ORDER BY id DESC LIMIT 200`,
    );
    return {
      tiers: TOPUP_TIERS,
      notice: TOPUP_NOTICE,
      priceNote: "平台公示计量标准 1 Token = 1 元，price_cny 为申请时应付金额快照",
      items: list.map((r) => ({
        id: Number(r.id),
        amount: Number(r.amount),
        priceCny: Number(r.price_cny),
        status: String(r.status),
        remark: String(r.remark ?? ""),
        proof: r.proof == null ? null : String(r.proof),
        confirmedBy: r.confirmed_by == null ? null : String(r.confirmed_by),
        confirmedAt: toDate(r.confirmed_at),
        createdAt: toDate(r.created_at),
      })),
    };
  }),

  /** billingList：admin 处理队列（默认 pending） */
  billingList: publicQuery
    .input(
      tokenInput.extend({
        status: z.enum(["pending", "confirmed", "rejected"]).optional(),
      }),
    )
    .query(async ({ input }) => {
      await requireHqAdmin(input.token);
      const status = input.status ?? "pending";
      const list = await rows(
        sql`SELECT t.id, t.factory_id, f.enterpriseName, t.amount, t.price_cny, t.status,
                   t.remark, t.proof, t.confirmed_by, t.confirmed_at, t.created_at
            FROM st_token_topups t
            LEFT JOIN wb_factories f ON f.id = t.factory_id
            WHERE t.status = ${status}
            ORDER BY t.id DESC LIMIT 200`,
      );
      return {
        notice: TOPUP_NOTICE,
        items: list.map((r) => ({
          id: Number(r.id),
          factoryId: Number(r.factory_id),
          enterpriseName: r.enterpriseName == null ? null : String(r.enterpriseName),
          amount: Number(r.amount),
          priceCny: Number(r.price_cny),
          status: String(r.status),
          remark: String(r.remark ?? ""),
          proof: r.proof == null ? null : String(r.proof),
          confirmedBy: r.confirmed_by == null ? null : String(r.confirmed_by),
          confirmedAt: toDate(r.confirmed_at),
          createdAt: toDate(r.created_at),
        })),
      };
    }),

  /** billingConfirm：admin 确认 → 企业钱包真实入账 + st_admin_audit + 工单联动（核心逻辑见 confirmTopup 共享 helper） */
  billingConfirm: publicQuery
    .input(tokenInput.extend({ topupId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const admin = await requireHqAdmin(input.token);
      return confirmTopup(input.topupId, admin);
    }),

  /** billingReject：admin 驳回 → 不加余额 + 审计 + 工单联动（核心逻辑见 rejectTopup 共享 helper） */
  billingReject: publicQuery
    .input(
      tokenInput.extend({
        topupId: z.number().int().positive(),
        reason: z.string().trim().min(1).max(255),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireHqAdmin(input.token);
      return rejectTopup(input.topupId, input.reason, admin);
    }),

});

// ─── 共享 helper（审批中心复用，行为与原端点一致）─────────────────────────────

type AdminLike = { id: unknown; username: unknown };

/** confirmTopup：pending → 企业钱包入账 + 审计 + 工单联动 */
export async function confirmTopup(topupId: number, admin: AdminLike) {
  const name = adminDisplayName(admin as never);
  const db = getDb();
  const found = await rows(
    sql`SELECT id, factory_id, amount, price_cny, status FROM st_token_topups
        WHERE id = ${topupId} LIMIT 1`,
  );
  const topup = found[0];
  if (!topup) throw new TRPCError({ code: "NOT_FOUND", message: "充值申请不存在" });
  if (String(topup.status) !== "pending") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "该申请已处理，不可重复操作" });
  }
  const factoryId = Number(topup.factory_id);
  const amount = Number(topup.amount);
  const factories = await rows(
    sql`SELECT enterpriseName, industry FROM wb_factories WHERE id = ${factoryId} LIMIT 1`,
  );
  const factoryName = String(factories[0]?.enterpriseName ?? `企业#${factoryId}`);
  const industry = String(factories[0]?.industry ?? "工业制造");
  await db.execute(
    sql`INSERT INTO enterprises (id, name, industry, tokenBalance)
        VALUES (${factoryId}, ${factoryName}, ${industry}, ${amount})
        ON DUPLICATE KEY UPDATE tokenBalance = tokenBalance + ${amount}`,
  );
  // M55 词元经济：充值确认即数字人分润（灵枢/星云各 2.5%，平台让利；流水留痕）
  // —— 失败不阻断充值主链（分润是增强，不是门槛）
  try {
    const share = Math.floor(amount * 0.025);
    if (share > 0) {
      await creditPersona({ persona: "lingshu", amount: share, bizType: "topup_share", refId: `topup:${topupId}`, note: `充值分润·${factoryName}` });
      await creditPersona({ persona: "xingyun", amount: share, bizType: "topup_share", refId: `topup:${topupId}`, note: `充值分润·${factoryName}` });
    }
  } catch {
    /* 分润失败不阻断 */
  }
  await db.execute(
    sql`UPDATE st_token_topups
        SET status = 'confirmed', confirmed_by = ${name}, confirmed_at = NOW()
        WHERE id = ${topupId} AND status = 'pending'`,
  );
  writeAdminAudit(Number(admin.id), name, "wbBilling.confirm", String(topupId), {
    factoryId,
    amount,
    priceCny: Number(topup.price_cny),
  });
  await linkTicket(
    factoryId,
    topupId,
    `充值确认：${factoryName} 充值 ${amount} Token 已入账`,
    `topupId=${topupId}; amount=${amount}; priceCny=${Number(topup.price_cny)}; confirmedBy=${name}`,
  );
  return { ok: true as const, topupId, status: "confirmed" as const, amount, notice: TOPUP_NOTICE };
}

/** rejectTopup：pending → rejected（不加余额）+ 审计 + 工单联动 */
export async function rejectTopup(topupId: number, reason: string, admin: AdminLike) {
  const name = adminDisplayName(admin as never);
  const db = getDb();
  const found = await rows(
    sql`SELECT id, factory_id, amount, status, remark FROM st_token_topups
        WHERE id = ${topupId} LIMIT 1`,
  );
  const topup = found[0];
  if (!topup) throw new TRPCError({ code: "NOT_FOUND", message: "充值申请不存在" });
  if (String(topup.status) !== "pending") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "该申请已处理，不可重复操作" });
  }
  const factoryId = Number(topup.factory_id);
  const prevRemark = String(topup.remark ?? "");
  const mergedRemark = (prevRemark ? `${prevRemark}；` : "") + `驳回原因：${reason}`;
  await db.execute(
    sql`UPDATE st_token_topups
        SET status = 'rejected', confirmed_by = ${name}, confirmed_at = NOW(),
            remark = ${mergedRemark.slice(0, 255)}
        WHERE id = ${topupId} AND status = 'pending'`,
  );
  writeAdminAudit(Number(admin.id), name, "wbBilling.reject", String(topupId), {
    factoryId,
    amount: Number(topup.amount),
    reason,
  });
  await linkTicket(
    factoryId,
    topupId,
    `充值确认：企业#${factoryId} 充值申请已驳回`,
    `topupId=${topupId}; amount=${Number(topup.amount)}; reason=${reason}; rejectedBy=${name}`,
  );
  return { ok: true as const, topupId, status: "rejected" as const, reason, notice: TOPUP_NOTICE };
}
