import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import {
  agents,
  skills,
  tasks,
  agentMemories,
  tokenTransactions,
} from "@db/schema";
import { generateRealTask } from "./realTaskEngine";

export const SKILL_COMMISSION_RATE = 0.2; // 技能调用平台抽 20%

export const tasksRouter = createRouter({
  /**
   * 下达任务：意图解析 → 子任务拆解 → 技能链调度 → 结构化报告。
   * 一次性生成全部步骤与报告并持久化，前端逐步动画呈现。
   * 每次技能调用按技能定价记流水（平台抽 20%）。
   */
  create: publicQuery
    .input(
      z.object({
        agentId: z.number().int().positive(),
        enterpriseId: z.number().int().positive(),
        instruction: z.string().trim().min(2).max(500),
        hireRecordId: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .limit(1);
      if (!agent) throw new Error(`Agent ${input.agentId} 不存在`);
      const agentSkills = await db
        .select()
        .from(skills)
        .where(eq(skills.agentId, input.agentId))
        .orderBy(desc(skills.callCount));
      if (!agentSkills.length) throw new Error("该工匠暂无可用技能");

      const gen = await generateRealTask(input.instruction, agent.name, agentSkills);

      const [{ id: taskId }] = await db
        .insert(tasks)
        .values({
          agentId: input.agentId,
          enterpriseId: input.enterpriseId,
          hireRecordId: input.hireRecordId ?? null,
          instruction: input.instruction,
          intentSummary: gen.intentSummary,
          targetDevice: gen.targetDevice,
          status: "completed",
          steps: gen.steps,
          report: gen.report,
          confidence: gen.confidence,
          tokenCost: gen.tokenCost,
          durationMs: gen.durationMs,
          memoryWritten: true,
        })
        .$returningId();

      // 技能调用流水：每次调用按技能定价，平台抽 20%
      for (const skill of gen.skillChain) {
        const platformFee = Math.round(skill.pricePerCall * SKILL_COMMISSION_RATE);
        await db.insert(tokenTransactions).values({
          type: "skill_call",
          amount: skill.pricePerCall,
          platformFee,
          masterShare: skill.pricePerCall - platformFee,
          agentId: input.agentId,
          enterpriseId: input.enterpriseId,
          hireRecordId: input.hireRecordId ?? null,
          taskId,
          note: `技能调用 · ${skill.name}`,
        });
        await db
          .update(skills)
          .set({ callCount: sql`${skills.callCount} + 1` })
          .where(eq(skills.id, skill.id));
      }

      // 沉淀工作记忆
      await db.insert(agentMemories).values({
        agentId: input.agentId,
        taskId,
        category: "设备特征",
        summary: gen.memorySummary,
      });

      // 更新计数
      await db
        .update(agents)
        .set({
          tasksCompleted: sql`${agents.tasksCompleted} + 1`,
          memoryCount: sql`${agents.memoryCount} + 1`,
        })
        .where(eq(agents.id, input.agentId));

      const [task] = await db
        .select()
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1);
      return task;
    }),

  /** 任务列表（按企业/工匠过滤） */
  list: publicQuery
    .input(
      z.object({
        enterpriseId: z.number().int().positive().optional(),
        agentId: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conds = [];
      if (input.enterpriseId) conds.push(eq(tasks.enterpriseId, input.enterpriseId));
      if (input.agentId) conds.push(eq(tasks.agentId, input.agentId));
      const rows = await db
        .select({
          task: tasks,
          agentName: agents.name,
          agentCode: agents.code,
          agentAvatar: agents.avatar,
        })
        .from(tasks)
        .leftJoin(agents, eq(tasks.agentId, agents.id))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(tasks.createdAt))
        .limit(input.limit);
      return rows.map((r) => ({
        ...r.task,
        agentName: r.agentName,
        agentCode: r.agentCode,
        agentAvatar: r.agentAvatar,
      }));
    }),

  /** 任务详情（含完整步骤与报告） */
  get: publicQuery
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [row] = await db
        .select({
          task: tasks,
          agentName: agents.name,
          agentCode: agents.code,
          agentAvatar: agents.avatar,
        })
        .from(tasks)
        .leftJoin(agents, eq(tasks.agentId, agents.id))
        .where(eq(tasks.id, input.id))
        .limit(1);
      if (!row) throw new Error(`任务 ${input.id} 不存在`);
      return {
        ...row.task,
        agentName: row.agentName,
        agentCode: row.agentCode,
        agentAvatar: row.agentAvatar,
      };
    }),
});
