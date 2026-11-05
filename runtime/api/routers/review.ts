import { z } from "zod";
import { desc, eq, inArray, and, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, adminQuery } from "../middleware";
import { getDb } from "../queries/connection";
import {
  agents,
  masters,
  skills,
  agentMemories,
} from "@db/schema";

/** 低分阈值：低于该评分即视为质量风险 */
const LOW_RATING_THRESHOLD = 3;

export const reviewRouter = createRouter({
  /** 审核队列（仅 admin）：待审 Agent（含技能数/老师傅/提交时间/上架资料）+ 下架风险 Agent */
  pendingQueue: adminQuery.query(async () => {
    const db = getDb();
    const pendingRows = await db
      .select({
        agent: agents,
        masterName: masters.name,
        masterSignature: masters.signature,
        masterReputation: masters.reputation,
      })
      .from(agents)
      .leftJoin(masters, eq(agents.masterId, masters.id))
      .where(eq(agents.status, "pending"))
      .orderBy(desc(agents.createdAt));

    const pendingIds = pendingRows.map((r) => r.agent.id);
    const [skillRows, introRows] = pendingIds.length
      ? await Promise.all([
          db
            .select()
            .from(skills)
            .where(inArray(skills.agentId, pendingIds))
            .orderBy(desc(skills.callCount)),
          db
            .select()
            .from(agentMemories)
            .where(
              and(
                inArray(agentMemories.agentId, pendingIds),
                eq(agentMemories.category, "工匠简介"),
              ),
            )
            .orderBy(desc(agentMemories.createdAt)),
        ])
      : [[], []];

    const pending = pendingRows.map((r) => ({
      ...r.agent,
      masterName: r.masterName,
      masterSignature: r.masterSignature,
      masterReputation: r.masterReputation,
      skills: skillRows.filter((s) => s.agentId === r.agent.id),
      intro:
        introRows.find((m) => m.agentId === r.agent.id)?.summary ?? null,
    }));

    const riskRows = await db
      .select({
        agent: agents,
        masterName: masters.name,
        masterSignature: masters.signature,
      })
      .from(agents)
      .leftJoin(masters, eq(agents.masterId, masters.id))
      .where(eq(agents.delistRisk, true))
      .orderBy(desc(agents.createdAt));
    const risk = riskRows.map((r) => ({
      ...r.agent,
      masterName: r.masterName,
      masterSignature: r.masterSignature,
    }));

    return { pending, risk };
  }),

  /** 审核决定（仅 admin）：通过 → active；驳回 → rejected + 审核记录 */
  decideAgent: adminQuery
    .input(
      z.object({
        agentId: z.number().int().positive(),
        approve: z.boolean(),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .limit(1);
      if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: "Agent 不存在" });
      if (agent.status !== "pending") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `该 Agent 当前状态为 ${agent.status}，不在待审队列`,
        });
      }
      if (!input.approve && !input.reason) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "驳回时必须填写原因",
        });
      }

      if (input.approve) {
        await db
          .update(agents)
          .set({ status: "active", listedAt: new Date() })
          .where(eq(agents.id, agent.id));
        await db.insert(agentMemories).values({
          agentId: agent.id,
          category: "审核记录",
          summary: `上架审核通过（评审人：${ctx.user.name ?? ctx.user.unionId}），Agent 正式上架数字匠市。`,
        });
        return { ok: true, status: "active" as const };
      }

      await db
        .update(agents)
        .set({ status: "rejected" })
        .where(eq(agents.id, agent.id));
      await db.insert(agentMemories).values({
        agentId: agent.id,
        category: "审核记录",
        summary: `上架审核被驳回（评审人：${ctx.user.name ?? ctx.user.unionId}）。原因：${input.reason}`,
      });
      return { ok: true, status: "rejected" as const, reason: input.reason };
    }),

  /** 下架风险 Agent（仅 admin）：delistRisk 或低分 → suspended */
  delistAgent: adminQuery
    .input(
      z.object({
        agentId: z.number().int().positive(),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .limit(1);
      if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: "Agent 不存在" });
      const isRisk =
        agent.delistRisk ||
        (agent.ratingCount > 0 && agent.avgRating < LOW_RATING_THRESHOLD);
      if (!isRisk) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "该 Agent 无下架风险标记且评分正常，不可执行下架",
        });
      }
      if (agent.status === "suspended") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "该 Agent 已下架" });
      }
      await db
        .update(agents)
        .set({ status: "suspended" })
        .where(eq(agents.id, agent.id));
      await db.insert(agentMemories).values({
        agentId: agent.id,
        category: "审核记录",
        summary: `平台评审会执行下架（评审人：${ctx.user.name ?? ctx.user.unionId}）。${input.reason ? `原因：${input.reason}` : "触发下架风险规则。"}`,
      });
      return { ok: true, status: "suspended" as const };
    }),

  /** 审核仪表统计（仅 admin）：待审数 / 已上架数 / 驳回数 / 风险数 */
  stats: adminQuery.query(async () => {
    const db = getDb();
    const [row] = await db
      .select({
        pending: sql<number>`SUM(CASE WHEN ${agents.status} = 'pending' THEN 1 ELSE 0 END)`,
        active: sql<number>`SUM(CASE WHEN ${agents.status} = 'active' THEN 1 ELSE 0 END)`,
        rejected: sql<number>`SUM(CASE WHEN ${agents.status} = 'rejected' THEN 1 ELSE 0 END)`,
        suspended: sql<number>`SUM(CASE WHEN ${agents.status} = 'suspended' THEN 1 ELSE 0 END)`,
        risk: sql<number>`SUM(CASE WHEN ${agents.delistRisk} = TRUE THEN 1 ELSE 0 END)`,
      })
      .from(agents);
    return {
      pending: Number(row?.pending ?? 0),
      active: Number(row?.active ?? 0),
      rejected: Number(row?.rejected ?? 0),
      suspended: Number(row?.suspended ?? 0),
      risk: Number(row?.risk ?? 0),
    };
  }),

});
