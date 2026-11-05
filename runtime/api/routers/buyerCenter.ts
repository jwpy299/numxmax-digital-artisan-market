/**
 * buyerCenter —— 买家中心聚合查询（⑤功能模块·买家面，2026-10-01）。
 *
 * 一拉三件（门户 /my 单点）：
 * ① myContracts：本企业雇佣合约（agentHireRecords join agents——门户自助签约面正源，
 *    与 hire.list 同口径但免 enterpriseId 入参（会话厂域焊死，跨厂不泄））；
 * ② myWallet：个人词元钱包（st_wallet_flows 最新 balance_after + 近 10 笔流水——
 *    owner_type='user' 个人域；企业域钱包面挂账 P-ENT-WALLET）；
 * ③ myBonuses：邀请返佣台账（st_referral_ledger 本推荐人——5% 从平台抽成出，
 *    首单计提防刷（referral 管线路径）；空态友好）。
 * 鉴权：token 在请求体（sessionMe）；token 明文绝不落日志。
 */
import { z } from "zod";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { desc, eq, sql } from "drizzle-orm";
import { sessionMe } from "./wbSession";
import { rawRows } from "./terminal";
import { agentHireRecords, agents } from "@db/schema";

const tokenInput = z.object({ token: z.string().trim().min(1) });

/** st_ 表查询兜底：表缺失/迁移窗口按空集降级（全新用户空态不炸页） */
async function rowsSafe(statement: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  try {
    return rawRows(await getDb().execute(statement));
  } catch {
    return [];
  }
}

export const buyerCenterRouter = createRouter({
  overview: publicQuery.input(tokenInput).query(async ({ input }) => {
    const session = await sessionMe(input.token);
    const db = getDb();

    // ① 本企业合约（与 hire.list 同口径，厂域会话焊死）
    const contractRows = await db
      .select({ hire: agentHireRecords, agent: agents })
      .from(agentHireRecords)
      .leftJoin(agents, eq(agentHireRecords.agentId, agents.id))
      .where(eq(agentHireRecords.enterpriseId, session.factory.id))
      .orderBy(desc(agentHireRecords.createdAt));
    const contracts = contractRows.map((r) => ({
      id: r.hire.id,
      status: r.hire.status,
      periodMonths: r.hire.periodMonths,
      monthlyPrice: r.hire.monthlyPrice,
      startsAt: r.hire.startedAt,
      endsAt: r.hire.endsAt,
      createdAt: r.hire.createdAt,
      agentName: r.agent?.name ?? "（员工档案已下架）",
      agentSlug: r.agent?.slug ?? null,
      agentAvatar: r.agent?.avatar ?? null,
      rating: r.hire.rating ?? null,
      review: r.hire.review ?? null,
    }));

    // ② 个人词元钱包（owner_type='user' 个人域）
    const balanceRows = await rowsSafe(
      sql`SELECT balance_after AS b FROM st_wallet_flows
          WHERE owner_type='user' AND owner_id=${session.user.id}
          ORDER BY id DESC LIMIT 1`,
    );
    const balance = Number(balanceRows[0]?.b ?? 0);
    const flows = (await rowsSafe(
      sql`SELECT direction, amount, balance_after AS balanceAfter, biz_type AS bizType, note, created_at AS createdAt
          FROM st_wallet_flows
          WHERE owner_type='user' AND owner_id=${session.user.id}
          ORDER BY id DESC LIMIT 10`,
    )) as Array<{
      direction: string; amount: unknown; balanceAfter: unknown;
      bizType: string; note: string | null; createdAt: unknown;
    }>;

    // ③ 邀请返佣台账（本推荐人）
    const bonusRows = (await rowsSafe(
      sql`SELECT order_ref AS orderRef, order_amount AS orderAmount, bonus, created_at AS createdAt
          FROM st_referral_ledger
          WHERE referrer_user_id=${session.user.id}
          ORDER BY id DESC LIMIT 20`,
    )) as Array<{ orderRef: string; orderAmount: unknown; bonus: unknown; createdAt: unknown }>;
    const bonusTotal = bonusRows.reduce((s, r) => s + Number(r.bonus ?? 0), 0);

    return {
      contracts,
      wallet: { balance, flows },
      bonuses: { rows: bonusRows, total: bonusTotal },
    };
  }),
});
