/**
 * #13 模型评测集与跑分器（彭总令 2026-09-02，技术债治理）：
 * 业务评测集（派单理解/汇报生成/预审判决 三套件，确定性评分规则）+
 * 跑分器（cron 每日或手动）→ st_model_evals 留档 + Prometheus 指标。
 * 换模型/调 prompt 后跑一轮，分数不够不上线——从此不靠手感。
 */
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { callSlotChat, SLOT_MODELS, type SlotId } from "./modelGateway";

interface EvalCase {
  key: string;
  slot: SlotId;
  prompt: string;
  /** 确定性评分：命中关键词给分（避免再调模型当裁判引递归） */
  expect: string[];
  forbid?: string[];
}

export const EVAL_SUITES: Record<string, EvalCase[]> = {
  /** 派单理解：能否从口语化需求里抽出确定任务 */
  dispatch: [
    {
      key: "dispatch-basic",
      slot: "flash",
      prompt: "把这句话转成一条任务标题（不超过20字）：帮我把下周三的产线巡检报告整理出来发给彭总",
      expect: ["巡检", "报告"],
      forbid: ["不确定", "无法"],
    },
    {
      key: "dispatch-factory",
      slot: "flash",
      prompt: "把这句话转成一条任务标题（不超过20字）：让采购舱跟进佛山那家五金厂的报价单",
      expect: ["报价", "五金"],
      forbid: ["不确定"],
    },
  ],
  /** 汇报生成：数字员工的日报是否像样 */
  report: [
    {
      key: "report-daily",
      slot: "chat",
      prompt: "你是数字员工，用两句话向老板汇报你今天完成了3张订单、词元入账59、无异常。",
      expect: ["3", "59"],
      forbid: ["编造", "大概"],
    },
  ],
  /** 预审判决：SDLC 预审对明显违规是否说 no */
  verdict: [
    {
      key: "verdict-refund",
      slot: "flash",
      prompt: "评审这个提案是否可以直接自动执行：'修改平台佣金结算规则并立刻生效'。只回答 pass 或 reject 加一句理由。",
      expect: ["reject"],
      forbid: ["pass。"],
    },
  ],
};

export interface EvalResult {
  suite: string;
  key: string;
  slot: SlotId;
  model: string;
  score: number;
  latencyMs: number;
  detail: string;
}

async function runCase(suite: string, c: EvalCase): Promise<EvalResult> {
  const started = Date.now();
  const r = await callSlotChat(c.slot, {
    messages: [{ role: "user", content: c.prompt }],
    maxTokens: 300,
    timeoutMs: 30_000,
    context: `eval:${suite}`,
  });
  const latencyMs = Date.now() - started;
  const model = r.model ?? SLOT_MODELS[c.slot].model;
  if (!r.ok || !r.content) {
    return { suite, key: c.key, slot: c.slot, model, score: 0, latencyMs, detail: `调用失败:${r.ok ? "空响应" : r.reason ?? "not_ok"}` };
  }
  const text = r.content.toLowerCase();
  const hits = c.expect.filter((k) => text.includes(k.toLowerCase())).length;
  const forbids = (c.forbid ?? []).filter((k) => text.includes(k.toLowerCase())).length;
  const score = Math.max(0, Math.round((hits / c.expect.length) * 100) - forbids * 30);
  return { suite, key: c.key, slot: c.slot, model, score, latencyMs, detail: r.content.slice(0, 200) };
}

export async function runEvalSuite(suite: string): Promise<EvalResult[]> {
  const cases = EVAL_SUITES[suite] ?? [];
  const results: EvalResult[] = [];
  for (const c of cases) {
    results.push(await runCase(suite, c));
  }
  // 留档（审计纪律：评测结果全量入库，失败也记）
  try {
    const db = getDb();
    for (const r of results) {
      await db
        .execute(
          sql`INSERT INTO st_model_evals (suite, case_key, slot, model, score, latency_ms, detail)
              VALUES (${r.suite}, ${r.key}, ${r.slot}, ${r.model}, ${r.score}, ${r.latencyMs}, ${r.detail.slice(0, 255)})`,
        )
        .catch(() => undefined);
    }
  } catch { /* 留档失败不阻塞评测 */ }
  return results;
}

export async function runAllSuites(): Promise<Record<string, EvalResult[]>> {
  const out: Record<string, EvalResult[]> = {};
  for (const suite of Object.keys(EVAL_SUITES)) {
    out[suite] = await runEvalSuite(suite);
  }
  return out;
}

// ─── 触发端点（HQ 限定）──────────────────────────────────────────────────────
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { sessionMe } from "./wbSession";

export const modelEvalRouter = createRouter({
  /** 手动跑一轮评测（HQ 限定；日常由 cron 每日自动跑） */
  run: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      suite: z.enum(["dispatch", "report", "verdict", "all"]).default("all"),
    }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      if (session.factory.id !== 6380240) {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅灵智枢成员可跑评测" });
      }
      if (input.suite === "all") return runAllSuites();
      return { [input.suite]: await runEvalSuite(input.suite) };
    }),

  /** 最近评测成绩（HQ 限定） */
  recent: publicQuery
    .input(z.object({ token: z.string().trim().min(1), limit: z.number().int().min(1).max(50).default(20) }))
    .query(async ({ input }) => {
      const session = await sessionMe(input.token);
      if (session.factory.id !== 6380240) {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅灵智枢成员" });
      }
      const db = getDb();
      const rows = (await db.execute(
        sql`SELECT suite, case_key, slot, model, score, latency_ms, created_at FROM st_model_evals ORDER BY id DESC LIMIT ${input.limit}`,
      )) as unknown as { rows?: any[] };
      return { items: rows };
    }),
});
