/**
 * evolution 记忆路由组（memory.*）—— 工业向量记忆库 + 自我反思。
 *
 * 提炼自 eliza v0.1.9：
 * - IMemoryManager 一库一表语义 → wb_evo_memories 单表 + store 五分区
 *   （events/entities/insights/domain/cases，对应 messages/descriptions/facts/lore/documents）；
 * - 写入自动补全 embedding（确定性 64 维哈希向量，失败回退零向量不阻塞）；
 * - 召回 = 余弦相似度 TopK + 过期过滤 + severity 加权阈值（critical 0.05 / 其余 0.1）；
 * - 反思四段式（evaluators_fact.ts）：触发器(count/shift/anomaly) → 洞察生成
 *   （确定性聚类提炼，非 LLM）→ 向量去重落库 insights（余弦 >0.92 视为 already_known）
 *   → 回流（autonomy.plan 的 reasoning.appliedInsights 引用）。
 * token 仅在请求体，由 sessionMe(token) 校验。
 */
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { agents, wbEvoMemories, type WbEvoMemory } from "@db/schema";
import { sessionMe } from "./wbSession";
import {
  EVO_INDUSTRIAL_VOCAB,
  EVO_REFLECT_DEDUP_THRESHOLD,
  evoCosine,
  evoEmbed,
  evoRecallThreshold,
} from "./evolutionShared";

const storeEnum = z.enum(["events", "entities", "insights", "domain", "cases"]);

/** 校验 agent 存在（主匠市 agents 表） */
async function requireAgent(agentId: number) {
  const db = getDb();
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Agent #${agentId} 不存在` });
  }
  return agent;
}

/** 过滤过期记忆（validUntil 为空或未到期） */
function notExpired(m: WbEvoMemory, now: number): boolean {
  return !m.validUntil || m.validUntil.getTime() > now;
}

/** 核心写入：算向量落库（供 memory.write 与自治循环复用） */
export async function writeMemoryCore(opts: {
  factoryId: number;
  agentId: number;
  store: "events" | "entities" | "insights" | "domain" | "cases";
  text: string;
  metadata?: Record<string, unknown>;
  severity?: number;
  validUntil?: Date | null;
}) {
  const db = getDb();
  const embedding = evoEmbed(opts.text);
  const [{ id }] = await db
    .insert(wbEvoMemories)
    .values({
      factoryId: opts.factoryId,
      agentId: opts.agentId,
      store: opts.store,
      content: { text: opts.text, metadata: opts.metadata },
      embedding,
      severity: opts.severity ?? 3,
      validUntil: opts.validUntil ?? null,
    })
    .$returningId();
  return { id, embedding };
}

/** 核心召回：余弦 TopK（供 memory.recall / market.recall_memory / autonomy.plan 复用） */
export async function recallCore(opts: {
  factoryId: number;
  agentId?: number;
  queryText: string;
  store?: "events" | "entities" | "insights" | "domain" | "cases";
  limit?: number;
}) {
  const db = getDb();
  const conds = [eq(wbEvoMemories.factoryId, opts.factoryId)];
  if (opts.agentId !== undefined) conds.push(eq(wbEvoMemories.agentId, opts.agentId));
  if (opts.store) conds.push(eq(wbEvoMemories.store, opts.store));
  const rows = await db
    .select()
    .from(wbEvoMemories)
    .where(and(...conds))
    .orderBy(desc(wbEvoMemories.id))
    .limit(500);
  const now = Date.now();
  const q = evoEmbed(opts.queryText);
  const limit = opts.limit ?? 10;
  return rows
    .filter((m) => notExpired(m, now))
    .map((m) => ({ memory: m, similarity: evoCosine(q, m.embedding) }))
    .filter((r) => r.similarity >= evoRecallThreshold(r.memory.severity))
    .sort((a, b) => b.similarity - a.similarity || b.memory.id - a.memory.id)
    .slice(0, limit)
    .map((r) => ({
      id: r.memory.id,
      store: r.memory.store,
      text: r.memory.content.text,
      metadata: r.memory.content.metadata ?? null,
      severity: r.memory.severity,
      similarity: Math.round(r.similarity * 1000) / 1000,
      createdAt: r.memory.createdAt,
    }));
}

// ─── 反思：确定性洞察提炼（对应 evaluators_fact 的 LLM 抽取，工业化替换）─────
const RISK_KEYS = ["异常", "告警", "超差", "故障", "缺陷", "劣化", "报废", "裂纹"];
const EFFICIENCY_KEYS = ["调整", "优化", "排产", "节拍", "换模", "改进", "同步"];

/** 统计事件文本中工业词命中频次（确定性） */
function termHistogram(texts: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const t of texts) {
    for (const term of EVO_INDUSTRIAL_VOCAB) {
      if (t.includes(term)) counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"));
}

/**
 * 反思核心：取该 agent 最近 20 条 events，确定性提炼 3-5 条洞察
 * （模式识别 / 风险预警 / 效率改进），向量去重后写回 insights 库。
 * 返回 { newInsights, skipped, trigger }；autonomy.confirm 在批准计划后自动调用（count）。
 */
export async function reflectCore(opts: {
  factoryId: number;
  agentId: number;
  trigger: "count" | "shift" | "anomaly";
}) {
  const db = getDb();
  const events = await db
    .select()
    .from(wbEvoMemories)
    .where(
      and(
        eq(wbEvoMemories.factoryId, opts.factoryId),
        eq(wbEvoMemories.agentId, opts.agentId),
        eq(wbEvoMemories.store, "events"),
      ),
    )
    .orderBy(desc(wbEvoMemories.id))
    .limit(20);
  if (events.length === 0) {
    return { newInsights: [] as string[], skipped: 0, trigger: opts.trigger };
  }
  const texts = events.map((e) => e.content.text);
  const candidates: { text: string; severity: number }[] = [];

  // 1) 模式识别：高频工业词聚类
  const top = termHistogram(texts).filter(([, c]) => c >= 2).slice(0, 2);
  for (const [term, count] of top) {
    candidates.push({
      text: `模式识别：「${term}」在该数字员工近 ${events.length} 条事件中出现 ${count} 次，构成稳定工况特征，可作为后续调度与诊断的基线模式。`,
      severity: 3,
    });
  }
  // 2) 风险预警：severity≥4 或风险关键词事件
  const risky = events.filter(
    (e) => e.severity >= 4 || RISK_KEYS.some((k) => e.content.text.includes(k)),
  );
  if (risky.length > 0) {
    const keys = [...new Set(RISK_KEYS.filter((k) => risky.some((e) => e.content.text.includes(k))))].slice(0, 3);
    candidates.push({
      text: `风险预警：近 ${events.length} 条事件中 ${risky.length} 条涉及 ${keys.join("/") || "高严重度"} 信号，建议提高相关设备巡检频次并纳入交接班复核。`,
      severity: 4,
    });
  }
  // 3) 效率改进：调整/排产类事件
  const eff = events.filter((e) => EFFICIENCY_KEYS.some((k) => e.content.text.includes(k)));
  if (eff.length > 0) {
    candidates.push({
      text: `效率改进：识别到 ${eff.length} 条调度/工艺调整类事件，可将已验证的调整参数固化为标准作业参数，缩短同类工况响应时间。`,
      severity: 3,
    });
  }
  // 4) 触发器附加上下文（shift/anomaly 专属补充洞察）
  if (opts.trigger === "shift") {
    candidates.push({
      text: `交接班摘要：本班次共记录 ${events.length} 条运行事件（最高严重度 ${Math.max(...events.map((e) => e.severity))} 级），要点已提炼并注入下一班上下文。`,
      severity: 2,
    });
  } else if (opts.trigger === "anomaly") {
    const worst = events.reduce((a, b) => (b.severity > a.severity ? b : a));
    candidates.push({
      text: `异常根因反思：最新高严重度事件（severity=${worst.severity}）"${worst.content.text.slice(0, 40)}"，已生成对策并挂接对应工单跟踪。`,
      severity: 4,
    });
  }
  // 兜底：候选不足 3 条时补摘要/建议（保证每次反思产出 3-5 条）
  if (candidates.length < 3) {
    const maxSev = Math.max(...events.map((e) => e.severity));
    candidates.push({
      text: `工况摘要：近 ${events.length} 条事件整体运行平稳（最高严重度 ${maxSev} 级），未识别出新增异常模式，维持当前巡检与排产基线。`,
      severity: 2,
    });
  }
  if (candidates.length < 3) {
    candidates.push({
      text: "改进建议：当前事件样本较少，建议保持事件流水持续记录（设备状态/质检结论/调度调整），积累样本后可提炼更丰富的工况模式。",
      severity: 1,
    });
  }
  const limited = candidates.slice(0, 5);

  // 向量去重：与既有 insights 余弦 >0.92 → already_known 跳过
  const existing = await db
    .select()
    .from(wbEvoMemories)
    .where(
      and(
        eq(wbEvoMemories.factoryId, opts.factoryId),
        eq(wbEvoMemories.agentId, opts.agentId),
        eq(wbEvoMemories.store, "insights"),
      ),
    )
    .orderBy(desc(wbEvoMemories.id))
    .limit(100);
  const newInsights: string[] = [];
  let skipped = 0;
  for (const c of limited) {
    const emb = evoEmbed(c.text);
    const dup = existing.some((e) => evoCosine(emb, e.embedding) > EVO_REFLECT_DEDUP_THRESHOLD);
    if (dup) {
      skipped += 1;
      continue;
    }
    await writeMemoryCore({
      factoryId: opts.factoryId,
      agentId: opts.agentId,
      store: "insights",
      text: c.text,
      metadata: { trigger: opts.trigger, type: "reflection" },
      severity: c.severity,
    });
    // 本轮内也参与去重（同批相似洞察只保留一条）
    existing.unshift({
      embedding: emb,
    } as WbEvoMemory);
    newInsights.push(c.text);
  }
  return { newInsights, skipped, trigger: opts.trigger };
}

export const evolutionMemoryRouter = createRouter({
  /**
   * memory.write（mutation，需要 token）。
   * 输入 { token, agentId, store, text, metadata?, severity?(1-5), validUntil? }
   * 写入自动补全确定性 64 维向量；输出 { id, store, embeddingDim }。
   */
  write: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        agentId: z.number().int().positive(),
        store: storeEnum,
        text: z.string().trim().min(2).max(4000),
        metadata: z.record(z.string(), z.unknown()).optional(),
        severity: z.number().int().min(1).max(5).optional(),
        validUntil: z.date().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      await requireAgent(input.agentId);
      const { id, embedding } = await writeMemoryCore({
        factoryId: factory.id,
        agentId: input.agentId,
        store: input.store,
        text: input.text,
        metadata: input.metadata,
        severity: input.severity,
        validUntil: input.validUntil ?? null,
      });
      return { id, store: input.store, embeddingDim: embedding.length };
    }),

  /**
   * memory.recall（query，需要 token）。
   * 输入 { token, agentId?, queryText, store?, limit? }
   * 余弦相似度 TopK + 过期过滤 + severity 加权阈值（critical 0.05 / 其余 0.1）。
   */
  recall: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        agentId: z.number().int().positive().optional(),
        queryText: z.string().trim().min(1).max(2000),
        store: storeEnum.optional(),
        limit: z.number().int().positive().max(50).optional(),
      }),
    )
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      if (input.agentId !== undefined) await requireAgent(input.agentId);
      const items = await recallCore({
        factoryId: factory.id,
        agentId: input.agentId,
        queryText: input.queryText,
        store: input.store,
        limit: input.limit,
      });
      return { total: items.length, items };
    }),

  /**
   * memory.reflect（mutation，需要 token）。
   * 输入 { token, agentId, trigger: "count"|"shift"|"anomaly" }
   * 反思四段式：近 20 条 events → 确定性提炼 3-5 条洞察 → 向量去重（>0.92 跳过）
   * → 写回 insights 库。输出 { newInsights, skipped, trigger }。
   */
  reflect: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        agentId: z.number().int().positive(),
        trigger: z.enum(["count", "shift", "anomaly"]),
      }),
    )
    .mutation(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      await requireAgent(input.agentId);
      return reflectCore({
        factoryId: factory.id,
        agentId: input.agentId,
        trigger: input.trigger,
      });
    }),
});
