/**
 * Nebula Harness · 运行时编排器（M65）—— 双运行时组织版的任务分级路由。
 *
 * 三条执行链（按任务分级，绝不混跑）：
 * - interactive  交互级：modelGateway 直推（五槽熔断链，海禛云统一 API 供脑）——
 *   问答/解析/轻生成，毫秒~秒级，用户可感知时延主战场；
 * - heavy        重型级：DSH 运行时（dshClient → DSH_RUNTIME_URL 面（dshClient 单源） headless spawn，
 *   MAX_CONC=2 忙线排队）——多步 DAG/长任务，factoryId 下行按厂隔离；
 * - construction 施工级：evoArm 提案流水线（Codex harness 壳，fail-closed 闸）——
 *   代码变更只能挂在 st_releases draft 提案上，C 级双签人工闸，AI 永不持扳机。
 *
 * 纪律：编排器只做"路由+宪章注入+落账"，不重写三条链的任何内部行为
 * （原来系统的功能不变）；所有链失败返回 ok:false 诚实降级，绝不静默假成功。
 */
import { sql } from "drizzle-orm";
import { callSlotChatFast, isIdoModelVerified, SLOT_MODELS, type SlotId } from "../routers/modelGateway";
import { callDsh } from "../routers/dshClient";
import { getDb } from "../queries/connection";
import { armConstruct } from "../routers/evoArm";
import { buildExecutiveCharterBlock, charterFingerprint } from "./charter";
import { captureEvent, recallForContext } from "./memoryBridge";
import { listRuntimes, routeTask, type RuntimeId } from "./runtimes";

export type HarnessTier = "interactive" | "heavy" | "construction";

export interface HarnessTask {
  /** 任务文本（交互级为用户话语；重型级为 DAG 任务描述） */
  text: string;
  /** 分级：缺省 interactive（最保守：交互链最快，重型/施工须显式指定） */
  tier?: HarnessTier;
  /** 企业隔离（heavy 链下行 DSH 进程 env；interactive 链仅审计用） */
  factoryId?: number;
  /** 是否注入执行官宪章（重型/施工默认注入；交互级默认不注——保首字时延） */
  withCharter?: boolean;
  /** M69：施工级真链路——挂 st_releases draft 提案 id（缺省则无，保持纯指引行为） */
  releaseId?: number;
}

export interface HarnessResult {
  ok: boolean;
  tier: HarnessTier;
  /** 实际执行链（construction 无 releaseId 恒为 proposal-gate；带 draft 提案走 codex-runtime 真施工） */
  lane: "modelGateway" | "dsh-runtime" | "codex-runtime" | "proposal-gate";
  answer?: string;
  error?: string;
  durationMs?: number;
  charterFp?: string;
  /** v148：本次重型任务是否注入了组织记忆给养 */
  memoryUsed?: boolean;
  /** M69：施工链产物（branch/diffStat/report），非施工链缺省 */
  arm?: { executor: string; branch: string | null; diffStat: string | null } | undefined;
}

const HEAVY_TIMEOUT_SEC = 300;

/** 交互级：modelGateway chat 槽直推（flash 快车由 M62 modelOverride 在调用方层生效） */
async function runInteractive(task: HarnessTask): Promise<HarnessResult> {
  const r = await callSlotChatFast("chat", {
    messages: [
      ...(task.withCharter
        ? [{ role: "system" as const, content: buildExecutiveCharterBlock() }]
        : []),
      { role: "user" as const, content: task.text },
    ],
    maxTokens: 2048,
    temperature: 0.7,
  });
  return {
    ok: r.ok,
    tier: "interactive",
    lane: "modelGateway",
    answer: r.ok ? r.content : undefined,
    error: r.ok ? undefined : (r.reason ?? "gateway_error"),
    charterFp: task.withCharter ? charterFingerprint() : undefined,
  };
}

/** 重型级：DSH 运行时 spawn（宪章默认注入——执行官内嵌之脑随任务同行） */
async function runHeavy(task: HarnessTask): Promise<HarnessResult> {
  const withCharter = task.withCharter !== false;
  // v148 记忆给养：点火前召回组织记忆注入上下文（缺席/故障静默降级，不阻塞主链）
  const memory = await recallForContext(task.text, `heavy-${task.factoryId ?? "hq"}`);
  const text = withCharter
    ? `${buildExecutiveCharterBlock()}${memory ? `\n\n【组织记忆（召回给养，仅供参酌）】\n${memory}` : ""}\n\n【任务】\n${task.text}`
    : task.text;
  const r = await callDsh(text, HEAVY_TIMEOUT_SEC, task.factoryId);
  // 结果回写记忆（成败都留痕——回滚史同样宝贵）
  void captureEvent(
    `heavy-${task.factoryId ?? "hq"}`,
    `重型任务：${task.text.slice(0, 500)}`,
    `${r.ok ? "成功" : "失败"}（${r.durationMs ?? 0}ms）${r.ok ? "" : `：${(r.error ?? "").slice(0, 300)}`}`,
  );
  return {
    ok: r.ok,
    tier: "heavy",
    lane: "dsh-runtime",
    answer: r.answer,
    error: r.error,
    durationMs: r.durationMs,
    charterFp: withCharter ? charterFingerprint() : undefined,
    memoryUsed: memory != null,
  };
}

/**
 * 施工级（M69 双模，fail-closed 不变）：
 * - 无 releaseId：诚实路由到提案闸指引（M65 行为原样保留）；
 * - 有 releaseId：经 evoArm 抽出的 armConstruct 真施工——仍要求 st_releases draft +
 *   EVO_ARM_ENABLED=1（生产默认关 → 诚实报 evo_arm_disabled，绝不静默假成功）。
 */
async function runConstruction(task: HarnessTask): Promise<HarnessResult> {
  if (!task.releaseId) {
    return {
      ok: false,
      tier: "construction",
      lane: "proposal-gate",
      error: "construction_requires_release_draft",
      answer:
        "施工级任务必须挂 st_releases draft 提案走 evoArm 流水线（C 级双签人工闸）。请经发布中心创建提案后由施工臂执行。",
    };
  }
  if ((process.env.EVO_ARM_ENABLED ?? "").trim() !== "1") {
    return {
      ok: false,
      tier: "construction",
      lane: "codex-runtime",
      error: "evo_arm_disabled",
      answer:
        "Codex 运行时（施工臂）处于 fail-closed 关闭态（生产默认）。提案已受理到闸前；开放需 EVO_ARM_ENABLED=1 且仅限沙箱演练。",
    };
  }
  const started = Date.now();
  const outcome = await armConstruct({
    releaseId: task.releaseId,
    instruction: task.text,
    actor: "nebula-harness",
  });
  return {
    ok: outcome.ok,
    tier: "construction",
    lane: "codex-runtime",
    answer: outcome.report ?? undefined,
    error: outcome.error ?? undefined,
    durationMs: Date.now() - started,
    charterFp: charterFingerprint(),
    arm: { executor: outcome.executor, branch: outcome.branch, diffStat: outcome.diffStat },
  };
}

// ─── M69 统一运行台账（st_harness_runs；元数据级，绝不落任务正文） ───────────

async function ledgerRun(task: HarnessTask, r: HarnessResult): Promise<void> {
  try {
    await getDb().execute(sql`
      INSERT INTO st_harness_runs (tier, lane, factory_id, ok, error, duration_ms, charter_fp, text_len)
      VALUES (${r.tier}, ${r.lane}, ${task.factoryId ?? null}, ${r.ok ? 1 : 0},
        ${(r.error ?? "").slice(0, 190) || null}, ${r.durationMs ?? null},
        ${r.charterFp ?? null}, ${task.text.length})`);
  } catch {
    // 表未建/库抖动：台账是观测面，绝不阻塞执行链（火后即忘）
  }
}

/** Nebula Harness 统一入口：任务分级路由（缺省 interactive，行为零惊喜） */
export async function nebulaHarnessExecute(task: HarnessTask): Promise<HarnessResult> {
  const tier = task.tier ?? "interactive";
  const r = tier === "heavy"
    ? await runHeavy(task)
    : tier === "construction"
      ? await runConstruction(task)
      : await runInteractive(task);
  await ledgerRun(task, r);
  return r;
}

/** M69 auto 路由建议（纯函数外发，四端同一口径） */
export function nebulaHarnessRoute(text: string) {
  return routeTask(text);
}

/** M69 运行台账查询（Ops 控制台用；新→旧，元数据级） */
export async function nebulaHarnessRuns(limit = 20): Promise<{
  ok: boolean;
  items: Array<Record<string, unknown>>;
}> {
  try {
    const res = (await getDb().execute(sql`
      SELECT id, tier, lane, factory_id, ok, error, duration_ms, charter_fp, text_len, created_at
      FROM st_harness_runs ORDER BY id DESC LIMIT ${Math.max(1, Math.min(100, limit))}`)) as unknown;
    const first = Array.isArray(res) ? (res as unknown[])[0] : res;
    return { ok: true, items: Array.isArray(first) ? (first as Array<Record<string, unknown>>) : [] };
  } catch {
    return { ok: false, items: [] }; // 表未建：诚实空面，不报错炸 UI
  }
}

// ─── M69 自进化回路状态面（信号→提案→draft→施工→双签→verified） ──────────────

export interface EvolutionLoopState {
  ok: boolean;
  /** 24h 信号数（st_evo_signals） */
  signals24h: number;
  /** 提案按状态计数（st_evo_proposals） */
  proposals: Record<string, number>;
  /** 版本提案按状态计数（st_releases：draft/verified/released…） */
  releases: Record<string, number>;
  /** 最近一次施工（st_release_audit action='arm:run'） */
  lastArmRun: { id: number; releaseId: number | null; actor: string; createdAt: string } | null;
  /** 回路阶段灯：四段各就位即自进化闭环转起来了 */
  stages: { signal: boolean; proposal: boolean; draft: boolean; arm: boolean };
}

export async function nebulaHarnessEvolution(): Promise<EvolutionLoopState> {
  const empty: EvolutionLoopState = {
    ok: false, signals24h: 0, proposals: {}, releases: {}, lastArmRun: null,
    stages: { signal: false, proposal: false, draft: false, arm: false },
  };
  const db = getDb();
  const rowsOf = (res: unknown): Array<Record<string, unknown>> => {
    const first = Array.isArray(res) ? (res as unknown[])[0] : res;
    return Array.isArray(first) ? (first as Array<Record<string, unknown>>) : [];
  };
  try {
    const [sig, prop, rel, arm] = await Promise.all([
      db.execute(sql`SELECT count(*) AS c FROM st_evo_signals
        WHERE created_at >= NOW() - INTERVAL 24 HOUR`).catch(() => null),
      db.execute(sql`SELECT status, count(*) AS c FROM st_evo_proposals GROUP BY status`).catch(() => null),
      db.execute(sql`SELECT status, count(*) AS c FROM st_releases GROUP BY status`).catch(() => null),
      db.execute(sql`SELECT id, release_id, actor, created_at FROM st_release_audit
        WHERE action = 'arm:run' ORDER BY id DESC LIMIT 1`).catch(() => null),
    ]);
    const sigRows = sig ? rowsOf(sig) : [];
    const propRows = prop ? rowsOf(prop) : [];
    const relRows = rel ? rowsOf(rel) : [];
    const armRows = arm ? rowsOf(arm) : [];
    const toMap = (rows: Array<Record<string, unknown>>) =>
      Object.fromEntries(rows.map((r) => [String(r.status), Number(r.c)]));
    const lastArm = armRows[0];
    return {
      ok: true,
      signals24h: Number(sigRows[0]?.c ?? 0),
      proposals: toMap(propRows),
      releases: toMap(relRows),
      lastArmRun: lastArm
        ? {
            id: Number(lastArm.id),
            releaseId: lastArm.release_id == null ? null : Number(lastArm.release_id),
            actor: String(lastArm.actor ?? ""),
            createdAt: String(lastArm.created_at ?? ""),
          }
        : null,
      stages: {
        signal: Number(sigRows[0]?.c ?? 0) > 0,
        proposal: propRows.length > 0,
        draft: relRows.some((r) => String(r.status) === "draft" && Number(r.c) > 0)
          || relRows.length > 0,
        arm: armRows.length > 0,
      },
    };
  } catch {
    return empty; // 库不可达：诚实空面
  }
}

/** Harness 状态面：三运行时健康一眼看全（Ops 看板用；布尔级，绝不含密钥值） */
export function nebulaHarnessStatus(): {
  charterFp: string;
  lanes: {
    interactive: { ready: boolean; slots: { slot: SlotId; model: string; label: string; verified: boolean }[] };
    heavy: { ready: boolean; configured: boolean };
    construction: { ready: boolean; enabled: boolean; executor: string };
  };
  /** M69：双运行时注册表面（DSH × Codex，origin/钉版/能力/健康） */
  runtimes: {
    id: RuntimeId; name: string; origin: string; versionPin: string; role: string;
    lane: string; capabilities: readonly string[];
    health: { configured: boolean; ready: boolean; detail: string };
  }[];
} {
  const idoReady = Boolean((process.env.IDOICTOS_API_KEY ?? "").trim());
  const slots = (Object.keys(SLOT_MODELS) as SlotId[]).map((slot) => {
    const def = SLOT_MODELS[slot];
    const model = (process.env[def.envOverride] ?? "").trim() || def.model;
    return { slot, model, label: def.label, verified: isIdoModelVerified(model) };
  });
  const dshConfigured = Boolean((process.env.DSH_SERVICE_TOKEN ?? "").trim());
  return {
    charterFp: charterFingerprint(),
    lanes: {
      interactive: { ready: idoReady, slots },
      heavy: { configured: dshConfigured, ready: dshConfigured },
      construction: {
        enabled: process.env.EVO_ARM_ENABLED === "1",
        executor: (process.env.EVO_ARM_EXECUTOR ?? "mock").trim() || "mock",
        ready: process.env.EVO_ARM_ENABLED === "1",
      },
    },
    runtimes: listRuntimes().map((r) => ({
      id: r.id,
      name: r.name,
      origin: r.origin,
      versionPin: r.versionPin,
      role: r.role,
      lane: r.lane,
      capabilities: r.capabilities,
      health: r.health(),
    })),
  };
}
