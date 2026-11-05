import { z } from "zod";
import { eq } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { agents, masters, skills } from "@db/schema";
import { priceHistory, simulatePrice } from "../lib/pricing";

export const pricingRouter = createRouter({
  /** 定价模拟器：滑块参数 → 建议价 + 瀑布构成 + 12 个月轨迹 + 规则说明 */
  simulate: publicQuery
    .input(
      z.object({
        skillCount: z.number().int().min(1).max(40).default(12),
        complexity: z.number().int().min(1).max(5).default(3),
        reputation: z.number().int().min(0).max(100).default(92),
        demandRatio: z.number().min(0.1).max(3).default(1.3),
        rating: z.number().min(1).max(5).default(4.9),
        tasksCompleted: z.number().int().min(0).max(100000).default(327),
      }),
    )
    .query(({ input }) => simulatePrice(input)),

  /** Agent 近 30 天价格曲线（确定性伪随机，锚定当前月薪） */
  history: publicQuery
    .input(z.object({ agentId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .limit(1);
      if (!agent) throw new Error(`Agent ${input.agentId} 不存在`);
      const points = priceHistory(input.agentId, agent.monthlyPrice);
      const first = points[0]?.price ?? agent.monthlyPrice;
      return {
        agentId: agent.id,
        currentPrice: agent.monthlyPrice,
        suggestedPrice: agent.suggestedPrice,
        masterAdjustment: agent.monthlyPrice - agent.suggestedPrice,
        changePct:
          Math.round(((agent.monthlyPrice - first) / first) * 1000) / 10,
        points,
      };
    }),

  /** Agent 自身的定价构成拆解（详情页"价格构成"） */
  breakdown: publicQuery
    .input(z.object({ agentId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [row] = await db
        .select({ agent: agents, master: masters })
        .from(agents)
        .leftJoin(masters, eq(agents.masterId, masters.id))
        .where(eq(agents.id, input.agentId))
        .limit(1);
      if (!row) throw new Error(`Agent ${input.agentId} 不存在`);
      const skillRows = await db
        .select()
        .from(skills)
        .where(eq(skills.agentId, input.agentId));
      const avgComplexity = skillRows.length
        ? skillRows.reduce((a, s) => a + s.complexity, 0) / skillRows.length
        : 3;
      const result = simulatePrice({
        skillCount: row.agent.skillCount || skillRows.length || 10,
        complexity: Math.round(avgComplexity),
        reputation: row.master?.reputation ?? 80,
        demandRatio: 1 + Math.min(0.8, row.agent.weeklyHires * 0.05),
        rating: row.agent.avgRating,
        tasksCompleted: Math.min(500, row.agent.tasksCompleted),
      });
      // pricing.simulate 采用定价页演示标尺（≈1,284 Token），
      // 实际挂牌工匠月薪为 10 倍标尺，这里统一放大便于与当前月薪对比。
      const SCALE = 10;
      return {
        agentId: row.agent.id,
        currentPrice: row.agent.monthlyPrice,
        suggestedPrice: result.suggestedPrice * SCALE,
        breakdown: result.breakdown.map((b) => ({ ...b, amount: b.amount * SCALE })),
        trajectory: result.trajectory.map((t) => ({ ...t, price: t.price * SCALE })),
        rules: result.rules,
      };
    }),
});
