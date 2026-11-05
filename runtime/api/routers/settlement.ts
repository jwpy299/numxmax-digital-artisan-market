import { z } from "zod";
import { desc, eq, sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { requireAdmin } from "./admin";
import { getDb } from "../queries/connection";
import {
  agents,
  enterprises,
  agentHireRecords,
  tokenTransactions,
  tasks,
} from "@db/schema";

const tokenInput = z.object({ token: z.string().trim().min(1) });

// sec-wave2（深度审核第二波 P1）：结算面为经营数据，收口管理员可见
export const settlementRouter = createRouter({
  /** 平台结算总览：总收入 / 佣金 / Agent 数 / 雇佣数 / 任务数 */
  overview: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const db = getDb();
    const [sums] = await db
      .select({
        totalVolume: sql<number>`coalesce(sum(${tokenTransactions.amount}),0)`,
        platformRevenue: sql<number>`coalesce(sum(${tokenTransactions.platformFee}),0)`,
        masterPayout: sql<number>`coalesce(sum(${tokenTransactions.masterShare}),0)`,
        txCount: sql<number>`count(*)`,
      })
      .from(tokenTransactions);
    const byType = await db
      .select({
        type: tokenTransactions.type,
        amount: sql<number>`coalesce(sum(${tokenTransactions.amount}),0)`,
        platformFee: sql<number>`coalesce(sum(${tokenTransactions.platformFee}),0)`,
        count: sql<number>`count(*)`,
      })
      .from(tokenTransactions)
      .groupBy(tokenTransactions.type);
    const [agentCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(agents);
    const [hireCount] = await db
      .select({
        total: sql<number>`count(*)`,
        active: sql<number>`sum(case when ${agentHireRecords.status} = 'active' then 1 else 0 end)`,
      })
      .from(agentHireRecords);
    const [taskCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks);
    const [enterpriseCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(enterprises);
    return {
      totalVolume: Number(sums.totalVolume),
      platformRevenue: Number(sums.platformRevenue),
      masterPayout: Number(sums.masterPayout),
      txCount: Number(sums.txCount),
      byType: byType.map((r) => ({
        type: r.type,
        amount: Number(r.amount),
        platformFee: Number(r.platformFee),
        count: Number(r.count),
      })),
      agentCount: Number(agentCount.count),
      hireTotal: Number(hireCount.total),
      hireActive: Number(hireCount.active ?? 0),
      taskCount: Number(taskCount.count),
      enterpriseCount: Number(enterpriseCount.count),
    };
  }),

  /**
   * 单 Agent 账本：雇佣佣金 + 技能分润明细与合计，
   * 附单 Agent 生命周期收入测算（对应方案 42,000 Token/年 模型）。
   */
  agentLedger: publicQuery
    .input(tokenInput.extend({ agentId: z.number().int().positive() }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .limit(1);
      if (!agent) throw new Error(`Agent ${input.agentId} 不存在`);

      const entries = await db
        .select()
        .from(tokenTransactions)
        .where(eq(tokenTransactions.agentId, input.agentId))
        .orderBy(desc(tokenTransactions.createdAt))
        .limit(200);

      const hireEntries = entries.filter((e) => e.type === "hire_commission");
      const skillEntries = entries.filter(
        (e) => e.type === "skill_call" || e.type === "trial_skill_call",
      );
      const sum = (arr: typeof entries, k: "amount" | "platformFee" | "masterShare") =>
        arr.reduce((a, e) => a + e[k], 0);

      // 生命周期收入测算（月薪 15% × 12 个月 × 当前雇主数；技能 100 Token × 20% × 100 次/月 × 12 个月）
      const activeEmployers = await db
        .select({ count: sql<number>`count(*)` })
        .from(agentHireRecords)
        .where(
          sql`${agentHireRecords.agentId} = ${input.agentId} and ${agentHireRecords.status} = 'active'`,
        );
      const employers = Math.max(1, Number(activeEmployers[0]?.count ?? 0));
      const monthlyHireCommission = Math.round(agent.monthlyPrice * 0.15);
      const hireCommissionAnnual = monthlyHireCommission * 12 * employers;
      const skillShareAnnual = 100 * 0.2 * 100 * 12; // 24,000
      const projection = {
        employers,
        monthlyHireCommission,
        hireCommissionAnnual,
        skillShareAnnual,
        totalAnnual: hireCommissionAnnual + skillShareAnnual,
        formula: `雇佣佣金 = 月薪 ${agent.monthlyPrice} × 15% × 12 个月 × ${employers} 个雇主 = ${hireCommissionAnnual} Token；技能分润 = 每次 100 Token × 20% × 100 次/月 × 12 个月 = ${skillShareAnnual} Token`,
      };

      return {
        agent,
        hire: {
          entries: hireEntries,
          amount: sum(hireEntries, "amount"),
          platformFee: sum(hireEntries, "platformFee"),
          masterShare: sum(hireEntries, "masterShare"),
        },
        skill: {
          entries: skillEntries,
          amount: sum(skillEntries, "amount"),
          platformFee: sum(skillEntries, "platformFee"),
          masterShare: sum(skillEntries, "masterShare"),
        },
        total: {
          amount: sum(entries, "amount"),
          platformFee: sum(entries, "platformFee"),
          masterShare: sum(entries, "masterShare"),
        },
        projection,
      };
    }),
});
