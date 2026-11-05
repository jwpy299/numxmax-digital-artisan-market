import { z } from "zod";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import {
  agents,
  masters,
  reviews,
  enterprises,
  agentMemories,
  tokenTransactions,
  type Agent,
  type TokenTransaction,
} from "@db/schema";

/** 技能分润类流水类型 */
const SKILL_TYPES: TokenTransaction["type"][] = ["skill_call", "trial_skill_call"];

type TxRow = Pick<TokenTransaction, "type" | "masterShare" | "createdAt">;

/** 按老师傅名下 Agent 聚合其 token_transactions 中的分成金额 */
async function earningsByMaster(masterIds: number[]) {
  const db = getDb();
  if (masterIds.length === 0) return new Map<number, number>();
  const rows = await db
    .select({
      masterId: agents.masterId,
      total: sql<number>`coalesce(sum(${tokenTransactions.masterShare}),0)`,
    })
    .from(tokenTransactions)
    .innerJoin(agents, eq(tokenTransactions.agentId, agents.id))
    .where(inArray(agents.masterId, masterIds))
    .groupBy(agents.masterId);
  return new Map(rows.map((r) => [r.masterId, Number(r.total)]));
}

function fmtDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

export const mastersRouter = createRouter({
  /**
   * 老师傅列表：含工匠数、平均评分、累计收益（名下 Agent 流水的 masterShare 合计）、声望。
   */
  list: publicQuery.query(async () => {
    const db = getDb();
    const masterRows = await db.select().from(masters).orderBy(desc(masters.reputation));
    if (masterRows.length === 0) return { total: 0, items: [] };

    const masterIds = masterRows.map((m) => m.id);
    const agentStats = await db
      .select({
        masterId: agents.masterId,
        agentCount: sql<number>`count(*)`,
        avgRating: sql<number>`coalesce(avg(${agents.avgRating}),0)`,
        tasksCompleted: sql<number>`coalesce(sum(${agents.tasksCompleted}),0)`,
        activeCount: sql<number>`sum(case when ${agents.status} = 'active' then 1 else 0 end)`,
      })
      .from(agents)
      .where(inArray(agents.masterId, masterIds))
      .groupBy(agents.masterId);
    const statMap = new Map(agentStats.map((s) => [s.masterId, s]));
    const earnMap = await earningsByMaster(masterIds);

    const items = masterRows.map((m) => {
      const s = statMap.get(m.id);
      return {
        ...m,
        agentCount: Number(s?.agentCount ?? 0),
        activeAgentCount: Number(s?.activeCount ?? 0),
        avgRating: Math.round(Number(s?.avgRating ?? 0) * 100) / 100,
        tasksCompleted: Number(s?.tasksCompleted ?? 0),
        totalEarnings: earnMap.get(m.id) ?? 0,
      };
    });
    return { total: items.length, items };
  }),

  /**
   * 老师傅看板：详情 + 名下 Agent + 收益聚合（雇佣分成 / 技能分润 / 总计 / 近 30 天趋势）
   * + 名下 Agent 的雇主评价 + 工作记忆条数。
   */
  dashboard: publicQuery
    .input(z.object({ masterId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [master] = await db
        .select()
        .from(masters)
        .where(eq(masters.id, input.masterId))
        .limit(1);
      if (!master) throw new Error(`老师傅 ${input.masterId} 不存在`);

      const myAgents: Agent[] = await db
        .select()
        .from(agents)
        .where(eq(agents.masterId, input.masterId))
        .orderBy(desc(agents.avgRating));
      const agentIds = myAgents.map((a) => a.id);

      const loadReviews = () =>
        db
          .select({
            review: reviews,
            enterpriseName: enterprises.name,
            enterpriseIndustry: enterprises.industry,
            agentName: agents.name,
            agentCode: agents.code,
          })
          .from(reviews)
          .leftJoin(enterprises, eq(reviews.enterpriseId, enterprises.id))
          .leftJoin(agents, eq(reviews.agentId, agents.id))
          .where(inArray(reviews.agentId, agentIds))
          .orderBy(desc(reviews.createdAt))
          .limit(50);

      // ── 收益：名下 Agent 全部流水的 masterShare ──
      let txs: TxRow[] = [];
      let reviewRows: Awaited<ReturnType<typeof loadReviews>> = [];
      let memoryTotal = 0;

      if (agentIds.length > 0) {
        txs = await db
          .select({
            type: tokenTransactions.type,
            masterShare: tokenTransactions.masterShare,
            createdAt: tokenTransactions.createdAt,
          })
          .from(tokenTransactions)
          .where(inArray(tokenTransactions.agentId, agentIds))
          .orderBy(desc(tokenTransactions.createdAt));

        reviewRows = await loadReviews();

        const [mem] = await db
          .select({ count: sql<number>`count(*)` })
          .from(agentMemories)
          .where(inArray(agentMemories.agentId, agentIds));
        memoryTotal = Number(mem?.count ?? 0);
      }

      const sum = (arr: TxRow[]) => arr.reduce((a, e) => a + e.masterShare, 0);
      const hireTxs = txs.filter((t) => t.type === "hire_commission");
      const skillTxs = txs.filter((t) => SKILL_TYPES.includes(t.type));
      const hire = sum(hireTxs);
      const skill = sum(skillTxs);
      const other = sum(txs) - hire - skill;

      // 近 30 天收益趋势（按日聚合 masterShare，缺日补 0）
      const dayMs = 24 * 60 * 60 * 1000;
      const today = new Date();
      const start = new Date(today.getTime() - 29 * dayMs);
      const byDay = new Map<string, number>();
      for (const t of txs) {
        const d = t.createdAt instanceof Date ? t.createdAt : new Date(t.createdAt);
        if (d.getTime() < start.getTime() - dayMs) continue;
        const key = fmtDate(d);
        byDay.set(key, (byDay.get(key) ?? 0) + t.masterShare);
      }
      const trend: { date: string; amount: number }[] = [];
      for (let i = 29; i >= 0; i--) {
        const key = fmtDate(new Date(today.getTime() - i * dayMs));
        trend.push({ date: key, amount: byDay.get(key) ?? 0 });
      }

      return {
        master,
        agents: myAgents.map((a) => ({
          id: a.id,
          slug: a.slug,
          code: a.code,
          name: a.name,
          avatar: a.avatar,
          industry: a.industry,
          capabilityTags: a.capabilityTags,
          status: a.status,
          monthlyPrice: a.monthlyPrice,
          avgRating: a.avgRating,
          ratingCount: a.ratingCount,
          tasksCompleted: a.tasksCompleted,
          successRate: a.successRate,
          skillCount: a.skillCount,
          memoryCount: a.memoryCount,
          certified: a.certified,
          recommended: a.recommended,
        })),
        earnings: {
          hire,
          skill,
          other,
          total: hire + skill + other,
          txCount: txs.length,
          trend,
        },
        reviews: reviewRows.map((r) => ({
          ...r.review,
          enterpriseName: r.enterpriseName,
          enterpriseIndustry: r.enterpriseIndustry,
          agentName: r.agentName,
          agentCode: r.agentCode,
        })),
        stats: {
          agentCount: myAgents.length,
          activeAgentCount: myAgents.filter((a) => a.status === "active").length,
          tasksCompleted: myAgents.reduce((a, x) => a + x.tasksCompleted, 0),
          avgRating:
            myAgents.length > 0
              ? Math.round(
                  (myAgents.reduce((a, x) => a + x.avgRating, 0) / myAgents.length) * 100,
                ) / 100
              : 0,
          memoryTotal,
          memoryBaseline: myAgents.reduce((a, x) => a + x.memoryCount, 0),
        },
      };
    }),
});
