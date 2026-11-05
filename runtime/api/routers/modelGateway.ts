/**
 * modelGateway —— 四大模型密钥接入状态网关 + 统一 LLM 调用客户端
 * （Deepseek / GLM / Kimi / MiniMax）。
 *
 * 安全红线：
 * - 密钥只存于服务端环境变量（.env，gitignored），代码中仅出现环境变量名；
 * - 任何 procedure / 日志 / 错误消息都绝不回显密钥值或其片段；
 * - status/health 只返回 configured/verified 布尔与计数，不返回值；
 * - 错误净化：只保留 HTTP 状态码与通用原因，不回传响应体；
 * - verified 为内存锁存：GET /models 探活成功或 chat 调用成功即置真（TTL 600s）；
 * - callModelChat 故障转移：默认按优先级依次尝试各家，单家失败（含 401/超时）
 *   静默切换下一家，任一家成功即返回并锁存 verified。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { requireAdmin as requireAdminToken, rawRows } from "./terminal";
import { getDb } from "../queries/connection";
import { callScnetInference, SCNET_BASE_URL, SCNET_MODEL } from "../lib/scnetRuntime";

// ─── 提供方注册表（仅环境变量名与官方端点，无任何密钥值）─────────────────────
interface ModelProviderDef {
  id: "scnet" | "kimi" | "deepseek" | "glm" | "minimax";
  label: string;
  envVar: string;
  /** 官方 GET /models 端点（4 家均已确认存在） */
  probeUrl: string;
  /** OpenAI 兼容 chat completions 端点 */
  chatUrl: string;
  /** 默认型号 */
  chatModel: string;
}

type ProviderId = "scnet" | "kimi" | "deepseek" | "glm" | "minimax" | "idoictos";

const PROVIDERS: readonly ModelProviderDef[] = [
  {
    id: "scnet", label: "SCNet 超算互联网", envVar: "SCNET_API_KEY",
    probeUrl: `${SCNET_BASE_URL}/models`,
    chatUrl: `${SCNET_BASE_URL}/chat/completions`,
    chatModel: SCNET_MODEL,
  },
  {
    id: "kimi", label: "Kimi", envVar: "KIMI_API_KEY",
    probeUrl: "https://api.moonshot.cn/v1/models",
    chatUrl: "https://api.moonshot.cn/v1/chat/completions",
    chatModel: "moonshot-v1-8k",
  },
  {
    id: "deepseek", label: "Deepseek", envVar: "DEEPSEEK_API_KEY",
    probeUrl: "https://api.deepseek.com/v1/models",
    chatUrl: "https://api.deepseek.com/v1/chat/completions",
    chatModel: "deepseek-chat",
  },
  {
    id: "glm", label: "GLM", envVar: "GLM_API_KEY",
    probeUrl: "https://open.bigmodel.cn/api/paas/v4/models",
    chatUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    chatModel: "glm-4-flash",
  },
  {
    id: "minimax", label: "MiniMax", envVar: "MINIMAX_API_KEY",
    probeUrl: "https://api.minimaxi.com/v1/models",
    chatUrl: "https://api.minimaxi.com/v1/chat/completions",
    chatModel: "MiniMax-Text-01",
  },
] as const;

const MIN_KEY_LENGTH = 16;
const VERIFY_TTL_MS = 600_000;

// ─── LLM 日调用成本闸（iter87）───────────────────────────────────────────────
// 机制：内存计数为主，每 60s 从 st_llm_usage_daily 同步一次校准（进程重启即从
// DB 恢复今日值）；达到上限直接拒绝（reason: "daily_cap"），不打 provider。
// 记账为异步 UPSERT，任何 DB 故障静默跳过，绝不阻塞主流程（迁移前表不存在也能跑）。

/** 日调用上限（env LLM_DAILY_CALL_LIMIT，默认 5000） */
function llmDailyCallCap(): number {
  const n = Number(process.env.LLM_DAILY_CALL_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5000;
}

/** 本地日期键 YYYY-MM-DD（与 st_llm_usage_daily.day 对齐） */
function todayKey(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

interface UsageCounter {
  day: string;
  calls: number;
  tokens: number;
  lastSyncAt: number;
  warned80: boolean;
  warned100: boolean;
}
let usageCounter: UsageCounter = {
  day: todayKey(),
  calls: 0,
  tokens: 0,
  lastSyncAt: 0,
  warned80: false,
  warned100: false,
};

const USAGE_SYNC_INTERVAL_MS = 60_000;

/** 日界翻转自动清零重计。 */
function rollUsageCounter(): void {
  const t = todayKey();
  if (usageCounter.day !== t) {
    usageCounter = { day: t, calls: 0, tokens: 0, lastSyncAt: 0, warned80: false, warned100: false };
  }
}

/** 从 DB 校准今日总用量（取 DB 与内存的较大者，避免丢未落库的增量）。 */
async function syncUsageFromDb(): Promise<void> {
  rollUsageCounter();
  try {
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(tokens), 0) AS tokens
            FROM st_llm_usage_daily WHERE day = ${usageCounter.day}`,
      ),
    );
    const dbCalls = Number(rows[0]?.calls ?? 0);
    const dbTokens = Number(rows[0]?.tokens ?? 0);
    if (Number.isFinite(dbCalls)) usageCounter.calls = Math.max(usageCounter.calls, dbCalls);
    if (Number.isFinite(dbTokens)) usageCounter.tokens = Math.max(usageCounter.tokens, dbTokens);
  } catch {
    // 表不存在 / DB 故障：静默，内存计数继续工作
  }
  usageCounter.lastSyncAt = Date.now();
}

/** 每分钟校准一次（调用路径上惰性触发，不阻塞请求）。 */
function maybeSyncUsage(): void {
  rollUsageCounter();
  if (Date.now() - usageCounter.lastSyncAt >= USAGE_SYNC_INTERVAL_MS) {
    // 占位防并发重入，异步完成后在 syncUsageFromDb 内刷新时间戳
    usageCounter.lastSyncAt = Date.now();
    void syncUsageFromDb();
  }
}

/** 超限闸：返回 true 表示今日已达上限。 */
function isDailyCapHit(): boolean {
  maybeSyncUsage();
  const cap = llmDailyCallCap();
  const hit = usageCounter.calls >= cap;
  // 告警钩子：80% / 100% 各 warn 一次/天
  if (!usageCounter.warned80 && usageCounter.calls >= Math.floor(cap * 0.8)) {
    usageCounter.warned80 = true;
    console.warn(`[llm-cap] usage=${usageCounter.calls}/${cap}`);
  }
  if (hit && !usageCounter.warned100) {
    usageCounter.warned100 = true;
    console.warn(`[llm-cap] usage=${usageCounter.calls}/${cap}`);
  }
  return hit;
}

/** 成功后异步记账：内存 +1/+tokens，UPSERT st_llm_usage_daily；失败静默。 */
function recordUsage(provider: string, tokens: number): void {
  rollUsageCounter();
  usageCounter.calls += 1;
  usageCounter.tokens += tokens > 0 ? tokens : 0;
  const day = usageCounter.day;
  void (async () => {
    try {
      await getDb().execute(
        sql`INSERT INTO st_llm_usage_daily (day, provider, calls, tokens)
            VALUES (${day}, ${provider}, 1, ${tokens > 0 ? tokens : 0})
            ON DUPLICATE KEY UPDATE calls = calls + 1, tokens = tokens + ${tokens > 0 ? tokens : 0}`,
      );
    } catch {
      // 静默：迁移前表不存在或 DB 抖动均不阻塞主流程
    }
  })();
}

export interface LlmUsageToday {
  calls: number;
  tokens: number;
  cap: number;
  capHit: boolean;
}

/** 今日用量视图（读内存计数）。 */
export function getLlmUsageToday(): LlmUsageToday {
  rollUsageCounter();
  const cap = llmDailyCallCap();
  return {
    calls: usageCounter.calls,
    tokens: usageCounter.tokens,
    cap,
    capHit: usageCounter.calls >= cap,
  };
}


// ─── 海禛云 IDoictOS 统一网关（第五提供方：单端点五模型，OpenAI 兼容）─────────
/** 能力槽位：业务调用点按槽位取模型，而非写死型号 */
export type SlotId = "brain" | "orggen" | "chat" | "flash" | "creative";

interface SlotDef {
  model: string;
  label: string;
  /** 推理模型需足量 token 预算（按生产实测标定） */
  tokenBudget: number;
  /** 允许用环境变量覆盖该槽位默认型号（仅变量名，不出现值） */
  envOverride: string;
}

const IDO_BASE_URL = (): string =>
  (process.env.IDOICTOS_BASE_URL ?? "https://idoictos.com:3443").replace(/\/+$/, "");
const IDO_KEY_ENV = "IDOICTOS_API_KEY";

/**
 * 槽位默认型号（2026-08-12 生产实测标定）：
 * - brain→kimi-k3（推理最强；注意该模型仅允许 temperature=1，调用层已适配）；
 * - chat→kimi-k3（2026-08-09 彭总拍板：数字人对话主脑统一 Kimi，工具调用+长上下文）；
 * - flash→kimi-k3（2026-08-12 实测 K3 首响 144-572ms，远快于 deepseek-v4-flash 的
 *   1.7-3.5s，轻量槽统一切 K3；DeepSeek Flash 退役）；
 * - orggen→deepseek-v4-pro（结构化 JSON 已在生产验证，Kimi 的结构化搭档）；
 * - creative→minimax-m3（文案稳）。
 */
export const SLOT_MODELS: Record<SlotId, SlotDef> = {
  brain: { model: "kimi-k3", label: "Kimi K3 · 公司大脑", tokenBudget: 2500, envOverride: "IDO_MODEL_BRAIN" },
  orggen: { model: "deepseek-v4-pro", label: "DeepSeek V4 Pro · 结构化生成", tokenBudget: 2500, envOverride: "IDO_MODEL_ORGGEN" },
  chat: { model: "kimi-k3", label: "Kimi K3 · 对话交互", tokenBudget: 2500, envOverride: "IDO_MODEL_CHAT" },
  flash: { model: "kimi-k3", label: "Kimi K3 · 轻量任务", tokenBudget: 1200, envOverride: "IDO_MODEL_FLASH" },
  creative: { model: "minimax-m3", label: "MiniMax M3 · 文案创意", tokenBudget: 1500, envOverride: "IDO_MODEL_CREATIVE" },
};

/** 网关在役模型清单（供管理后台展示与保活；2026-08-12 flash 槽切 kimi-k3 后 DeepSeek Flash 退役） */
export const GATEWAY_MODELS: readonly string[] = [
  "kimi-k3", "deepseek-v4-pro", "minimax-m3",
] as const;

/**
 * 海禛云网关全量模型目录（2026-08-19 实测 GET /v1/models 同步，共 41 个）——
 * 彭总指令：APP 与智能工作台接入海禛云所有模型。
 * 接入方式：① 任一模型的接入零代码——SLOT_MODELS[*].envOverride 环境变量指过去即可；
 * ② 工作台班组 preferredModel 厂商键见 terminal.ts SWARM_MODEL_SLOT（已同步扩键）；
 * ③ 本目录供管理后台/工作台展示层渲染全量清单。
 * 口径：:cloud / :idoictos 后缀为网关同一模型的通道变体；minimax-m3 于 2026-08-19 实测超时（40s 无响应），
 * 在 GATEWAY_MODELS 在役清单保留但标注，排障找海禛云。
 */
export interface GatewayModelDef {
  id: string;
  vendor: string;
  /** 展示名（工作台/管理后台直出） */
  label: string;
  /** 通道变体（无后缀=默认通道） */
  variant?: "cloud" | "idoictos";
}
export const GATEWAY_CATALOG: readonly GatewayModelDef[] = [
  { id: "kimi-k3", vendor: "kimi", label: "Kimi K3 · 旗舰" },
  { id: "kimi-k2.6:cloud", vendor: "kimi", label: "Kimi K2.6", variant: "cloud" },
  { id: "kimi-k2.7-code", vendor: "kimi", label: "Kimi K2.7 · 代码" },
  { id: "deepseek-v4-pro", vendor: "deepseek", label: "DeepSeek V4 Pro · 推理" },
  { id: "deepseek-v4-pro:cloud", vendor: "deepseek", label: "DeepSeek V4 Pro", variant: "cloud" },
  { id: "deepseek-v4-pro:idoictos", vendor: "deepseek", label: "DeepSeek V4 Pro", variant: "idoictos" },
  { id: "deepseek-v4-flash", vendor: "deepseek", label: "DeepSeek V4 Flash · 极速" },
  { id: "deepseek-v4-flash:cloud", vendor: "deepseek", label: "DeepSeek V4 Flash", variant: "cloud" },
  { id: "deepseek-v4-flash:idoictos", vendor: "deepseek", label: "DeepSeek V4 Flash", variant: "idoictos" },
  { id: "deepseek-v3.2:cloud", vendor: "deepseek", label: "DeepSeek V3.2", variant: "cloud" },
  { id: "glm-5.2", vendor: "glm", label: "GLM 5.2 · 对话" },
  { id: "glm-5.2:cloud", vendor: "glm", label: "GLM 5.2", variant: "cloud" },
  { id: "glm-5.2:idoictos", vendor: "glm", label: "GLM 5.2", variant: "idoictos" },
  { id: "glm-5.1:cloud", vendor: "glm", label: "GLM 5.1", variant: "cloud" },
  { id: "glm-4.7:cloud", vendor: "glm", label: "GLM 4.7", variant: "cloud" },
  { id: "minimax-m3", vendor: "minimax", label: "MiniMax M3 · 创意（实测超时待海禛云排障）" },
  { id: "minimax-m3:cloud", vendor: "minimax", label: "MiniMax M3", variant: "cloud" },
  { id: "minimax-m3:idoictos", vendor: "minimax", label: "MiniMax M3", variant: "idoictos" },
  { id: "minimax-m2.5:cloud", vendor: "minimax", label: "MiniMax M2.5", variant: "cloud" },
  { id: "minimax-m2.7:cloud", vendor: "minimax", label: "MiniMax M2.7", variant: "cloud" },
  { id: "qwen3.5:cloud", vendor: "qwen", label: "通义 Qwen3.5", variant: "cloud" },
  { id: "qwen3.5:397b-cloud", vendor: "qwen", label: "通义 Qwen3.5 397B · 超大杯", variant: "cloud" },
  { id: "claude-mythos-5", vendor: "claude", label: "Claude Mythos 5" },
  { id: "claude-opus-4-8", vendor: "claude", label: "Claude Opus 4.8" },
  { id: "claude-sonnet-5", vendor: "claude", label: "Claude Sonnet 5" },
  { id: "claude-sonnet-4-5", vendor: "claude", label: "Claude Sonnet 4.5" },
  { id: "claude-fable-5", vendor: "claude", label: "Claude Fable 5" },
  { id: "claude-haiku-4-5", vendor: "claude", label: "Claude Haiku 4.5 · 轻量" },
  { id: "gpt-5.6-sol", vendor: "gpt", label: "GPT 5.6 Sol · 旗舰" },
  { id: "gpt-5.5-pro", vendor: "gpt", label: "GPT 5.5 Pro" },
  { id: "gpt-5.4", vendor: "gpt", label: "GPT 5.4" },
  { id: "gpt-5.4-mini", vendor: "gpt", label: "GPT 5.4 Mini · 轻量" },
  { id: "gpt-oss:120b-cloud", vendor: "gpt-oss", label: "GPT OSS 120B · 开源", variant: "cloud" },
  { id: "gemma4:31b-cloud", vendor: "gemma", label: "Gemma 4 31B · 开源", variant: "cloud" },
  { id: "idoictos-renji-v1", vendor: "idoictos", label: "海禛云自研 · 人机 V1" },
  { id: "idoictos-shenji-v1", vendor: "idoictos", label: "海禛云自研 · 神机 V1" },
  { id: "idoictos-tianji-v1", vendor: "idoictos", label: "海禛云自研 · 天机 V1" },
  { id: "idoictos-diji-v1", vendor: "idoictos", label: "海禛云自研 · 地机 V1" },
  { id: "idoictos-yuanji-v1", vendor: "idoictos", label: "海禛云自研 · 元机 V1" },
  { id: "idoictos-shenxianji-v1", vendor: "idoictos", label: "海禛云自研 · 神先机 V1" },
  { id: "idoictos-xianji-v1", vendor: "idoictos", label: "海禛云自研 · 先机 V1" },
] as const;

/** 槽位调用参数（M8-a 起抽为具名类型；结构与原有内联类型完全一致） */
export interface CallOpts {
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** M59：调用场景标识（如 assistant_ask）；声明后本次调用落 st_llm_events 时延账，未声明行为零变化 */
  context?: string;
  /** M62：单次调用模型覆盖（如 utterance 解析专用 deepseek-v4-flash）；不设=槽默认，行为零变化 */
  modelOverride?: string;
}

/**
 * M59 时延可观测：网关调用落 st_llm_events（fire-and-forget；表缺失/库故障静默，绝不阻塞主链）。
 * 只在调用方显式声明 context 时记账——存量调用点行为不变（原来系统的功能不变）。
 */
export function recordGatewayEvent(
  context: string | undefined,
  slot: SlotId,
  r: { ok: boolean; latencyMs?: number; firstTokenMs?: number },
  fallback: boolean,
): void {
  // #10 SLO 采样：无论是否声明 context 都喂滚动样本（轻量内存操作，无副作用）
  pushSloSample(slot, r.firstTokenMs ?? r.latencyMs ?? 0);
  if (!context) return;
  try {
    const db = getDb();
    const firstTokenMs =
      typeof r.firstTokenMs === "number" && Number.isFinite(r.firstTokenMs)
        ? Math.max(0, Math.round(r.firstTokenMs))
        : null;
    void db
      .execute(
        sql`INSERT INTO st_llm_events (context, slot, ok, fallback, latency_ms, first_token_ms)
            VALUES (${context.slice(0, 32)}, ${slot}, ${r.ok ? 1 : 0}, ${fallback ? 1 : 0}, ${Math.max(0, Math.round(r.latencyMs ?? 0))}, ${firstTokenMs})`,
      )
      .catch(() => {});
  } catch {
    /* st_llm_events 未建/库不可用时静默缺省，口径同 evo.recordLlmEvent */
  }
}

const idoVerified = new Map<string, VerifyState>();
function markIdoVerified(model: string, ok: boolean, httpStatus?: number): void {
  idoVerified.set(model, { ok, httpStatus, at: Date.now() });
}
export function isIdoModelVerified(model: string): boolean {
  const v = idoVerified.get(model);
  return !!v && v.ok && Date.now() - v.at < VERIFY_TTL_MS;
}

function readIdoKey(): string | null {
  return readKey(IDO_KEY_ENV);
}

/**
 * 网关内跨槽降级链（B3 备用链重构）：
 * 官方四链已证实不可靠（401×2 + timeout×1），真正的备用在海禛云网关内部——
 * 主槽模型失败时按本表降级到兄弟模型，最后由调用方模板兜底。
 */
const SLOT_FALLBACK: Record<SlotId, SlotId[]> = {
  brain: ["orggen", "chat"],
  orggen: ["flash", "chat"],
  chat: ["flash", "creative"],
  flash: ["orggen", "creative"],
  creative: ["chat", "flash"],
};

/** #10 模型 SLO 自动降级（彭总令 2026-09-01，技术债治理）：
 * 滚动采样近 20 次首字时延，P50 超 SLO 即标记降级（5 分钟冷却）；
 * 降级期调用直发首选备用槽（标注「SLO降级」），冷却结束自动解除。
 * 不动既有失败降级链——SLO 是「未败先降」，SLOT_FALLBACK 是「败后接力」。 */
const SLOT_SLO_MS: Record<SlotId, number> = {
  brain: 12_000,
  orggen: 12_000,
  chat: 8_000,
  flash: 4_000,
  creative: 10_000,
};
const DEGRADE_TTL_MS = 300_000;
const slotSamples = new Map<SlotId, number[]>();
const slotDegradedAt = new Map<SlotId, number>();

function pushSloSample(slot: SlotId, ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const arr = slotSamples.get(slot) ?? [];
  arr.push(ms);
  if (arr.length > 20) arr.shift();
  slotSamples.set(slot, arr);
  if (arr.length >= 5) {
    const sorted = [...arr].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
    if (p50 > SLOT_SLO_MS[slot]) slotDegradedAt.set(slot, Date.now());
  }
}

function isSloDegraded(slot: SlotId): boolean {
  const at = slotDegradedAt.get(slot);
  if (!at) return false;
  if (Date.now() - at > DEGRADE_TTL_MS) {
    slotDegradedAt.delete(slot);
    slotSamples.delete(slot);
    return false;
  }
  return true;
}

/** SLO 看板快照（探针/管理端读取：每槽 P50、阈值、降级态） */
export function modelSloSnapshot(): Array<{ slot: SlotId; p50: number; slo: number; degraded: boolean }> {
  return (Object.keys(SLOT_SLO_MS) as SlotId[]).map((slot) => {
    const arr = slotSamples.get(slot) ?? [];
    const sorted = [...arr].sort((a, b) => a - b);
    return {
      slot,
      p50: sorted[Math.floor(sorted.length / 2)] ?? 0,
      slo: SLOT_SLO_MS[slot],
      degraded: isSloDegraded(slot),
    };
  });
}

/** 槽位调用：主槽失败自动沿 SLOT_FALLBACK 降级，返回结果标注 fallbackFrom。 */
export async function callSlotChat(
  slot: SlotId,
  opts: CallOpts,
): Promise<LlmCallResult> {
  const key = readIdoKey();
  if (!key) return { ok: false, reason: "not_configured" };
  if (isDailyCapHit()) return { ok: false, reason: "daily_cap" };
  // #10 SLO 降级：槽位近期首字时延超线 → 跳过主棒直发备用槽（未败先降）
  if (isSloDegraded(slot)) {
    const fb = SLOT_FALLBACK[slot][0];
    const r = await callSlotOnce(fb, { ...opts, modelOverride: undefined });
    if (r.ok) {
      recordUsage("idoictos", r.usageTokens ?? 0);
      recordGatewayEvent(opts.context, slot, r, true);
      return { ...r, fallbackFrom: slot, providerLabel: `${r.providerLabel}（SLO降级自 ${SLOT_MODELS[slot].label}）` };
    }
    // 备用槽也不成 → 回落正常主棒流程
  }
  const first = await callSlotOnce(slot, opts);
  if (first.ok) {
    recordUsage("idoictos", first.usageTokens ?? 0);
    recordGatewayEvent(opts.context, slot, first, false);
    return first;
  }
  for (const fb of SLOT_FALLBACK[slot]) {
    const r = await callSlotOnce(fb, { ...opts, modelOverride: undefined }); // M62：override 只作用首棒，fallback 回槽默认
    if (r.ok) {
      recordUsage("idoictos", r.usageTokens ?? 0);
      recordGatewayEvent(opts.context, slot, r, true);
      return { ...r, fallbackFrom: slot, providerLabel: `${r.providerLabel}（降级自 ${SLOT_MODELS[slot].label}）` };
    }
  }
  recordGatewayEvent(opts.context, slot, first, true);
  return first;
}

/** 解析槽位当前生效型号（含环境变量覆盖） */
function slotModel(slot: SlotId): string {
  const def = SLOT_MODELS[slot];
  return (process.env[def.envOverride] ?? "").trim() || def.model;
}

async function callSlotOnce(
  slot: SlotId,
  opts: CallOpts,
  externalSignal?: AbortSignal,
): Promise<LlmCallResult> {
  const key = readIdoKey();
  if (!key) return { ok: false, reason: "not_configured" };
  const def = SLOT_MODELS[slot];
  const model = opts.modelOverride ?? slotModel(slot);
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45_000);
    // M8-a 竞速：外部信号（败者中止）联动内部控制器；未传时行为与原来完全一致
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const res = await fetch(`${IDO_BASE_URL()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: opts.messages,
        max_tokens: Math.max(opts.maxTokens ?? def.tokenBudget, def.tokenBudget),
        // kimi-k3 仅允许 temperature=1（litellm 限制）；其余模型默认 0.3
        temperature: model === "kimi-k3" ? 1 : (opts.temperature ?? 0.3),
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      markIdoVerified(model, false, res.status);
      return { ok: false, provider: "idoictos" as ProviderId, providerLabel: `海禛云·${def.label}`, model, reason: `http_${res.status}`, latencyMs };
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return { ok: false, provider: "idoictos" as ProviderId, providerLabel: `海禛云·${def.label}`, model, reason: "empty_content", latencyMs };
    }
    markIdoVerified(model, true, 200);
    const usageTokens = Number(data.usage?.total_tokens ?? 0);
    // v167 缓存命中观测：网关已实测回传 prompt_cache_hit/miss_tokens（DeepSeek 上下文缓存）
    const hit = Number(data.usage?.prompt_cache_hit_tokens ?? 0);
    const miss = Number(data.usage?.prompt_cache_miss_tokens ?? 0);
    return {
      ok: true, provider: "idoictos" as ProviderId, providerLabel: `海禛云·${def.label}`, model, content, latencyMs,
      usageTokens: Number.isFinite(usageTokens) && usageTokens > 0 ? usageTokens : 0,
      cacheHitTokens: Number.isFinite(hit) ? hit : 0,
      cacheMissTokens: Number.isFinite(miss) ? miss : 0,
    };
  } catch (e) {
    const isAbort = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      provider: "idoictos" as ProviderId,
      providerLabel: `海禛云·${def.label}`,
      model,
      reason: isAbort ? "timeout" : "network_error",
      latencyMs: Date.now() - started,
    };
  }
}

// ─── M8-a · LLM 网关提速层（双通道竞速 + 自适应路由熔断 + 保活心跳）──────────
// 旁路新增：既有 callSlotChat 顺序降级行为不变；新功能全部走 callSlotChatFast
// 与模块级 latencyStats。安全红线不变：密钥只来自环境变量，错误只含通用原因。

/** 每模型自适应路由统计（最近 20 个延迟样本 / P50 / 连续失败 / 熔断截止时刻） */
export interface ModelLatencyStat {
  samples: number[];
  p50: number;
  failStreak: number;
  circuitOpenUntil: number;
}

/** 模块级延迟统计表：key 为实际生效型号名 */
export const latencyStats = new Map<string, ModelLatencyStat>();

const LATENCY_SAMPLE_CAP = 20;
const CIRCUIT_FAIL_STREAK = 3;
const CIRCUIT_OPEN_MS = 5 * 60_000; // failStreak≥3 → 熔断 5 分钟

function medianP50(samples: number[]): number {
  if (samples.length === 0) return 0;
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

function statOf(model: string): ModelLatencyStat {
  let s = latencyStats.get(model);
  if (!s) {
    s = { samples: [], p50: 0, failStreak: 0, circuitOpenUntil: 0 };
    latencyStats.set(model, s);
  }
  return s;
}

/** 记录一次调用结果：成功清零 failStreak 并采样延迟；失败累计，≥3 次熔断 5 分钟。 */
function recordModelStat(model: string, ok: boolean, latencyMs?: number): void {
  const s = statOf(model);
  if (ok) {
    s.failStreak = 0;
    if (typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0) {
      s.samples.push(latencyMs);
      if (s.samples.length > LATENCY_SAMPLE_CAP) s.samples.splice(0, s.samples.length - LATENCY_SAMPLE_CAP);
      s.p50 = medianP50(s.samples);
    }
  } else {
    s.failStreak += 1;
    if (s.failStreak >= CIRCUIT_FAIL_STREAK) s.circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
  }
}

function isCircuitOpen(model: string): boolean {
  return (latencyStats.get(model)?.circuitOpenUntil ?? 0) > Date.now();
}

/** 竞速版返回：在原 LlmCallResult 成功形态上扩展 provider/latencyMs/hedged（失败一律抛错） */
export interface FastCallResult extends Omit<LlmCallResult, "ok" | "provider" | "latencyMs"> {
  ok: true;
  provider: string;
  latencyMs: number;
  /** 本次是否启用了双通道竞速（熔断导致单通道时为 false） */
  hedged: boolean;
}

/** 仅 flash/chat 槽启用双通道竞速（SPEC M8-a） */
const HEDGED_SLOTS: readonly SlotId[] = ["flash", "chat", "orggen"];

/**
 * callSlotChatFast —— 竞速版槽位调用：
 * - flash/chat：主模型与 FALLBACK 首个备选同时发请求，先成功返回者胜，
 *   败者 AbortController 中止；任一家失败不计错误，两家都失败才抛错（原因合并）；
 * - 主模型处于熔断期时让位：直接以备选 + 第三备选（若配置）竞速；
 * - 其余槽位：沿用 callSlotChat 顺序降级链路，仅补统计与扩展返回。
 */
export async function callSlotChatFast(slot: SlotId, opts: CallOpts): Promise<FastCallResult> {
  const key = readIdoKey();
  if (!key) throw new Error("callSlotChatFast: not_configured");
  if (isDailyCapHit()) throw new Error("callSlotChatFast: daily_cap");

  if (!HEDGED_SLOTS.includes(slot)) {
    const r = await callSlotChat(slot, opts);
    if (r.model) recordModelStat(r.model, r.ok, r.latencyMs);
    if (!r.ok) throw new Error(`callSlotChatFast(${slot}) failed: ${r.reason ?? "unknown"}`);
    return { ...r, ok: true, provider: r.provider ?? "idoictos", latencyMs: r.latencyMs ?? 0, hedged: false };
  }

  // 候选链：主模型 + 降级链；熔断期内的模型让位（全部熔断则仍给主+首选备选一次机会）
  const chain: SlotId[] = [slot, ...SLOT_FALLBACK[slot]];
  // M62：首槽有 modelOverride 时按覆盖模型查熔断（deepseek 专用棒不被 kimi-k3 熔断误伤）
  const healthy = chain.filter((s, i) => !isCircuitOpen(i === 0 && opts.modelOverride ? opts.modelOverride : slotModel(s)));
  const racers: SlotId[] =
    healthy.length >= 2 ? healthy.slice(0, 2)
      : healthy.length === 1 ? [healthy[0]]
        : chain.slice(0, 2);

  const controllers = racers.map(() => new AbortController());
  return await new Promise<FastCallResult>((resolve, reject) => {
    let settled = false;
    let failCount = 0;
    const failReasons: string[] = [];
    racers.forEach((s, i) => {
      void callSlotOnce(s, s === slot ? opts : { ...opts, modelOverride: undefined }, controllers[i].signal).then((r) => {
        if (r.ok) {
          if (r.model) recordModelStat(r.model, true, r.latencyMs);
          if (settled) return;
          settled = true;
          // 先成功返回者胜：中止败者（其迟到的 AbortError 不计入统计）
          controllers.forEach((c, j) => { if (j !== i) c.abort(); });
          recordUsage("idoictos", r.usageTokens ?? 0);
          recordGatewayEvent(opts.context, slot, r, s !== slot);
          resolve({
            ...r,
            ok: true,
            provider: r.provider ?? "idoictos",
            latencyMs: r.latencyMs ?? 0,
            hedged: racers.length > 1,
            ...(s !== slot
              ? { fallbackFrom: slot, providerLabel: `${r.providerLabel}（降级自 ${SLOT_MODELS[slot].label}）` }
              : {}),
          });
        } else if (!settled) {
          if (r.model) recordModelStat(r.model, false);
          failCount += 1;
          failReasons.push(`${r.model ?? slotModel(s)}=${r.reason ?? "unknown"}`);
          if (failCount === racers.length) {
            settled = true;
            recordGatewayEvent(opts.context, slot, { ok: false, latencyMs: r.latencyMs }, false);
            reject(new Error(`callSlotChatFast(${slot}) 双通道均失败: ${failReasons.join("; ")}`));
          }
        }
      });
    });
  });
}

// ─── M60 · 真流式槽位调用（stream:true → SSE 增量回调）──────────────────────
// 旁路新增：callSlotChat / callSlotChatFast 行为零变化；流式只服务新调用点
// （voiceBuddy 流式生成 / SSE 端点）。降级纪律：吐出任何 chunk 之前失败才沿
// SLOT_FALLBACK 换槽；已吐 chunk 后断流绝不换槽重发（防重复内容刷屏），
// 返回 partialContent 由调用方决定兜底。

/** 流式调用返回：在 LlmCallResult 上扩展首字时延与断流残留内容 */
export interface StreamCallResult extends LlmCallResult {
  /** 首字时延（首个增量内容到达时刻 - 发起时刻）；未吐字/失败为 undefined */
  firstTokenMs?: number;
  /** 断流时已吐出的累计内容（仅 ok:false 且吐过 chunk 时存在） */
  partialContent?: string;
}

/** onChunk 回调：每次增量内容到达触发（参数为增量片段，非累计） */
export type StreamChunkHandler = (delta: string) => void;

/**
 * 单次流式调用（callSlotOnce 的 stream:true 变体）：
 * - 读 OpenAI 兼容 SSE 帧（data: {choices:[{delta:{content}}]} … data: [DONE]）；
 * - 整体超时口径同 callSlotOnce（timeoutMs 到时 AbortController 斩断）；
 * - 吐出 chunk 后断流 → ok:false + partialContent；未吐字失败 → ok:false 无 partial。
 */
async function callSlotOnceStream(
  slot: SlotId,
  opts: CallOpts,
  onChunk: StreamChunkHandler,
): Promise<StreamCallResult> {
  const key = readIdoKey();
  if (!key) return { ok: false, reason: "not_configured" };
  const def = SLOT_MODELS[slot];
  const model = opts.modelOverride ?? slotModel(slot);
  const started = Date.now();
  let partial = "";
  let firstTokenMs: number | undefined;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45_000);
    const res = await fetch(`${IDO_BASE_URL()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: opts.messages,
        max_tokens: Math.max(opts.maxTokens ?? def.tokenBudget, def.tokenBudget),
        // kimi-k3 仅允许 temperature=1（litellm 限制）；与非流式口径一致
        temperature: model === "kimi-k3" ? 1 : (opts.temperature ?? 0.3),
        stream: true,
        // 请求末帧携带 usage（litellm/OpenAI 兼容）；网关不支持时静默缺省为 0
        stream_options: { include_usage: true },
      }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      markIdoVerified(model, false, res.status);
      return { ok: false, provider: "idoictos" as ProviderId, providerLabel: `海禛云·${def.label}`, model, reason: `http_${res.status}`, latencyMs };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let usageTokens = 0;
    let doneSeen = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE 帧以空行分隔；逐帧抽 data: 负载
        for (;;) {
          const idx = buf.indexOf("\n\n");
          if (idx < 0) break;
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            if (payload === "[DONE]") {
              doneSeen = true;
              continue;
            }
            try {
              const j = JSON.parse(payload) as {
                choices?: { delta?: { content?: string } }[];
                usage?: { total_tokens?: number };
              };
              const delta = j.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta.length > 0) {
                if (firstTokenMs === undefined) firstTokenMs = Date.now() - started;
                partial += delta;
                onChunk(delta);
              }
              const u = Number(j.usage?.total_tokens ?? 0);
              if (Number.isFinite(u) && u > 0) usageTokens = u;
            } catch {
              // 单帧 JSON 解析失败跳过该帧，不污染整流
            }
          }
        }
      }
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
    const latencyMs = Date.now() - started;
    const content = partial.trim();
    if (!content) {
      return { ok: false, provider: "idoictos" as ProviderId, providerLabel: `海禛云·${def.label}`, model, reason: doneSeen ? "empty_content" : "stream_ended_empty", latencyMs, firstTokenMs };
    }
    markIdoVerified(model, true, 200);
    return {
      ok: true, provider: "idoictos" as ProviderId, providerLabel: `海禛云·${def.label}`, model, content, latencyMs, firstTokenMs,
      usageTokens: usageTokens > 0 ? usageTokens : 0,
    };
  } catch (e) {
    const isAbort = e instanceof Error && e.name === "AbortError";
    const latencyMs = Date.now() - started;
    return {
      ok: false,
      provider: "idoictos" as ProviderId,
      providerLabel: `海禛云·${def.label}`,
      model,
      reason: isAbort ? "timeout" : "network_error",
      latencyMs,
      firstTokenMs,
      ...(partial ? { partialContent: partial } : {}),
    };
  }
}

/**
 * callSlotChatStream —— 流式槽位调用（callSlotChat 的流式对等体）：
 * - 主槽流式失败且【未吐出任何 chunk】→ 沿 SLOT_FALLBACK 换槽重试；
 * - 已吐 chunk 后断流 → 直接返回失败+partialContent（绝不换槽重发，防内容重复）；
 * - 落账/熔断统计口径与竞速层一致（context 声明才记账）。
 */
export async function callSlotChatStream(
  slot: SlotId,
  opts: CallOpts,
  onChunk: StreamChunkHandler,
): Promise<StreamCallResult> {
  const key = readIdoKey();
  if (!key) return { ok: false, reason: "not_configured" };
  if (isDailyCapHit()) return { ok: false, reason: "daily_cap" };
  const chain: SlotId[] = [slot, ...SLOT_FALLBACK[slot]];
  // 熔断期内的模型让位（全部熔断仍按原链尝试，口径同竞速层）
  // M62：首槽有 modelOverride 时按覆盖模型查熔断（deepseek 专用棒不被 kimi-k3 熔断误伤）
  const healthy = chain.filter((s, i) => !isCircuitOpen(i === 0 && opts.modelOverride ? opts.modelOverride : slotModel(s)));
  const order = healthy.length > 0 ? healthy : chain;
  let first: StreamCallResult | null = null;
  for (const s of order) {
    let emitted = false;
    const r = await callSlotOnceStream(s, s === slot ? opts : { ...opts, modelOverride: undefined }, (delta) => {
      emitted = true;
      onChunk(delta);
    });
    if (r.model) recordModelStat(r.model, r.ok, r.latencyMs);
    if (!first) first = r;
    if (r.ok) {
      recordUsage("idoictos", r.usageTokens ?? 0);
      recordGatewayEvent(opts.context, slot, r, s !== slot);
      if (s === slot) return r;
      return { ...r, fallbackFrom: slot, providerLabel: `${r.providerLabel}（降级自 ${SLOT_MODELS[slot].label}）` };
    }
    // 已吐 chunk 的断流：不换槽，失败原样上交（partialContent 供调用方兜底）
    if (emitted) {
      recordGatewayEvent(opts.context, slot, r, s !== slot);
      return r;
    }
  }
  const last = first ?? { ok: false as const, reason: "unknown" };
  recordGatewayEvent(opts.context, slot, last, true);
  return last;
}

// ─── 保活心跳（1-token 暖调用；只更新 latencyStats，不抛错、不阻塞）──────────
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

/** 对海禛云网关单模型发 max_tokens=1 暖调用，结果只入 latencyStats。 */
async function warmIdoModel(model: string, key: string): Promise<void> {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(`${IDO_BASE_URL()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        // kimi-k3 仅允许 temperature=1（litellm 限制），与正式调用层保持一致
        temperature: model === "kimi-k3" ? 1 : 0.3,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    recordModelStat(model, res.ok, Date.now() - started);
  } catch {
    recordModelStat(model, false);
  }
}

/** 对官方四厂商之一发 max_tokens=1 暖调用，结果只入 latencyStats。 */
async function warmProviderModel(p: ModelProviderDef, key: string): Promise<void> {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(p.chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: p.chatModel,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0.3,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    recordModelStat(p.chatModel, res.ok, Date.now() - started);
  } catch {
    recordModelStat(p.chatModel, false);
  }
}

/** 单轮保活：对每个已配置厂商各发一次 1-token 极简调用；任何失败只更新统计，绝不抛出。 */
export async function runKeepAliveOnce(): Promise<void> {
  const tasks: Promise<void>[] = [];
  const idoKey = readIdoKey();
  if (idoKey) {
    const models = new Set((Object.keys(SLOT_MODELS) as SlotId[]).map(slotModel));
    for (const model of models) tasks.push(warmIdoModel(model, idoKey));
  }
  for (const p of PROVIDERS) {
    if (p.id === "scnet" && process.env.SCNET_KEEPALIVE_ENABLED !== "1") continue;
    const k = readKey(p.envVar);
    if (k) tasks.push(warmProviderModel(p, k));
  }
  await Promise.all(tasks.map((t) => t.catch(() => undefined)));
}

/** 启动保活心跳（默认 240s 一轮）；立即暖一轮，后续按间隔 fire-and-forget。 */
export function startKeepAlive(intervalMs = 240_000): void {
  stopKeepAlive();
  void runKeepAliveOnce().catch(() => undefined);
  keepAliveTimer = setInterval(() => {
    void runKeepAliveOnce().catch(() => undefined);
  }, intervalMs);
  (keepAliveTimer as unknown as { unref?: () => void }).unref?.();
}

/** 停止保活心跳（供测试与优雅停机） */
export function stopKeepAlive(): void {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

/** 槽位编排视图（管理后台展示；只含型号名与布尔，绝无密钥） */
export function getSlotAssignments(): {
  slot: SlotId;
  model: string;
  label: string;
  envOverride: string;
  verified: boolean;
}[] {
  return (Object.keys(SLOT_MODELS) as SlotId[]).map((slot) => {
    const def = SLOT_MODELS[slot];
    const model = (process.env[def.envOverride] ?? "").trim() || def.model;
    return { slot, model, label: def.label, envOverride: def.envOverride, verified: isIdoModelVerified(model) };
  });
}


function readKey(envVar: string): string | null {
  const v = process.env[envVar];
  if (!v) return null;
  const t = v.trim();
  return t.length >= MIN_KEY_LENGTH ? t : null;
}

// ─── verified 内存锁存 ───────────────────────────────────────────────────────
interface VerifyState {
  ok: boolean;
  httpStatus?: number;
  at: number;
}
const verifiedMap = new Map<ProviderId, VerifyState>();
let lastProbeAt = 0;

function markVerified(id: ProviderId, ok: boolean, httpStatus?: number): void {
  verifiedMap.set(id, { ok, httpStatus, at: Date.now() });
}

export function isProviderVerified(id: ProviderId): boolean {
  const v = verifiedMap.get(id);
  return !!v && v.ok && Date.now() - v.at < VERIFY_TTL_MS;
}

/**
 * GET /models 探活（只对配置了密钥的提供方发起，TTL 内不重复）。
 * 只记录 HTTP 状态码，不读取、不记录响应体。
 * M8-a 探活异步化：非强制调用只读 verified 缓存，过期时把探活挪到后台
 * refresh（fire-and-forget），请求路径绝不阻塞；force=true（管理员显式
 * 重新探活）仍同步等待探活完成后再返回。
 */
export async function ensureProbed(force = false): Promise<void> {
  if (!force) {
    if (Date.now() - lastProbeAt < VERIFY_TTL_MS) return;
    lastProbeAt = Date.now();
    void probeAllProviders();
    return;
  }
  lastProbeAt = Date.now();
  await probeAllProviders();
}

async function probeAllProviders(): Promise<void> {
  await Promise.all(
    PROVIDERS.map(async (p) => {
      const key = readKey(p.envVar);
      if (!key) {
        markVerified(p.id, false);
        return;
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(p.probeUrl, {
          method: "GET",
          headers: { Authorization: `Bearer ${key}` },
          signal: controller.signal,
        });
        clearTimeout(timer);
        markVerified(p.id, res.ok, res.status);
      } catch {
        markVerified(p.id, false);
      }
    }),
  );
}

// ─── 统一 chat 调用（服务端内部使用；错误净化，绝不泄漏密钥）─────────────────
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCallResult {
  ok: boolean;
  provider?: ProviderId;
  providerLabel?: string;
  model?: string;
  content?: string;
  latencyMs?: number;
  /** not_configured | http_<status> | timeout | network_error | empty_content | daily_cap */
  reason?: string;
  /** B3：若本次成功是降级自其他槽位，记录原槽位 */
  fallbackFrom?: SlotId;
  /** 模型返回 usage.total_tokens（无则 0），供成本闸记账 */
  usageTokens?: number;
  providerRequestId?: string | null;
  requestSha256?: string;
  responseSha256?: string;
  /** v167 缓存命中观测：DeepSeek 上下文缓存命中/未命中 token 数（无则 0） */
  cacheHitTokens?: number;
  cacheMissTokens?: number;
}

function pickProviderOrder(explicit?: ProviderId): ModelProviderDef[] {
  if (process.env.SCNET_REQUIRED === "1") {
    if (explicit && explicit !== "scnet") return [];
    const scnet = PROVIDERS.find((p) => p.id === "scnet");
    return scnet ? [scnet] : [];
  }
  const order: ModelProviderDef[] = [];
  const envPick = process.env.MODEL_ASSISTANT_PROVIDER;
  const want = explicit ?? (envPick as ProviderId | undefined);
  if (want) {
    const p = PROVIDERS.find((x) => x.id === want);
    if (p) order.push(p);
  }
  if (!explicit) {
    // 显式指定时只调该家；否则按优先级全链路故障转移
    for (const p of PROVIDERS) {
      if (!order.includes(p)) order.push(p);
    }
  }
  return order;
}

export async function callModelChat(opts: {
  messages: LlmMessage[];
  provider?: ProviderId;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<LlmCallResult> {
  if (isDailyCapHit()) return { ok: false, reason: "daily_cap" };
  const candidates = pickProviderOrder(opts.provider).filter(
    (p) => readKey(p.envVar) !== null,
  );
  if (candidates.length === 0) return { ok: false, reason: "not_configured" };
  let lastFailure: LlmCallResult = { ok: false, reason: "not_configured" };
  for (const p of candidates) {
    const result = await callOne(p, opts);
    if (result.ok) {
      recordUsage(p.id, result.usageTokens ?? 0);
      return result;
    }
    lastFailure = result;
    // 该家失败（含 401/超时/网络错误），静默故障转移至下一家
  }
  return lastFailure;
}

async function callOne(
  p: ModelProviderDef,
  opts: {
    messages: LlmMessage[];
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
  },
): Promise<LlmCallResult> {
  if (p.id === "scnet") {
    const result = await callScnetInference({ messages: opts.messages, maxTokens: opts.maxTokens, temperature: opts.temperature, timeoutMs: opts.timeoutMs });
    if (result.ok) {
      markVerified(p.id, true, 200);
      return {
        ok: true, provider: p.id, providerLabel: p.label, model: result.model, content: result.content,
        latencyMs: result.latencyMs, usageTokens: result.usageTokens, providerRequestId: result.requestId,
        requestSha256: result.requestSha256, responseSha256: result.responseSha256,
      };
    }
    return {
      ok: false, provider: p.id, providerLabel: p.label,
      reason: result.reason === "http_error" ? `http_${result.httpStatus}` : result.reason,
      latencyMs: result.latencyMs,
    };
  }
  const key = readKey(p.envVar);
  if (!key) return { ok: false, reason: "not_configured" };
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
    const res = await fetch(p.chatUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: p.chatModel,
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? 512,
        temperature: opts.temperature ?? 0.3,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return { ok: false, provider: p.id, providerLabel: p.label, reason: `http_${res.status}`, latencyMs };
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return { ok: false, provider: p.id, providerLabel: p.label, reason: "empty_content", latencyMs };
    }
    markVerified(p.id, true, 200);
    const usageTokens = Number(data.usage?.total_tokens ?? 0);
    return {
      ok: true, provider: p.id, providerLabel: p.label, model: p.chatModel, content, latencyMs,
      usageTokens: Number.isFinite(usageTokens) && usageTokens > 0 ? usageTokens : 0,
    };
  } catch (e) {
    const isAbort = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      provider: p.id,
      providerLabel: p.label,
      reason: isAbort ? "timeout" : "network_error",
      latencyMs: Date.now() - started,
    };
  }
}

// ─── 状态助手（供 assistant 等路由复用；只暴露布尔与计数）────────────────────
export interface ModelGatewayStatus {
  providers: {
    id: string;
    label: string;
    envVar: string;
    configured: boolean;
    verified: boolean;
  }[];
  configuredCount: number;
  verifiedCount: number;
  totalCount: number;
  probeEnabled: boolean;
  /** iter87：今日 LLM 用量与日上限（向后兼容新增字段） */
  usage: LlmUsageToday;
}

export function getModelGatewayStatus(): ModelGatewayStatus {
  const providers = PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    envVar: p.envVar,
    configured: readKey(p.envVar) !== null,
    verified: isProviderVerified(p.id),
  }));
  return {
    providers,
    configuredCount: providers.filter((p) => p.configured).length,
    verifiedCount: providers.filter((p) => p.verified).length,
    totalCount: providers.length,
    probeEnabled: process.env.MODEL_GATEWAY_PROBE === "1",
    usage: getLlmUsageToday(),
  };
}

// ─── 路由 ────────────────────────────────────────────────────────────────────
export const modelGatewayRouter = createRouter({
  /** status（query）：配置与联网验证状态（布尔级，不含值；触发一次 TTL 探活）。 */
  status: publicQuery.query(async () => {
    await ensureProbed();
    const gw = getModelGatewayStatus();
    const idoConfigured = readIdoKey() !== null;
    const slots = getSlotAssignments();
    const idoVerifiedCount = GATEWAY_MODELS.filter((m) => isIdoModelVerified(m)).length;
    return {
      ...gw,
      ido: {
        label: "海禛云 IDoictOS 统一网关",
        configured: idoConfigured,
        baseUrl: IDO_BASE_URL(),
        models: GATEWAY_MODELS.map((m) => ({ model: m, verified: isIdoModelVerified(m) })),
        verifiedCount: idoVerifiedCount,
        totalCount: GATEWAY_MODELS.length,
        // M67：海禛云 41 模型全量目录下发超终/工作台展示层（只读清单，无密钥）
        catalog: GATEWAY_CATALOG,
        catalogCount: GATEWAY_CATALOG.length,
        slots,
      },
      note:
        (idoConfigured && idoVerifiedCount > 0
          ? `海禛云统一网关已接入，在役模型近 10 分钟验证通过 ${idoVerifiedCount}/${GATEWAY_MODELS.length}；官方四模型 ${gw.configuredCount}/${gw.totalCount} 备用。`
          : idoConfigured
            ? "海禛云统一网关密钥已配置（状态灯为近 10 分钟成功调用锁存；点“五模型健康检查”做实时探测）。"
            : gw.verifiedCount > 0
              ? `四大模型已配置 ${gw.configuredCount}/${gw.totalCount}，已联网验证 ${gw.verifiedCount}/${gw.totalCount}。`
              : gw.configuredCount > 0
                ? `四大模型密钥已配置 ${gw.configuredCount}/${gw.totalCount}（未联网验证）。`
                : "模型密钥尚未配置。"),
    };
  }),

  /**
   * slotPing（mutation，管理员 token）：对五个能力槽位逐个发真实小请求做健康检查。
   * 只回传布尔/状态码/耗时，绝不回传响应体或密钥。
   */
  slotPing: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .mutation(async ({ input }) => {
      await requireAdminToken(input.token);
      const results: { slot: SlotId; model: string; ok: boolean; latencyMs?: number; reason?: string }[] = [];
      const transient = (reason?: string) =>
        !!reason && (reason === "timeout" || reason === "network_error" || /^http_5\d\d$/.test(reason));
      for (const slot of Object.keys(SLOT_MODELS) as SlotId[]) {
        let r = await callSlotChat(slot, {
          messages: [{ role: "user", content: "ping，回复 ok 即可" }],
          maxTokens: 800,
          timeoutMs: 90_000, // 推理模型在网关高峰期需更长的健康检查窗口
        });
        // 网关/上游偶发抖动不判死刑：瞬时错误重试一次，避免把“未验证/抖动”误报成“验证失败”。
        if (!r.ok && transient(r.reason)) {
          await new Promise((resolve) => setTimeout(resolve, 800));
          r = await callSlotChat(slot, {
            messages: [{ role: "user", content: "ping，回复 ok 即可" }],
            maxTokens: 800,
            timeoutMs: 90_000,
          });
        }
        results.push({
          slot,
          model: r.model ?? SLOT_MODELS[slot].model,
          ok: r.ok,
          latencyMs: r.latencyMs,
          reason: r.ok ? undefined : r.reason,
        });
      }
      return { ok: results.every((r) => r.ok), results };
    }),

  /** health（query）：网关自检（不发外部请求）。 */
  health: publicQuery.query(() => {
    const gw = getModelGatewayStatus();
    return {
      ok: true as const,
      configuredCount: gw.configuredCount,
      verifiedCount: gw.verifiedCount,
      totalCount: gw.totalCount,
      probe: gw.probeEnabled ? ("enabled" as const) : ("disabled" as const),
    };
  }),

  /**
   * ping（mutation，管理员 token）：强制重新探活（MODEL_GATEWAY_PROBE=1 才允许）。
   * 只回传 HTTP 状态码与耗时，绝不回传响应体或密钥。
   */
  ping: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .mutation(async ({ input }) => {
      await requireAdminToken(input.token);
      if (process.env.MODEL_GATEWAY_PROBE !== "1") {
        return {
          ok: false as const,
          reason: "probe_disabled" as const,
          message: "联网探活默认关闭：设置 MODEL_GATEWAY_PROBE=1 后由管理员重试。",
          results: [] as unknown[],
        };
      }
      const started = Date.now();
      await ensureProbed(true);
      const gw = getModelGatewayStatus();
      return {
        ok: true as const,
        latencyMs: Date.now() - started,
        results: gw.providers.map((p) => ({
          id: p.id,
          label: p.label,
          configured: p.configured,
          verified: p.verified,
        })),
      };
    }),
});
