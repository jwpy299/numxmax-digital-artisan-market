/**
 * v148 记忆桥测试：降级纪律（P4）——开关关/无令牌/网关故障全部优雅返回，
 * 绝不抛错阻塞主链；开闸后 recall/capture 走 fetch（假网关断言载荷）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function fresh() {
  vi.resetModules();
  return await import("./harness/memoryBridge");
}

describe("memoryBridge 降级纪律", () => {
  afterEach(() => {
    delete process.env.HARNESS_MEMORY_ENABLED;
    delete process.env.MEMORY_GW_TOKEN;
    vi.unstubAllGlobals();
  });

  it("开关缺省关：recall 返 null，capture 返 false，且不发任何网络请求", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const m = await fresh();
    expect(m.memoryEnabled()).toBe(false);
    expect(await m.recallForContext("q", "s")).toBeNull();
    expect(await m.captureEvent("s", "u", "a")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("开闸但网关 500：recall 返 null 不抛错", async () => {
    process.env.HARNESS_MEMORY_ENABLED = "1";
    process.env.MEMORY_GW_TOKEN = "t";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const m = await fresh();
    expect(m.memoryEnabled()).toBe(true);
    expect(await m.recallForContext("q", "s")).toBeNull();
  });

  it("开闸但网关超时/断网：capture 返 false 不抛错", async () => {
    process.env.HARNESS_MEMORY_ENABLED = "1";
    process.env.MEMORY_GW_TOKEN = "t";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const m = await fresh();
    expect(await m.captureEvent("s", "u", "a")).toBe(false);
  });

  it("开闸正常：recall 返回记忆文本（2000 字符封顶），无命中返 null", async () => {
    process.env.HARNESS_MEMORY_ENABLED = "1";
    process.env.MEMORY_GW_TOKEN = "t-secret-xyz";
    const f = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: "Found 1 confident memories:\n\n- **[instruction]** (score: 0.85)\n  备份件不得入 sites-enabled" }),
    });
    vi.stubGlobal("fetch", f);
    const m = await fresh();
    expect(await m.recallForContext("部署纪律", "s")).toContain("sites-enabled");
    // 无命中口径
    f.mockResolvedValueOnce({ ok: true, json: async () => ({ results: "No matching memories found." }) });
    expect(await m.recallForContext("x", "s")).toBeNull();
    // 令牌进了 Authorization 头，不进 URL
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).not.toContain("t-secret-xyz");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer t-secret-xyz" });
  });
});
