/** 个人 Agent 训练日任务调度：单飞、失败留痕、超时熔断；卡死时不以新 run 覆盖旧 run。 */
import { runAgentTrainingSweep } from "./agentEmployment";

type AgentSweepResult = Awaited<ReturnType<typeof runAgentTrainingSweep>>;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<AgentSweepResult> | null = null;
let circuitOpen = false;
let allowResume = true;
let schedulerActive = false;
let sweepIntervalMs = 60_000;
let lastSchemaNotReadyLogAt = 0;
const configuredSweepTimeoutMs = Number(process.env.AGENT_TRAINING_SWEEP_TIMEOUT_MS ?? 300_000);
const SWEEP_TIMEOUT_MS = Number.isFinite(configuredSweepTimeoutMs) && configuredSweepTimeoutMs > 0 ? configuredSweepTimeoutMs : 300_000;

function sweepOnce(): Promise<AgentSweepResult> {
  if (circuitOpen) return Promise.reject(new Error("agent_training_sweep_circuit_open"));
  if (inFlight) return inFlight;
  const shouldResume = allowResume && schedulerActive;
  inFlight = (async () => {
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    try {
      watchdog = setTimeout(() => {
        // 超时只熔断调度，不释放在飞 run；进程恢复前不得让新旧结算并发。
        circuitOpen = true;
        if (timer) clearInterval(timer);
        timer = null;
        console.error(`[agent-training] sweep watchdog timeout after ${SWEEP_TIMEOUT_MS}ms; scheduler halted until current run settles`);
      }, SWEEP_TIMEOUT_MS);
      watchdog.unref();
      return await runAgentTrainingSweep();
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 240) : "unknown_error";
      if (message.includes("agent_employment_schema")) {
        if (Date.now() - lastSchemaNotReadyLogAt >= 3_600_000) {
          lastSchemaNotReadyLogAt = Date.now();
          console.error("[agent-training] sweep waiting for additive DDL:", message);
        }
      } else {
        console.error("[agent-training] sweep failed:", message);
      }
      throw err;
    } finally {
      if (watchdog) clearTimeout(watchdog);
      inFlight = null;
      if (circuitOpen) {
        circuitOpen = false;
        if (shouldResume && allowResume && !timer) {
          timer = setInterval(() => { void sweepOnce().catch(() => undefined); }, sweepIntervalMs);
          timer.unref();
        }
      }
    }
  })();
  return inFlight;
}

/** 人工触发也复用同一个在飞 run；熔断时不允许任何新结算。 */
export async function runAgentTrainingSweepOnce(): Promise<AgentSweepResult> {
  return sweepOnce();
}

export function startAgentTrainingScheduler(intervalMs = 60_000): void {
  if (circuitOpen) {
    console.error("[agent-training] scheduler circuit is open while the current run is unsettled");
    return;
  }
  if (timer) return;
  if (!Number.isFinite(intervalMs) || intervalMs < 1_000) throw new Error("agent_training_scheduler_interval_invalid");
  sweepIntervalMs = intervalMs;
  allowResume = true;
  schedulerActive = true;
  void sweepOnce().catch(() => undefined);
  timer = setInterval(() => { void sweepOnce().catch(() => undefined); }, intervalMs);
  timer.unref();
}

export function stopAgentTrainingSchedulerForTest(): void {
  if (timer) clearInterval(timer);
  timer = null;
  circuitOpen = false;
  allowResume = false;
  schedulerActive = false;
  // 不取消、也不遗忘正在执行的 Promise；restart 只能复用它，单飞状态由 finally 收口。
}
