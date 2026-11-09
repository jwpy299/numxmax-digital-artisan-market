/**
 * dshClient —— DSH 服务调用唯一出口（dagRuns 与 agentBridge 共用，防循环依赖）。
 *
 * 链路：本机 127.0.0.1:18795（dsh-sandbox-runtime 本机直打——18790 是 dsh-tunnel 至 S3 的旧隧道面：S3 死/隧道停=18790 永不可达=DSH 轨全灭面封死，彭总 2026-10-12 钉）→ spawn headless 会话。
 * M38：factoryId 随任务下行 → server.mjs 以 LINGSHU_FACTORY_ID 注入 DSH 进程 env
 * → MCP 工具面按厂隔离（每厂只见本厂插件/技能/部门工具）。
 * 纪律：token 仅 env（DSH_SERVICE_TOKEN），失败返回 ok:false（上层确定性降级，绝不炸主链）。
 */

/** DSH runtime 端点（env 化 DSH_RUNTIME_URL——缺省本机 18795；18790 是旧隧道面废，wb#69 钉） */
export const DSH_RUNTIME_URL = (process.env.DSH_RUNTIME_URL?.trim() || "http://127.0.0.1:18795"); // 端点外置单源（env 空串=兜默认——??只兜 nullish 面封死，门禁 wb#71 钉；runtimes/Ops 文案面同引本常量=不双源漂移）
export interface DshCallResult {
  ok: boolean;
  answer?: string;
  error?: string;
  durationMs?: number;
  stationKey?: string;
  modelOverride?: string;
}

const BUSY_RETRIES = 3;
const BUSY_WAIT_MS = 15_000;

export async function callDsh(task: string, timeoutSec = 300, factoryId?: number, modelOverride?: string, stationKey?: string): Promise<DshCallResult> {
  const token = (process.env.DSH_SERVICE_TOKEN ?? "").trim();
  if (!token) return { ok: false, error: "dsh_not_configured" };
  // M52：DSH 底座并发上限 MAX_CONC=2，429 busy 时排队重试（3×15s），
  // 把"忙线即失败"改为"排队等位"，超队仍诚实报 busy
  for (let attempt = 0; attempt <= BUSY_RETRIES; attempt++) {
    try {
      const res = await fetch(`${DSH_RUNTIME_URL}/run`, { // 端点外置（门禁 wb#69 部署面钉——与 stationPool HARNESS_POOL_URL 同律）
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ task, timeoutSec, factoryId, ...(modelOverride ? { modelOverride } : {}), ...(stationKey ? { stationKey } : {}) }),
        signal: AbortSignal.timeout((timeoutSec + 30) * 1000),
      });
      const j = (await res.json()) as { ok?: boolean; answer?: string; error?: string; detail?: string; durationMs?: number };
      if (res.status === 429 && j.error === "busy" && attempt < BUSY_RETRIES) {
        await new Promise((r) => setTimeout(r, BUSY_WAIT_MS));
        continue;
      }
      if (!res.ok) return { ok: false, error: j.error ?? `http_${res.status}` };
      return { ok: j.ok === true, answer: j.answer, error: j.error ?? j.detail, durationMs: j.durationMs, ...(stationKey ? { stationKey } : {}), ...(modelOverride ? { modelOverride } : {}) };
    } catch (e) {
      return { ok: false, error: e instanceof Error && e.name === "AbortError" ? "dsh_timeout" : "dsh_network_error" };
    }
  }
  return { ok: false, error: "busy" };
}
