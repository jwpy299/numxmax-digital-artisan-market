/**
 * walletPay —— M45 Agent 支付闭环：供给侧钱包 + 提现管线 + 流水台账。
 *
 * 闭环全貌（本里程碑补全的链路）：
 *   人类充值（wbBilling，已有）→ 企业钱包（enterprises.tokenBalance，原子扣费 M34）
 *   → 雇佣/购买真扣（hire.create 本里程碑补扣；skillShop 补流水）
 *   → 供给侧大师钱包真实入账 85%（masters.tokenBalance + st_wallet_flows 台账）
 *   → 提现管线（st_withdrawals：企业兑回/供给侧结算；pending→approved→paid/rejected，
 *     渠道 ecny 数字人民币/bank 银行卡/ewallet 数字钱包；凭证留痕，admin 双人复核）
 *
 * 安全纪律：
 * - 提现申请：本人钱包 + 原子预冻结语义（approved 时才真扣，pending 不冻；驳回零成本）；
 *   驳回/审批/付款全程审计（writeAdminAudit）；
 * - 账号只存脱敏尾号（accountMasked，前 3 后 4，其余打码）；
 * - 真实出金通道（数字人民币/银行卡清算）需支付牌照/商户号——挂债，本路由是合规管线骨架；
 * - 金额下限 100 Token（防碎单骚扰），平台侧审批全走 requireAdmin。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows, requireAdmin } from "./terminal";
import { sessionMe } from "./wbSession";
import { getFactoryTokenBalance, writeFlow, getUserTokenBalance, creditUser, getPersonaTokenBalance } from "./tokenLedger";
import { writeAdminAudit, adminDisplayName } from "./adminAnalytics";
import { AGENT_TASK_ESCROW_RESERVE_BIZ_TYPE } from "./walletFlow";

const MIN_WITHDRAW = 100;

/** 账号脱敏：只留前 3 后 4，中间打码 */
export function maskAccount(raw: string): string {
  const s = String(raw ?? "").replace(/\s+/g, "");
  if (s.length <= 7) return `${s.slice(0, 2)}***`;
  return `${s.slice(0, 3)}${"*".repeat(Math.min(s.length - 7, 12))}${s.slice(-4)}`;
}

export const walletPayRouter = createRouter({
  /** myWalletFlows（query）：本企业钱包流水（进出全量，倒序 100 条） */
  myWalletFlows: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const rows = rawRows(
        await getDb().execute(
          sql`SELECT id, direction, amount, balance_after AS balanceAfter, biz_type AS bizType, ref_id AS refId, note, created_at AS createdAt
              FROM st_wallet_flows WHERE owner_type = 'enterprise' AND owner_id = ${factory.id}
              ORDER BY id DESC LIMIT 100`,
        ).catch(() => [[]]),
      );
      const balance = await getFactoryTokenBalance(factory.id);
      return { balance, flows: rows };
    }),

  /** withdrawRequest（mutation）：企业主申请 Token 兑回（pending，平台复核后付） */
  withdrawRequest: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        amount: z.number().int().min(MIN_WITHDRAW),
        channel: z.enum(["ecny", "bank", "ewallet"]),
        account: z.string().trim().min(4).max(128),
      }),
    )
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      if (user.role !== "owner" && user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅企业负责人可发起兑回申请" });
      }
      const balance = await getFactoryTokenBalance(factory.id);
      if (balance < input.amount) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `余额不足（现有 ${balance}，申请 ${input.amount}）` });
      }
      const masked = maskAccount(input.account);
      await getDb().execute(
        sql`INSERT INTO st_withdrawals (owner_type, owner_id, amount, channel, account_masked, requested_by)
            VALUES ('enterprise', ${factory.id}, ${input.amount}, ${input.channel}, ${masked}, ${String(user.username)})`,
      );
      const idRows = rawRows(await getDb().execute(sql`SELECT LAST_INSERT_ID() AS id`));
      return { ok: true as const, id: Number(idRows[0]?.id ?? 0), status: "pending" as const };
    }),

  /** myWithdrawals（query）：本企业兑回申请列表 */
  myWithdrawals: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const rows = rawRows(
        await getDb().execute(
          sql`SELECT id, amount, channel, account_masked AS accountMasked, status, review_note AS reviewNote,
                     created_at AS createdAt, paid_at AS paidAt
              FROM st_withdrawals WHERE owner_type = 'enterprise' AND owner_id = ${factory.id}
              ORDER BY id DESC LIMIT 50`,
        ).catch(() => [[]]),
      );
      return { items: rows };
    }),

  /** masterWallets（query, admin）：供给侧钱包总览（大师余额 + 累计入账） */
  masterWallets: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const masters = rawRows(
        await getDb().execute(
          sql`SELECT m.id, m.name, m.title, m.tokenBalance,
                     (SELECT COUNT(*) FROM st_wallet_flows f WHERE f.owner_type = 'master' AND f.owner_id = m.id AND f.direction = 'in') AS credits
              FROM masters m ORDER BY m.tokenBalance DESC LIMIT 100`,
        ).catch(() => [[]]),
      );
      return { masters };
    }),

  /** withdrawQueue（query, admin）：提现复核队列（pending 在前） */
  withdrawQueue: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const rows = rawRows(
        await getDb().execute(
          sql`SELECT id, owner_type AS ownerType, owner_id AS ownerId, amount, channel,
                     account_masked AS accountMasked, status, requested_by AS requestedBy,
                     review_note AS reviewNote, proof, created_at AS createdAt
              FROM st_withdrawals ORDER BY status = 'pending' DESC, id DESC LIMIT 100`,
        ).catch(() => [[]]),
      );
      return { items: rows };
    }),

  /**
   * withdrawReview（mutation, admin）：提现复核。
   * approve → 原子扣钱包（余额不足自动 reject-safe 报错）→ approved；
   * paid（带凭证）→ paid + paid_at；reject → rejected（不扣钱）。
   * 全程 writeAdminAudit。
   */
  withdrawReview: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        id: z.number().int().positive(),
        action: z.enum(["approved", "rejected", "paid"]),
        note: z.string().trim().max(255).optional(),
        proof: z.string().trim().max(255).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const rows = rawRows(
        await getDb().execute(
          sql`SELECT id, owner_type AS ownerType, owner_id AS ownerId, amount, status
              FROM st_withdrawals WHERE id = ${input.id} LIMIT 1`,
        ),
      );
      const w = rows[0];
      if (!w) throw new TRPCError({ code: "NOT_FOUND", message: "提现申请不存在" });
      const status = String(w.status);
      const adminName = adminDisplayName(admin);

      if (input.action === "approved") {
        if (status !== "pending") throw new TRPCError({ code: "BAD_REQUEST", message: `当前状态 ${status}，仅 pending 可批准` });
        // 原子扣钱包（仅 enterprise 域支持在线扣；master 域走线下结算台账）
        if (String(w.ownerType) === "enterprise") {
          const res = (await getDb().execute(
            sql`UPDATE enterprises SET tokenBalance = tokenBalance - ${Number(w.amount)}
                WHERE id = ${Number(w.ownerId)} AND tokenBalance >= ${Number(w.amount)}`,
          )) as unknown;
          const header = Array.isArray(res) ? (res[0] as { affectedRows?: number }) : {};
          if (Number(header?.affectedRows ?? 0) !== 1) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "企业余额已不足，无法批准（请驳回）" });
          }
          const after = await getFactoryTokenBalance(Number(w.ownerId));
          await writeFlow({
            ownerType: "enterprise",
            ownerId: Number(w.ownerId),
            direction: "out",
            amount: Number(w.amount),
            balanceAfter: after,
            bizType: "withdraw_debit",
            refId: `wd:${w.id}`,
            note: `兑回批准（复核 ${adminName}）`,
          });
        }
        await getDb().execute(
          sql`UPDATE st_withdrawals SET status = 'approved', reviewed_by = ${adminName},
              review_note = ${input.note ?? null}, reviewed_at = NOW() WHERE id = ${input.id} AND status = 'pending'`,
        );
      } else if (input.action === "rejected") {
        if (status !== "pending") throw new TRPCError({ code: "BAD_REQUEST", message: `当前状态 ${status}，仅 pending 可驳回` });
        await getDb().execute(
          sql`UPDATE st_withdrawals SET status = 'rejected', reviewed_by = ${adminName},
              review_note = ${input.note ?? null}, reviewed_at = NOW() WHERE id = ${input.id} AND status = 'pending'`,
        );
      } else {
        // paid：须先有 approved + 凭证
        if (status !== "approved") throw new TRPCError({ code: "BAD_REQUEST", message: `当前状态 ${status}，仅 approved 可标记已付` });
        if (!input.proof) throw new TRPCError({ code: "BAD_REQUEST", message: "标记已付必须附结算凭证（回单号/截图路径）" });
        await getDb().execute(
          sql`UPDATE st_withdrawals SET status = 'paid', proof = ${input.proof}, paid_at = NOW()
              WHERE id = ${input.id} AND status = 'approved'`,
        );
      }
      writeAdminAudit(Number(admin.id), adminName, "walletPay.withdrawReview", String(input.id), {
        action: input.action, amount: Number(w.amount), ownerType: String(w.ownerType), ownerId: Number(w.ownerId),
      });
      return { ok: true as const, id: input.id, status: input.action };
    }),

  // ─── M55 词元经济：个人词元钱包 + 数字人钱包 ─────────────────────────────

  /** myTokenWallet（query）：个人词元余额 + 我的流水（倒序 50） */
  myTokenWallet: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { user } = await sessionMe(input.token);
      const balance = await getUserTokenBalance(user.id);
      const rows = rawRows(
        await getDb().execute(
          sql`SELECT direction, amount, balanceAfter, bizType, note, created_at AS createdAt
              FROM st_wallet_flows WHERE owner_type = 'user' AND owner_id = ${user.id}
              ORDER BY id DESC LIMIT 50`,
        ).catch(() => [[]]),
      );
      return { balance, flows: rows };
    }),

  /** personaWallets（query, admin）：数字人词元钱包（灵枢/星云余额 + 累计分润笔数） */
  personaWallets: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const rows = rawRows(
        await getDb().execute(
          sql`SELECT p.persona, p.tokenBalance,
                     (SELECT COUNT(*) FROM st_wallet_flows f
                      WHERE f.owner_type = 'persona' AND f.direction = 'in'
                        AND f.owner_id = CASE p.persona WHEN 'lingshu' THEN 1 ELSE 2 END) AS credits
              FROM st_persona_wallets p ORDER BY p.persona`,
        ).catch(() => [[]]),
      );
      return { wallets: rows };
    }),

  /** personalWithdraw（mutation）：个人词元兑数字人民币/数字钱包（≥100，进既有审批管线） */
  personalWithdraw: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        amount: z.number().int().min(MIN_WITHDRAW),
        channel: z.enum(["ecny", "ewallet"]),
        account: z.string().trim().min(4).max(128),
      }),
    )
    .mutation(async ({ input }) => {
      const { user } = await sessionMe(input.token);
      const balance = await getUserTokenBalance(user.id);
      if (balance < input.amount) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `词元不足（现有 ${balance}，申请 ${input.amount}）` });
      }
      const masked = maskAccount(input.account);
      await getDb().execute(
        sql`INSERT INTO st_withdrawals (owner_type, owner_id, amount, channel, account_masked, requested_by)
            VALUES ('user', ${user.id}, ${input.amount}, ${input.channel}, ${masked}, ${String(user.username)})`,
      );
      const idRows = rawRows(await getDb().execute(sql`SELECT LAST_INSERT_ID() AS id`));
      return { ok: true as const, id: Number(idRows[0]?.id ?? 0), status: "pending" as const };
    }),

  /** personaReward（mutation, admin）：数字人回馈用户（钱包原子出账→用户入账，双向流水） */
  personaReward: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        persona: z.enum(["lingshu", "xingyun"]),
        userId: z.number().int().positive(),
        amount: z.number().int().min(1).max(10000),
        note: z.string().trim().max(200).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const pBal = await getPersonaTokenBalance(input.persona);
      if (pBal < input.amount) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `数字人词元不足（现有 ${pBal}）` });
      }
      // 数字人出账（原子防透支）
      await getDb().execute(
        sql`UPDATE st_persona_wallets SET tokenBalance = tokenBalance - ${input.amount}
            WHERE persona = ${input.persona} AND tokenBalance >= ${input.amount}`,
      );
      const pAfter = await getPersonaTokenBalance(input.persona);
      await writeFlow({
        ownerType: "persona",
        ownerId: input.persona === "lingshu" ? 1 : 2,
        direction: "out",
        amount: input.amount,
        balanceAfter: pAfter,
        bizType: "persona_reward",
        refId: `user:${input.userId}`,
        note: input.note ?? "数字人回馈",
      });
      // 用户入账
      const u = await creditUser({
        userId: input.userId,
        amount: input.amount,
        bizType: "persona_reward",
        refId: `persona:${input.persona}`,
        note: input.note ?? `来自${input.persona === "lingshu" ? "灵枢" : "星云"}的回馈`,
      });
      writeAdminAudit(Number(admin.id), adminDisplayName(admin as never), "walletPay.personaReward", String(input.userId), {
        persona: input.persona,
        amount: input.amount,
      });
      return { ok: true as const, personaBalanceAfter: pAfter, userBalanceAfter: u.balanceAfter };
    }),

  /** v177 双栏钱包（第五刀）：企业账 ⇄ 个人账一卡合并（只读，老板视角） */
  dualWallet: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const session = await sessionMe(input.token);
      const uid = Number(session.user.id);
      const fid = session.factory.id;
      const db = getDb();
      const { getFactoryTokenBalance, getUserTokenBalance } = await import("./tokenLedger");
      const [fb, ub] = await Promise.all([getFactoryTokenBalance(fid), getUserTokenBalance(uid)]);
      const month = rawRows(
        await db.execute(
          sql`SELECT
                COALESCE((
                  SELECT SUM(f.amount) FROM st_wallet_flows f
                  WHERE f.created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
                    AND f.owner_type='enterprise' AND f.owner_id=${fid}
                    AND f.direction='out' AND f.biz_type<>${AGENT_TASK_ESCROW_RESERVE_BIZ_TYPE}
                ),0) + COALESCE((
                  SELECT SUM(w.amount_job_tokens) FROM st_agent_wage_ledger w
                  WHERE w.created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
                    AND w.factory_id=${fid} AND w.direction='debit'
                    AND w.wallet_owner_type='enterprise' AND w.wallet_owner_id=${fid}
                ),0) AS fOut,
                COALESCE((
                  SELECT SUM(u.amount) FROM st_wallet_flows u
                  WHERE u.created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
                    AND u.owner_type='user' AND u.owner_id=${uid} AND u.direction='in'
                ),0) AS uIn`,
        ).catch(() => [[]]),
      )[0] ?? {};
      return {
        factoryBalance: fb, userBalance: ub,
        factoryMonthSpend: Number((month as Record<string, unknown>).fOut ?? 0),
        userMonthIncome: Number((month as Record<string, unknown>).uIn ?? 0),
      };
    }),
});

