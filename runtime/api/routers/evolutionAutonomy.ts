/**
 * evolution 自主循环路由组（autonomy.*）—— 自主规划 + 30 秒人工确认门 + 信任等级。
 *
 * 提炼自 OpenTruthV1 节拍循环（感知→召回→决策→执行→回写）与 eliza 反思回流，
 * 工业化加入"人工确认门"治理：
 * - plan：recall 记忆 + insights 写入 reasoning.appliedInsights（反思回流闭环），
 *   确定性生成 4-6 步调度表；豁免判定：goal 命中白名单（传感器自动校准/传感器标定）
 *   且 trustLevel≥2 → exempted_auto，否则 awaiting_confirm + confirmDeadline=now+30s；
 * - confirm：仅 awaiting_confirm 未超时可审批；approve→executing→done + 连批+1 +
 *   升级判定（L0→L1:3 / L1→L2:10 / L2→L3:30 连批）+ 写 events 记忆 + 自动 count 反思；
 *   reject→rejected + 连批清零；
 * - tick：惰性结算超时计划为 expired_rejected（连批清零），返回最新 15 计划 + 信任表。
 * 全确定性（调度表无随机）；token 仅在请求体。
 */
import { z } from "zod";
import { and, count, desc, eq, inArray, lte } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import {
  agents,
  wbEvoMemories,
  wbEvoPlans,
  wbEvoTrust,
  type WbEvoPlanStep,
  type WbEvoTrust,
} from "@db/schema";
import { sessionMe } from "./wbSession";
import { recallCore, reflectCore, writeMemoryCore } from "./evolutionMemory";
import { callModelChat, callSlotChat } from "./modelGateway";

/** 豁免白名单（仅当 goal 命中且 trustLevel≥2 方可自动执行） */
const EXEMPTION_WHITELIST = ["传感器自动校准", "传感器标定"] as const;

/** 信任升级阈值：当前等级 → 升至下一级所需连续批准数 */
const LEVEL_UP_THRESHOLDS: Record<number, number> = { 0: 3, 1: 10, 2: 30 };

async function requireAgent(agentId: number) {
  const db = getDb();
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Agent #${agentId} 不存在` });
  }
  return agent;
}

/** 取/建信任账本（每 agent 一行） */
async function getOrCreateTrust(agentId: number): Promise<WbEvoTrust> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(wbEvoTrust)
    .where(eq(wbEvoTrust.agentId, agentId))
    .limit(1);
  if (row) return row;
  const [{ id }] = await db
    .insert(wbEvoTrust)
    .values({ agentId, level: 0, consecutiveApprovals: 0, totalPlans: 0, history: [] })
    .$returningId();
  const [created] = await db
    .select()
    .from(wbEvoTrust)
    .where(eq(wbEvoTrust.id, id))
    .limit(1);
  return created;
}

/** 追加信任账本历史并更新计数 */
async function updateTrust(
  trust: WbEvoTrust,
  patch: { level?: number; consecutiveApprovals?: number; totalPlans?: number },
  event: string,
) {
  const db = getDb();
  const level = patch.level ?? trust.level;
  const consecutiveApprovals = patch.consecutiveApprovals ?? trust.consecutiveApprovals;
  const totalPlans = patch.totalPlans ?? trust.totalPlans;
  const history = [
    ...trust.history,
    { at: new Date().toISOString(), event, level, consecutiveApprovals },
  ].slice(-50);
  await db
    .update(wbEvoTrust)
    .set({ level, consecutiveApprovals, totalPlans, history, updatedAt: new Date() })
    .where(eq(wbEvoTrust.id, trust.id));
  return { level, consecutiveApprovals, totalPlans };
}

// ─── 确定性调度表生成（4-6 步，无随机）───────────────────────────────────────
function extractDevice(goal: string): string {
  const m = goal.match(/(\d+\s*号\s*(CNC|cnc|机床|产线)|CNC-\d+)/i);
  return m ? m[0].replace(/\s+/g, " ") : "CNC-03";
}

function buildSchedule(goal: string): WbEvoPlanStep[] {
  const device = extractDevice(goal);
  const steps: WbEvoPlanStep[] = [
    {
      seq: 1,
      action: "workbench.read_sensor",
      target: device,
      rationale: "采集目标设备基线快照，作为后续判断依据",
      durationMs: 800,
      riskLevel: "low",
    },
  ];
  if (/振动|异常|诊断|故障|劣化/.test(goal)) {
    steps.push({
      seq: 0,
      action: "market.recall_memory",
      target: "insights/cases 记忆库",
      rationale: "召回历史故障案例与既有洞察，避免重复试错",
      durationMs: 600,
      riskLevel: "low",
    });
  }
  if (/质检|检验|测量|焊缝|缺陷/.test(goal)) {
    steps.push({
      seq: 0,
      action: "workbench.dispatch_task",
      target: "质检班组",
      rationale: "下发质检复核工单，闭环质量判定",
      durationMs: 2400,
      riskLevel: "medium",
    });
  }
  if (/排产|调度|计划|工单/.test(goal)) {
    steps.push({
      seq: 0,
      action: "workbench.dispatch_task",
      target: "排产系统",
      rationale: "同步排产调整，降低交期影响",
      durationMs: 2100,
      riskLevel: "medium",
    });
  }
  if (/校准|标定|传感器/.test(goal)) {
    steps.push({
      seq: 0,
      action: "workbench.dispatch_task",
      target: device,
      rationale: "下发标定参数并复核零漂，命中豁免白名单动作",
      durationMs: 1800,
      riskLevel: "medium",
    });
  }
  // 通用补齐：若条件步不足 2 个，补一条记忆召回（保证 4-6 步）
  if (steps.length < 3) {
    steps.push({
      seq: 0,
      action: "market.recall_memory",
      target: "events 记忆库",
      rationale: "召回相关运行事件，为调度提供上下文",
      durationMs: 500,
      riskLevel: "low",
    });
  }
  steps.push({
    seq: 0,
    action: "workbench.dispatch_task",
    target: device,
    rationale: "汇总执行业务动作并登记事件流水（两段式，等待班组确认）",
    durationMs: 1500,
    riskLevel: "medium",
  });
  steps.push({
    seq: 0,
    action: "gateway.heartbeat",
    target: device,
    rationale: "网关回执校验，确认链路在线后闭环",
    durationMs: 300,
    riskLevel: "low",
  });
  const trimmed = steps.slice(0, 6);
  trimmed.forEach((s, i) => (s.seq = i + 1));
  return trimmed;
}

/**
 * buildPlanLlmNote —— 用 LLM 为调度计划生成一段自然语言解释（附加元数据）。
 * 失败/未配置静默返回 null；绝不影响状态机确定性。
 */
export async function buildPlanLlmNote(input: {
  goal: string;
  stepCount: number;
  appliedInsights: number;
}): Promise<{ content: string; label: string } | null> {
  const slotRes = await callSlotChat("flash", {
    messages: [
      {
        role: "system",
        content:
          "你是 NumX Max 工业调度解释器。用不超过 80 字的中文，向工厂主管解释给定排程计划的调度依据与注意事项。只基于输入信息，不得编造数据，不得使用金融/社交词汇，语气专业克制。",
      },
      {
        role: "user",
        content: `计划目标：${input.goal}\n排程步数：${input.stepCount}\n命中历史反思洞察：${input.appliedInsights} 条`,
      },
    ],
    maxTokens: 200,
    temperature: 0.2,
    timeoutMs: 12_000,
  });
  const res = slotRes.ok
    ? slotRes
    : await callModelChat({
        messages: [
          {
            role: "system",
            content:
              "你是 NumX Max 工业调度解释器。用不超过 80 字的中文，向工厂主管解释给定排程计划的调度依据与注意事项。只基于输入信息，不得编造数据，不得使用金融/社交词汇，语气专业克制。",
          },
          {
            role: "user",
            content: `计划目标：${input.goal}\n排程步数：${input.stepCount}\n命中历史反思洞察：${input.appliedInsights} 条`,
          },
        ],
        maxTokens: 200,
        temperature: 0.2,
        timeoutMs: 12_000,
      });
  if (!res.ok || !res.content) return null;
  return { content: res.content, label: res.providerLabel ?? "LLM" };
}

/** 惰性结算：本 factory 超时 awaiting_confirm → expired_rejected（连批清零） */
async function settleExpired(factoryId: number): Promise<number> {
  const db = getDb();
  const expired = await db
    .select()
    .from(wbEvoPlans)
    .where(
      and(
        eq(wbEvoPlans.factoryId, factoryId),
        eq(wbEvoPlans.status, "awaiting_confirm"),
        lte(wbEvoPlans.confirmDeadline, new Date()),
      ),
    );
  let settled = 0;
  for (const plan of expired) {
    await db
      .update(wbEvoPlans)
      .set({ status: "expired_rejected", updatedAt: new Date() })
      .where(
        and(eq(wbEvoPlans.id, plan.id), eq(wbEvoPlans.status, "awaiting_confirm")),
      );
    const trust = await getOrCreateTrust(plan.agentId);
    if (trust.consecutiveApprovals !== 0) {
      await updateTrust(trust, { consecutiveApprovals: 0 }, `计划 ${plan.planId} 超时未确认，连批清零`);
    }
    settled += 1;
  }
  return settled;
}

export const evolutionAutonomyRouter = createRouter({
  /**
   * autonomy.plan（mutation，需要 token）。
   * 输入 { token, agentId, goal, devDeadlineSec?(≥1，默认 30) }。
   * recall 记忆 + insights 写入 reasoning.appliedInsights；确定性生成 4-6 步调度；
   * 白名单（传感器自动校准/传感器标定）且 trustLevel≥2 → exempted_auto；
   * 否则 awaiting_confirm + confirmDeadline=now+devDeadlineSec（默认 30s）。
   */
  plan: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        agentId: z.number().int().positive(),
        goal: z.string().trim().min(4).max(500),
        devDeadlineSec: z.number().int().min(1).max(3600).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { factory } = await sessionMe(input.token);
      await requireAgent(input.agentId);
      const trust = await getOrCreateTrust(input.agentId);

      // 反思回流：召回相关记忆 + 既有 insights 注入 reasoning
      const recalled = await recallCore({
        factoryId: factory.id,
        agentId: input.agentId,
        queryText: input.goal,
        limit: 3,
      });
      const insightRows = await db
        .select()
        .from(wbEvoMemories)
        .where(
          and(
            eq(wbEvoMemories.factoryId, factory.id),
            eq(wbEvoMemories.agentId, input.agentId),
            eq(wbEvoMemories.store, "insights"),
          ),
        )
        .orderBy(desc(wbEvoMemories.id))
        .limit(3);
      const appliedInsights = insightRows.map((r) => r.content.text);

      const schedule = buildSchedule(input.goal);
      const reasoning = {
        summary: `目标「${input.goal}」拆解为 ${schedule.length} 步调度；召回 ${recalled.length} 条相关记忆，应用 ${appliedInsights.length} 条既有洞察。`,
        appliedInsights,
      };
      // LLM 自然语言解释（附加元数据；失败静默跳过，不改变任何状态机字段）
      const llmNote = await buildPlanLlmNote({
        goal: input.goal,
        stepCount: schedule.length,
        appliedInsights: appliedInsights.length,
      });
      if (llmNote) {
        (reasoning as Record<string, unknown>).llmNote = llmNote.content;
        (reasoning as Record<string, unknown>).llmGeneratedBy = llmNote.label;
      }

      const exempt =
        EXEMPTION_WHITELIST.some((k) => input.goal.includes(k)) && trust.level >= 2;
      const deadlineSec = input.devDeadlineSec ?? 30;
      const status = exempt ? ("exempted_auto" as const) : ("awaiting_confirm" as const);
      const confirmDeadline = exempt ? null : new Date(Date.now() + deadlineSec * 1000);

      // planId 确定性序号（PLN-<factoryId>-<n>），冲突递增重试
      const [countRow] = await db
        .select({ c: count() })
        .from(wbEvoPlans)
        .where(eq(wbEvoPlans.factoryId, factory.id));
      let seq = Number(countRow.c) + 1;
      let planId = `PLN-${factory.id}-${seq}`;
      let inserted = false;
      for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
        try {
          await db.insert(wbEvoPlans).values({
            planId,
            factoryId: factory.id,
            agentId: input.agentId,
            goal: input.goal,
            schedule,
            reasoning,
            status,
            confirmDeadline,
            trustLevel: trust.level,
          });
          inserted = true;
        } catch {
          seq += 1;
          planId = `PLN-${factory.id}-${seq}`;
        }
      }
      if (!inserted) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "planId 分配失败" });
      }
      await updateTrust(trust, { totalPlans: trust.totalPlans + 1 }, `创建计划 ${planId}`);

      return {
        planId,
        status,
        goal: input.goal,
        schedule,
        reasoning,
        trustLevel: trust.level,
        confirmDeadline,
        message: exempt
          ? `目标命中豁免白名单且信任等级 L${trust.level}≥2，已自动执行（exempted_auto），全程留痕可审计。`
          : `已生成 ${schedule.length} 步调度计划 ${planId}，等待人工确认（${deadlineSec} 秒内），超时自动驳回（两段式，不即时生效）。`,
      };
    }),

  /**
   * autonomy.confirm（mutation，需要 token）。
   * 输入 { token, planId, decision: "approve"|"reject" }；仅 awaiting_confirm 未超时。
   */
  confirm: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        planId: z.string().trim().min(3).max(64),
        decision: z.enum(["approve", "reject"]),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { factory } = await sessionMe(input.token);
      await settleExpired(factory.id);
      const [plan] = await db
        .select()
        .from(wbEvoPlans)
        .where(
          and(eq(wbEvoPlans.planId, input.planId), eq(wbEvoPlans.factoryId, factory.id)),
        )
        .limit(1);
      if (!plan) {
        throw new TRPCError({ code: "NOT_FOUND", message: `计划 ${input.planId} 不存在` });
      }
      if (plan.status !== "awaiting_confirm") {
        return {
          ok: false as const,
          planId: plan.planId,
          status: plan.status,
          message: `Error: 计划 ${plan.planId} 当前为 ${plan.status}，仅 awaiting_confirm 且未超时可审批。`,
        };
      }
      const trust = await getOrCreateTrust(plan.agentId);

      if (input.decision === "reject") {
        await db
          .update(wbEvoPlans)
          .set({ status: "rejected", updatedAt: new Date() })
          .where(eq(wbEvoPlans.id, plan.id));
        const t = await updateTrust(trust, { consecutiveApprovals: 0 }, `计划 ${plan.planId} 被驳回，连批清零`);
        return {
          ok: true as const,
          planId: plan.planId,
          status: "rejected" as const,
          trustLevel: t.level,
          consecutiveApprovals: t.consecutiveApprovals,
          message: `已驳回计划 ${plan.planId}，调度终止；该数字员工连续批准计数已清零。`,
        };
      }

      // approve → executing → done（确定性即时闭环）
      await db
        .update(wbEvoPlans)
        .set({ status: "executing", updatedAt: new Date() })
        .where(eq(wbEvoPlans.id, plan.id));
      await db
        .update(wbEvoPlans)
        .set({ status: "done", updatedAt: new Date() })
        .where(eq(wbEvoPlans.id, plan.id));

      // 连批 +1 与升级判定（L0→L1:3，L1→L2:10，L2→L3:30）
      const nextConsec = trust.consecutiveApprovals + 1;
      const threshold = LEVEL_UP_THRESHOLDS[trust.level];
      const leveledUp = threshold !== undefined && nextConsec >= threshold;
      const nextLevel = leveledUp ? trust.level + 1 : trust.level;
      const t = await updateTrust(
        trust,
        { level: nextLevel, consecutiveApprovals: nextConsec },
        leveledUp
          ? `计划 ${plan.planId} 批准，连续批准 ${nextConsec} 次，信任升级 L${trust.level}→L${nextLevel}`
          : `计划 ${plan.planId} 批准，连续批准 ${nextConsec} 次`,
      );

      // 执行回写 events 记忆 + 自动触发 count 反思
      await writeMemoryCore({
        factoryId: factory.id,
        agentId: plan.agentId,
        store: "events",
        text: `计划 ${plan.planId} 已批准并执行完成：「${plan.goal}」共 ${plan.schedule.length} 步（${plan.schedule.map((s) => s.action).join(" → ")}）。`,
        metadata: { planId: plan.planId, action: "autonomy.confirm" },
        severity: 2,
      });
      const reflection = await reflectCore({
        factoryId: factory.id,
        agentId: plan.agentId,
        trigger: "count",
      });

      return {
        ok: true as const,
        planId: plan.planId,
        status: "done" as const,
        executedSteps: plan.schedule.length,
        trustLevel: t.level,
        consecutiveApprovals: t.consecutiveApprovals,
        leveledUp,
        reflection,
        message: `计划 ${plan.planId} 已批准并执行完成（${plan.schedule.length} 步），结果已回写记忆库${leveledUp ? `，信任等级升至 L${t.level}` : ""}。`,
      };
    }),

  /**
   * autonomy.tick（query，需要 token）。
   * 惰性结算超时计划（expired_rejected + 连批清零），返回最新 15 计划 + 信任等级表。
   */
  tick: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const db = getDb();
      const { factory } = await sessionMe(input.token);
      const settled = await settleExpired(factory.id);
      const plans = await db
        .select()
        .from(wbEvoPlans)
        .where(eq(wbEvoPlans.factoryId, factory.id))
        .orderBy(desc(wbEvoPlans.id))
        .limit(15);
      const agentIds = [...new Set(plans.map((p) => p.agentId))];
      const trustRows = agentIds.length
        ? await db.select().from(wbEvoTrust).where(inArray(wbEvoTrust.agentId, agentIds))
        : [];
      return {
        settled,
        plans,
        trust: trustRows.map((t) => ({
          agentId: t.agentId,
          level: t.level,
          consecutiveApprovals: t.consecutiveApprovals,
          totalPlans: t.totalPlans,
        })),
      };
    }),

  /**
   * autonomy.get（query）—— 按 planId 查询计划详情。
   */
  get: publicQuery
    .input(z.object({ planId: z.string().trim().min(3).max(64) }))
    .query(async ({ input }) => {
      const db = getDb();
      const [plan] = await db
        .select()
        .from(wbEvoPlans)
        .where(eq(wbEvoPlans.planId, input.planId))
        .limit(1);
      if (!plan) {
        throw new TRPCError({ code: "NOT_FOUND", message: `计划 ${input.planId} 不存在` });
      }
      return plan;
    }),
});
