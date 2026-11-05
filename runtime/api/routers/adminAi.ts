/**
 * adminAi 路由 —— M7-e · S3 管理终端 AI 原生化（自己公司先吃狗粮）。
 *
 * 四块能力：
 * 1. dutyBriefing（灵枢值守台晨报）：聚合平台真实数据（待评审协议 / 开放信号 / 规划器运行 / 沉默企业 / 冻结企业），
 *    LLM 生成晨报，失败时规则降级并标注；
 * 2. dutyChat（管理员文字追问）：同一上下文 + 对话，只读问答，敏感串过滤；
 * 3. reviewCommand（自然语言评审指令）：「驳回 xxx，理由：…」→ LLM 结构化解析 → 复述预览
 *    → confirm=true 才真正执行（复用 gate 的 reviewProtocolCore/deprecateProtocolCore，
 *    评审流水 reviewer=ai-cmd:<admin> 可区分，权限照旧 requireAdmin）；
 * 4. plannerStats（规划器监管看板）：元意图计划量/状态分布/失败率 + 意图拒签（越权）按 actor 前缀分布。
 *
 * M8-b 快照引擎接入：
 * - dutyBriefing 快照优先（30 分钟有效，命中补 fromSnapshot:true），未命中走原逻辑并异步补写（自愈）；
 * - plannerStats 同样快照化（10 分钟有效）；
 * - dutyChat「先答后想」：响应扩展 facts（collectPlatformBrief 真实数据要点，同步生成、不依赖 LLM）；
 * - 向后兼容：响应只加字段（fromSnapshot/facts），旧字段语义不变。
 *
 * 铁律：本路由所有写动作与手工操作同权同流水；AI 只解析与复述，拍板的是 admin 本人（confirm）。
 */
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createRouter, publicQuery } from "../middleware";
import { requireAdmin, TEST_RESIDUE_LIKE } from "./terminal";
import { stQuery } from "./terminal";
import { callSlotChat, callSlotChatFast } from "./modelGateway";
import type { CallOpts, LlmCallResult } from "./modelGateway";

/** M8-a：flash 槽走双通道竞速+熔断路由；双败回落 {ok:false} 保持原契约（上层据此走规则降级） */
async function callFlash(opts: CallOpts): Promise<LlmCallResult> {
  try {
    const r = await callSlotChatFast("flash", opts);
    return r as unknown as LlmCallResult;
  } catch {
    // 竞速双败（或熔断全开）→ 回退原顺序链路，保持上层契约与可测性
    return callSlotChat("flash", opts);
  }
}
import { reviewProtocolCore, deprecateProtocolCore } from "./gate";
import { stripSecrets } from "./voice";
import { readSnapshot, refreshSnapshot, type SnapshotDraft } from "./snapshots";

/** M8-b：值守晨报快照有效期（30 分钟） */
export const DUTY_BRIEFING_SNAPSHOT_TTL_MS = 30 * 60 * 1000;
/** M8-b：规划器看板快照有效期（10 分钟） */
export const PLANNER_STATS_SNAPSHOT_TTL_MS = 10 * 60 * 1000;

// ─── 平台实况聚合（真实数据，晨报与追问共用）────────────────────────────────

export interface PlatformBrief {
  pendingProtocols: { code: string; name: string; level: string; status: string }[];
  openSignals24h: { levelB: number; levelC: number; levelD: number };
  plans: { total: number; today: number; executed: number; pendingConfirm: number; failed: number };
  silentFactories7d: { id: number; name: string }[];
  frozenFactories: number;
}

export async function collectPlatformBrief(): Promise<PlatformBrief> {
  const protocols = await stQuery(
    sql`SELECT code, name, level, status FROM st_protocols WHERE status IN ('draft','reviewing') ORDER BY code`,
  );
  const signals = await stQuery(
    sql`SELECT level, COUNT(*) AS c FROM st_auto_signals
        WHERE status = 'open' AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) GROUP BY level`,
  );
  const plansTotal = await stQuery(
    sql`SELECT COUNT(*) AS total,
               SUM(DATE(created_at) = CURDATE()) AS today,
               SUM(status = 'executed') AS executed,
               SUM(status = 'pending_confirm') AS pendingConfirm,
               SUM(status IN ('failed','rejected')) AS failed
        FROM st_intent_plans`,
  );
  // 沉默企业：有厂但 7 天内无任何意图（排除 TEST_ 演示厂与停用厂）
  const silent = await stQuery(
    sql`SELECT f.id, f.enterpriseName AS name FROM wb_factories f
        WHERE f.enterpriseName NOT LIKE ${TEST_RESIDUE_LIKE} AND f.disabled = 0 AND f.id NOT IN (
          SELECT DISTINCT factory_id FROM st_intents WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
        ) ORDER BY f.id DESC LIMIT 5`,
  );
  // 冻结企业：最近一次冻结事件后无完整解冻序列（按 freeze/unfreeze 净额近似）
  const frozen = await stQuery(
    sql`SELECT factory_id,
               SUM(action = 'freeze') AS fz, SUM(action = 'unfreeze') AS ufz
        FROM st_freeze_events GROUP BY factory_id HAVING fz > ufz`,
  );
  const num = (v: unknown) => Number(v ?? 0) || 0;
  const sig = { levelB: 0, levelC: 0, levelD: 0 };
  for (const r of signals) {
    const lv = String(r.level);
    if (lv === "B") sig.levelB = num(r.c);
    if (lv === "C") sig.levelC = num(r.c);
    if (lv === "D") sig.levelD = num(r.c);
  }
  const p0 = (plansTotal[0] ?? {}) as Record<string, unknown>;
  return {
    pendingProtocols: protocols.map((r) => ({
      code: String(r.code),
      name: String(r.name),
      level: String(r.level),
      status: String(r.status),
    })),
    openSignals24h: sig,
    plans: {
      total: num(p0.total),
      today: num(p0.today),
      executed: num(p0.executed),
      pendingConfirm: num(p0.pendingConfirm),
      failed: num(p0.failed),
    },
    silentFactories7d: silent.map((r) => ({ id: Number(r.id), name: String(r.name) })),
    frozenFactories: frozen.length,
  };
}

export function briefToContext(b: PlatformBrief): string {
  const protocolLine =
    b.pendingProtocols.length > 0
      ? b.pendingProtocols.map((p) => `${p.code}（${p.name}，${p.level}级，${p.status}）`).join("、")
      : "无";
  return (
    `【平台实况（真实数据，禁止编造其他数字）】\n` +
    `待评审协议：${protocolLine}\n` +
    `24h 开放信号：B级 ${b.openSignals24h.levelB} 条，C级 ${b.openSignals24h.levelC} 条，D级 ${b.openSignals24h.levelD} 条\n` +
    `集群规划：累计 ${b.plans.total} 个计划（今日 ${b.plans.today}），已执行 ${b.plans.executed}，` +
    `子步骤待确认 ${b.plans.pendingConfirm}，失败/拒签 ${b.plans.failed}\n` +
    `沉默企业（7天无意图）：${b.silentFactories7d.length > 0 ? b.silentFactories7d.map((f) => f.name).join("、") : "无"}\n` +
    `冻结中企业：${b.frozenFactories} 家`
  );
}

// ─── LLM 助手 ────────────────────────────────────────────────────────────────

const DUTY_PERSONA =
  "你是灵枢，NumX Max 平台的值守参谋长，在 S3 超级终端为平台管理员值班。" +
  "风格：沉稳、简短、先结论后依据，军事化早报口吻（晨报分『待办/风险/建议』三段）。" +
  "只引用给定实况数据，禁止编造；回复绝不出现任何编号类敏感串。";

async function callDutyLlm(userPrompt: string): Promise<string | null> {
  const r = await callFlash({
    messages: [
      { role: "system", content: DUTY_PERSONA },
      { role: "user", content: userPrompt },
    ],
    maxTokens: 500,
    temperature: 0.5,
    timeoutMs: 45_000,
  });
  if (!r.ok) return null;
  return stripSecrets(String((r as { content?: string }).content ?? "").trim()) || null;
}

/** 规则降级晨报（LLM 不可用时，标注降级） */
function ruleBriefing(b: PlatformBrief): string {
  const todos: string[] = [];
  if (b.pendingProtocols.length > 0) todos.push(`待评审协议 ${b.pendingProtocols.length} 个：${b.pendingProtocols.map((p) => p.code).join("、")}`);
  if (b.plans.pendingConfirm > 0) todos.push(`${b.plans.pendingConfirm} 个计划的 C 级子步骤等待企业确认`);
  const risks: string[] = [];
  if (b.openSignals24h.levelD > 0) risks.push(`D 级未决信号 ${b.openSignals24h.levelD} 条（必须人工拍板）`);
  if (b.openSignals24h.levelC > 0) risks.push(`C 级开放信号 ${b.openSignals24h.levelC} 条`);
  if (b.frozenFactories > 0) risks.push(`${b.frozenFactories} 家企业处于冻结态`);
  const suggest: string[] = [];
  if (b.silentFactories7d.length > 0) suggest.push(`沉默企业 ${b.silentFactories7d.length} 家（${b.silentFactories7d.map((f) => f.name).join("、")}），建议唤醒跟进`);
  if (todos.length === 0 && risks.length === 0) return "【晨报·规则降级】平台平稳：无待评审协议、无 C/D 级开放信号。可趁窗口期沉淀行业协议集。";
  return (
    `【晨报·规则降级】\n【待办】${todos.join("；") || "无"}\n【风险】${risks.join("；") || "无"}\n【建议】${suggest.join("；") || "例行巡检即可"}`
  );
}

// ─── NL 评审指令解析 ─────────────────────────────────────────────────────────

export interface ParsedReviewCommand {
  action: "approve" | "reject" | "deprecate";
  code: string;
  comment: string | null;
}

export async function parseReviewCommand(command: string, knownCodes: string[]): Promise<ParsedReviewCommand> {
  const sys =
    `你是协议评审台的指令解析器。把管理员的自然语言评审指令解析为结构化动作。\n` +
    `已知协议 code：${knownCodes.join("、") || "（空）"}\n` +
    `输出严格 JSON：{"action":"approve|reject|deprecate","code":"协议code","comment":"理由或null"}\n` +
    `规则：通过/批准/上线→approve；驳回/拒绝/打回→reject；废止/下线/退役→deprecate；\n` +
    `code 必须是已知协议之一（可对中文名做匹配），理由取指令中「理由：」后的内容，没有则 null。只输出 JSON。`;
  const r = await callFlash({
    messages: [
      { role: "system", content: sys },
      { role: "user", content: `管理员指令：「${command}」` },
    ],
    maxTokens: 200,
    temperature: 0.1,
    timeoutMs: 45_000,
  });
  if (!r.ok) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "指令解析器暂时不可用，请改用按钮操作" });
  const raw = String((r as { content?: string }).content ?? "");
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  let parsed: ParsedReviewCommand;
  try {
    parsed = JSON.parse((m ? m[1]! : raw).trim()) as ParsedReviewCommand;
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "没听懂这条指令，请换个说法（例：驳回 xxx，理由：缺 undo）" });
  }
  if (!parsed || !["approve", "reject", "deprecate"].includes(parsed.action) || !parsed.code) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "指令解析不完整，请指明动作与协议 code" });
  }
  if (!knownCodes.includes(parsed.code)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `协议 ${parsed.code} 不在协议清单内，已拦截（绝不猜测执行）` });
  }
  return { action: parsed.action, code: parsed.code, comment: parsed.comment ?? null };
}

const ACTION_VERB: Record<string, string> = { approve: "通过（上线 active）", reject: "驳回（rejected）", deprecate: "废止（下线 deprecated）" };

// ─── M8-b 快照引擎接入：快照优先 + 缺失自愈 + 先答后想 facts ─────────────────

/** dutyBriefing 响应载荷（快照 content 中持久化的结构） */
export interface DutyBriefingPayload {
  briefing: string;
  degraded: boolean;
  brief: PlatformBrief;
  generatedAt: string;
}

/** 现场生成值守晨报（原 dutyBriefing 逻辑原样抽出） */
export async function generateDutyBriefing(): Promise<DutyBriefingPayload> {
  const brief = await collectPlatformBrief();
  const llm = await callDutyLlm(
    `${briefToContext(brief)}\n请生成本日值守晨报（待办/风险/建议三段，总长不超过 220 字）。`,
  );
  return {
    briefing: llm ?? ruleBriefing(brief),
    degraded: llm == null,
    brief,
    generatedAt: new Date().toISOString(),
  };
}

/** 快照生成器：供 refreshSnapshot / 事件钩子复用 */
export async function dutyBriefingSnapshotGenerator(): Promise<SnapshotDraft> {
  const payload = await generateDutyBriefing();
  return { content: JSON.stringify(payload), dataVersion: payload.generatedAt, degraded: payload.degraded };
}

/** 快照新鲜度判定（generatedAt 解析失败一律视为过期，走现场生成） */
function snapshotFresh(generatedAt: string, ttlMs: number): boolean {
  const t = new Date(generatedAt).getTime();
  return Number.isFinite(t) && Date.now() - t < ttlMs;
}

/**
 * dutyBriefing 核心：快照优先（30 分钟内命中直接返回 + fromSnapshot:true）；
 * 未命中/过期/快照损坏/表缺失 → 现场生成（原逻辑）并 fire-and-forget 触发补写（自愈）。
 */
export async function dutyBriefingCore(): Promise<DutyBriefingPayload & { fromSnapshot: boolean }> {
  try {
    const snap = await readSnapshot("platform", "duty-briefing");
    if (snap && snapshotFresh(snap.generatedAt, DUTY_BRIEFING_SNAPSHOT_TTL_MS)) {
      const cached = JSON.parse(snap.content) as DutyBriefingPayload;
      if (cached && typeof cached.briefing === "string" && cached.brief) {
        return { ...cached, fromSnapshot: true };
      }
    }
  } catch {
    // 快照层不可用（表未建/库抖动）：静默回落现场生成，绝不影响值守台
  }
  const payload = await generateDutyBriefing();
  void refreshSnapshot("platform", "duty-briefing", dutyBriefingSnapshotGenerator);
  return { ...payload, fromSnapshot: false };
}

/** dutyChat「先答后想」：真实数据要点（同步生成、先行展示，绝不依赖 LLM） */
export function briefToFacts(b: PlatformBrief): string[] {
  const facts = [
    b.pendingProtocols.length > 0
      ? `待评审协议 ${b.pendingProtocols.length} 个：${b.pendingProtocols.map((p) => p.code).join("、")}`
      : "待评审协议：无",
    `24h 开放信号：B级 ${b.openSignals24h.levelB} 条，C级 ${b.openSignals24h.levelC} 条，D级 ${b.openSignals24h.levelD} 条`,
    `集群规划：累计 ${b.plans.total} 个（今日 ${b.plans.today}），已执行 ${b.plans.executed}，` +
      `待确认 ${b.plans.pendingConfirm}，失败/拒签 ${b.plans.failed}`,
    b.silentFactories7d.length > 0
      ? `沉默企业（7天无意图）${b.silentFactories7d.length} 家：${b.silentFactories7d.map((f) => f.name).join("、")}`
      : "沉默企业（7天无意图）：无",
    `冻结中企业：${b.frozenFactories} 家`,
  ];
  return facts.map((f) => stripSecrets(f));
}

/** dutyChat 核心：facts 同步先行（真实数据），reply 为 LLM 解读（故障时兜底文案并标注 degraded） */
export async function dutyChatCore(message: string): Promise<{ facts: string[]; reply: string; degraded: boolean }> {
  const brief = await collectPlatformBrief();
  const facts = briefToFacts(brief); // 先答：真实数据要点，与 LLM 可用性无关
  const llm = await callDutyLlm(
    `${briefToContext(brief)}\n管理员问：「${message}」\n请回答（先结论后依据，不超过 200 字）。`,
  );
  return {
    facts,
    reply: llm ?? "值守线路有点杂音——实况已在晨报卡里，请先看数字，或稍后再问我。",
    degraded: llm == null,
  };
}

/** plannerStats 响应载荷（原 plannerStats 逻辑原样抽出） */
export interface PlannerStatsPayload {
  plans: {
    total: number;
    byStatus: Record<string, number>;
    successRate: number | null;
    failureRate: number | null;
  };
  daily: { date: string; count: number }[];
  rejectedByChannel: { channel: string; count: number }[];
}

export async function collectPlannerStats(): Promise<PlannerStatsPayload> {
  const planRows = await stQuery(
    sql`SELECT status, COUNT(*) AS c FROM st_intent_plans GROUP BY status`,
  );
  const daily = await stQuery(
    sql`SELECT DATE(created_at) AS d, COUNT(*) AS c FROM st_intent_plans
        WHERE created_at > DATE_SUB(NOW(), INTERVAL 14 DAY) GROUP BY DATE(created_at) ORDER BY d`,
  );
  // 越权/拒签：近 30 天 st_intents rejected，按 actor 前缀归类（voice:/ai:planner:/人工）
  const rejected = await stQuery(
    sql`SELECT CASE WHEN actor LIKE 'voice:%' THEN 'voice'
                    WHEN actor LIKE 'ai:planner:%' THEN 'ai:planner'
                    ELSE 'human' END AS channel,
               COUNT(*) AS c
        FROM st_intents WHERE status = 'rejected' AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
        GROUP BY channel`,
  );
  const num = (v: unknown) => Number(v ?? 0) || 0;
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of planRows) {
    byStatus[String(r.status)] = num(r.c);
    total += num(r.c);
  }
  const executed = byStatus["executed"] ?? 0;
  const failed = (byStatus["failed"] ?? 0) + (byStatus["rejected"] ?? 0);
  return {
    plans: {
      total,
      byStatus,
      successRate: total > 0 ? Math.round((executed / total) * 100) : null,
      failureRate: total > 0 ? Math.round((failed / total) * 100) : null,
    },
    daily: daily.map((r) => ({ date: String(r.d), count: num(r.c) })),
    rejectedByChannel: rejected.map((r) => ({ channel: String(r.channel), count: num(r.c) })),
  };
}

/** 快照生成器：规划器看板 */
export async function plannerStatsSnapshotGenerator(): Promise<SnapshotDraft> {
  const payload = await collectPlannerStats();
  return { content: JSON.stringify(payload), dataVersion: new Date().toISOString(), degraded: false };
}

/** plannerStats 核心：快照优先（10 分钟），缺失/过期 → 现场计算 + 异步补写（自愈） */
export async function plannerStatsCore(): Promise<PlannerStatsPayload & { fromSnapshot: boolean }> {
  try {
    const snap = await readSnapshot("platform", "planner-stats");
    if (snap && snapshotFresh(snap.generatedAt, PLANNER_STATS_SNAPSHOT_TTL_MS)) {
      const cached = JSON.parse(snap.content) as PlannerStatsPayload;
      if (cached && cached.plans && typeof cached.plans.total === "number") {
        return { ...cached, fromSnapshot: true };
      }
    }
  } catch {
    // 快照层不可用：静默回落现场计算
  }
  const payload = await collectPlannerStats();
  void refreshSnapshot("platform", "planner-stats", plannerStatsSnapshotGenerator);
  return { ...payload, fromSnapshot: false };
}

// ─── 路由 ────────────────────────────────────────────────────────────────────

const tokenInput = z.object({ token: z.string().trim().min(1) });

export const adminAiRouter = createRouter({
  /** adminAi.dutyBriefing：灵枢值守台晨报（真实数据 + LLM，规则降级标注；M8-b 快照优先 + 缺失自愈） */
  dutyBriefing: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    return dutyBriefingCore();
  }),

  /** adminAi.dutyChat：管理员文字追问（只读问答，同一真实上下文；M8-b 先答后想：facts 同步先行 + LLM reply） */
  dutyChat: publicQuery
    .input(tokenInput.extend({ message: z.string().trim().min(1).max(500) }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      return dutyChatCore(input.message);
    }),

  /** adminAi.reviewCommand：自然语言评审指令（解析→复述预览；confirm=true 才执行，流水 reviewer=ai-cmd:<admin>） */
  reviewCommand: publicQuery
    .input(
      tokenInput.extend({
        command: z.string().trim().min(2).max(300),
        confirm: z.boolean().optional().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const codeRows = await stQuery(sql`SELECT code FROM st_protocols ORDER BY code`);
      const knownCodes = codeRows.map((r) => String(r.code));
      const parsed = await parseReviewCommand(input.command, knownCodes);
      const adminName = String(admin.username ?? "admin");

      if (!input.confirm) {
        return {
          stage: "preview" as const,
          parsed,
          recite:
            `将对协议「${parsed.code}」执行评审动作：${ACTION_VERB[parsed.action]}` +
            `${parsed.comment ? `，理由：${parsed.comment}` : ""}。` +
            `该动作与按钮操作同权同流水（reviewer=ai-cmd:${adminName}）。确认后执行。`,
        };
      }

      // confirm=true：复用 gate 评审核心，照旧 requireAdmin 权限 + st_protocol_reviews 流水
      const reviewer = `ai-cmd:${adminName}`;
      const result =
        parsed.action === "deprecate"
          ? await deprecateProtocolCore(reviewer, parsed.code, parsed.comment ?? undefined)
          : await reviewProtocolCore(reviewer, parsed.code, parsed.action, parsed.comment ?? undefined);
      return {
        stage: "executed" as const,
        parsed,
        result,
        reply: `已执行：协议「${parsed.code}」→ ${result.status}，评审流水已留痕（${reviewer}）。`,
      };
    }),

  /** adminAi.plannerStats：规划器监管看板（提交量/状态分布/失败率/越权拒签分布；M8-b 快照 10 分钟 + 自愈） */
  plannerStats: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    return plannerStatsCore();
  }),
});
