import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sweep = vi.hoisted(() => vi.fn(async () => ({ scanned: 0, released: 0, finalized: 0, failedCycles: 0 })));
vi.mock("./agentEmployment", () => ({ runAgentTrainingSweep: sweep }));
import { runAgentTrainingSweepOnce, startAgentTrainingScheduler, stopAgentTrainingSchedulerForTest } from "./agentEmploymentScheduler";

describe("训练调度器清理", () => {
  beforeEach(() => {
    sweep.mockResolvedValue({ scanned: 0, released: 0, finalized: 0, failedCycles: 0 });
  });
  afterEach(() => {
    stopAgentTrainingSchedulerForTest();
    vi.useRealTimers();
    sweep.mockReset();
  });

  it("重复启动不重复建定时器，stop 后不再执行 sweep", async () => {
    vi.useFakeTimers();
    startAgentTrainingScheduler(1_000);
    startAgentTrainingScheduler(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const calls = sweep.mock.calls.length;
    stopAgentTrainingSchedulerForTest();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sweep.mock.calls.length).toBe(calls);
  });

  it("stop 不遗忘在飞 sweep，restart 不得并发重入", async () => {
    vi.useFakeTimers();
    let release!: (value: { scanned: number; released: number; finalized: number; failedCycles: number }) => void;
    sweep.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    startAgentTrainingScheduler(1_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    stopAgentTrainingSchedulerForTest();
    startAgentTrainingScheduler(1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    release({ scanned: 0, released: 0, finalized: 0, failedCycles: 0 });
    await vi.advanceTimersByTimeAsync(0);
    stopAgentTrainingSchedulerForTest();
  });

  it('watchdog 超时熔断后续 tick，且不释放旧 run 造成并发', async () => {
    vi.useFakeTimers();
    let release!: (value: { scanned: number; released: number; finalized: number; failedCycles: number }) => void;
    sweep.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    startAgentTrainingScheduler(1_000);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.some((line) => String(line[0]).includes('scheduler halted'))).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    await expect(runAgentTrainingSweepOnce()).rejects.toThrow('agent_training_sweep_circuit_open');
    release({ scanned: 0, released: 0, finalized: 0, failedCycles: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    stopAgentTrainingSchedulerForTest();
    error.mockRestore();
  });

  it('schema 未就绪日志有节流，不按每分钟刷屏', async () => {
    vi.useFakeTimers();
    sweep.mockRejectedValue(new Error('agent_employment_schema_not_ready'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    startAgentTrainingScheduler(1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  })
});
