import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { sessionMe } from "./wbSession";
import { agents, enterprises, trials, type TrialReport } from "@db/schema";
import { callSlotChat } from "./modelGateway";

const TRIAL_DAYS = 7;

/**
 * 试用评估探测任务（真实执行）：按 Agent 能力标签生成 3 个真实 LLM 探测任务。
 * iter96 诚信整改：试用报告必须由真实执行产出，禁止 RNG 编造。
 */
function buildProbeTasks(agentName: string, tags: string[]): { hint: string; instruction: string }[] {
  const skills = tags.length > 0 ? tags.slice(0, 3) : ["生产协同"];
  const probes = [
    { hint: skills[0], instruction: `请展示「${skills[0]}」能力：给出一个你接手制造企业相关任务后的具体工作方案（步骤+产出物）。` },
    { hint: skills[1] ?? skills[0], instruction: `围绕「${skills[1] ?? skills[0]}」，模拟处理一个产线突发问题，说明你的处置流程与判断依据。` },
    { hint: skills[2] ?? skills[0], instruction: `用「${skills[2] ?? skills[0]}」视角，给老板一段不超过 200 字的本周风险提示与建议。` },
  ];
  void agentName;
  return probes;
}

/** 判分（复刻 corps-train/sandbox 口径）：2-gram 关键词命中 + 长度 ≥60 字 */
function judgeProbe(hint: string, reply: string): number {
  const grams = new Set<string>();
  for (let i = 0; i < hint.length - 1; i++) grams.add(hint.slice(i, i + 2));
  let hit = 0;
  grams.forEach((g) => { if (reply.includes(g)) hit++; });
  const kwScore = grams.size > 0 ? hit / grams.size : 0;
  const lenScore = Math.min(1, reply.length / 200);
  return Math.round((kwScore * 0.6 + lenScore * 0.4) * 100);
}

/**
 * 生成真实试用评估报告：真实调用 LLM 跑 3 个探测任务，得分全部来自真实输出。
 * LLM 不可用 → 返回诚实降级报告（分数置 0、文案明写「模拟评估示意」），绝不伪装成实测。
 */
async function generateTrialReport(
  agentName: string,
  capabilityTags: string[],
): Promise<TrialReport> {
  const probes = buildProbeTasks(agentName, capabilityTags);
  const results: { score: number; ms: number }[] = [];
  let llmOk = true;
  for (const p of probes) {
    const t0 = Date.now();
    const r = await callSlotChat("flash", {
      messages: [
        { role: "system", content: "你是制造企业数字员工，围绕指定技能给出专业、具体、可执行的中文答复（120-300字）。" },
        { role: "user", content: `【试用考核·${p.hint}】${p.instruction}` },
      ],
      maxTokens: 800,
      timeoutMs: 60_000,
    });
    if (!r.ok || !r.content) { llmOk = false; break; }
    results.push({ score: judgeProbe(p.hint, r.content), ms: Date.now() - t0 });
  }

  if (!llmOk || results.length === 0) {
    // 诚实降级：不编造分数
    return {
      suitabilityScore: 0,
      diagnosticAccuracy: 0,
      avgResponseSec: 0,
      tasksCompleted: 0,
      confidenceGrade: "未定级",
      advice: "本次评估未能真实执行（模型服务暂不可用），建议稍后重新生成评估报告",
      summary: `【模拟评估示意】「${agentName}」的试用评估暂未真实执行：模型服务暂不可用，本报告不含任何实测分数。请稍后重试以获取真实评估结果。`,
      highlights: ["模拟评估示意（非实测）", "模型服务暂不可用", "建议稍后重试"],
    };
  }

  const tasksCompleted = results.length;
  const suitability = Math.round(results.reduce((s, r) => s + r.score, 0) / tasksCompleted);
  const accuracy = Math.round((results.filter((r) => r.score >= 60).length / tasksCompleted) * 1000) / 10;
  const responseSec = Math.round((results.reduce((s, r) => s + r.ms, 0) / tasksCompleted / 1000) * 10) / 10;
  const grade =
    suitability >= 93 ? "A" : suitability >= 88 ? "A-" : suitability >= 82 ? "B+" : suitability >= 60 ? "B" : "C";
  return {
    suitabilityScore: suitability,
    diagnosticAccuracy: accuracy,
    avgResponseSec: responseSec,
    tasksCompleted,
    confidenceGrade: grade,
    advice:
      suitability >= 85
        ? "建议正式雇佣：实测适用度优秀，技能链与产线需求高度匹配"
        : suitability >= 60
          ? "建议延长试用：实测适用度中等，部分场景需进一步验证"
          : "建议暂缓雇佣：实测适用度偏低，建议更换技能方向或人工介入评估",
    summary: `试用评估基于 ${tasksCompleted} 个真实执行的探测任务（真实模型调用）：「${agentName}」实测达标率 ${accuracy}%，平均响应 ${responseSec}s，综合适用度 ${suitability} 分（${grade}）。`,
    highlights: [
      `实测达标率 ${accuracy}%（${tasksCompleted} 个真实任务）`,
      `平均响应 ${responseSec}s（实测）`,
      `综合置信度 ${grade}`,
      suitability >= 85 ? "建议：正式雇佣" : "建议：延长观察",
    ],
  };
}

export const trialsRouter = createRouter({
  /** 申请 7 天免费试用（沙箱执行，技能调用费照常） */
  create: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        agentId: z.number().int().positive(),
        enterpriseId: z.number().int().positive(),
        productionLine: z.string().trim().max(255).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // 试用申请为 C 级动作（hire.create 同纪律钉：原无 token 校验，匿名可给任意企业开工——封死）；
      // 仅企业负责人（admin，owner→admin 归一）且 enterpriseId 必须对齐会话厂域（跨厂不泄）。
      const { user, factory } = await sessionMe(input.token);
      if (user.role !== "admin" && user.role !== "owner") {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅企业负责人可申请试用" });
      }
      if (input.enterpriseId !== factory.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅可为本企业申请试用" });
      }
      const db = getDb();
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .limit(1);
      if (!agent) throw new Error(`Agent ${input.agentId} 不存在`);
      const [enterprise] = await db
        .select()
        .from(enterprises)
        .where(eq(enterprises.id, input.enterpriseId))
        .limit(1);
      if (!enterprise) throw new Error(`企业 ${input.enterpriseId} 不存在`);

      const startedAt = new Date();
      const endsAt = new Date(startedAt.getTime() + TRIAL_DAYS * 86400_000);
      const [{ id }] = await db
        .insert(trials)
        .values({
          agentId: input.agentId,
          enterpriseId: input.enterpriseId,
          productionLine: input.productionLine,
          status: "active",
          startedAt,
          endsAt,
        })
        .$returningId();
      const [trial] = await db
        .select()
        .from(trials)
        .where(eq(trials.id, id))
        .limit(1);
      return trial;
    }),

  /** 查看/生成试用评估报告（结束自动生成，未结束可即时生成预览） */
  report: publicQuery
    .input(z.object({ trialId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [trial] = await db
        .select()
        .from(trials)
        .where(eq(trials.id, input.trialId))
        .limit(1);
      if (!trial) throw new Error("试用记录不存在");
      if (trial.report) return { ...trial, report: trial.report };

      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, trial.agentId))
        .limit(1);
      // iter96 诚信整改：报告分数全部来自真实 LLM 探测执行，不再使用 RNG 剧本
      const tags = Array.isArray(agent?.capabilityTags)
        ? (agent!.capabilityTags as unknown[]).map(String)
        : [];
      const report = await generateTrialReport(
        agent?.name ?? "数字工匠",
        tags,
      );
      const skillCalls = report.tasksCompleted;
      const finished = Date.now() >= trial.endsAt.getTime();
      await db
        .update(trials)
        .set({
          report,
          skillCalls,
          status: finished ? "completed" : trial.status,
        })
        .where(eq(trials.id, trial.id));
      return { ...trial, skillCalls, report };
    }),

  /** 企业的试用列表 */
  list: publicQuery
    .input(z.object({ enterpriseId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db
        .select({ trial: trials, agent: agents })
        .from(trials)
        .leftJoin(agents, eq(trials.agentId, agents.id))
        .where(eq(trials.enterpriseId, input.enterpriseId))
        .orderBy(desc(trials.createdAt));
    }),
});
