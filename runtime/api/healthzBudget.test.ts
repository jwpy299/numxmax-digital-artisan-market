/**
 * healthz 预算降级直测（wb#49 ③，portal 同构面）：
 * 原实现是**模块加载期 `throw`** —— 常量一旦被改错，import 即炸、整个 app 起不来（blast radius 远大于
 * "healthz 自己报红"）。改成"console.error + 降级位 + 503"之后，**不变量不能因此失去看守**，
 * 所以这里用模块级 mock 把 `PROBE_CRITICAL_PATH_MS` 顶到破预算，直接驱动降级路径：
 * ① 降级位为真（且模块**加载成功**——旧实现此处直接 throw）；② `handle()` 返 503 且 `measured:false`；
 * ③ 不占飞行槽（探测工厂不被调用）。另有一条"常量关系"用例把 R26 的不变量钉在测试里。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./queries/healthProbe", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./queries/healthProbe")>();
  // 顶破预算：探测临界 9999ms ≥ HTTP 预算 3000ms
  return { ...orig, PROBE_CRITICAL_PATH_MS: 9_999 };
});

import { HEALTHZ_BUDGET_BROKEN, createHealthzMachine } from "./healthzMachine";
import { PROBE_CRITICAL_PATH_MS } from "./queries/healthProbe";

describe("healthz 预算降级（wb#49 ③）", () => {
  it("① 破预算 ⇒ 降级位为真（且模块**加载成功**——旧实现此处会直接 throw）", () => {
    expect(PROBE_CRITICAL_PATH_MS).toBe(9_999);
    expect(HEALTHZ_BUDGET_BROKEN).toBe(true);
  });

  it("② 降级时 handle() 返 503 且 measured:false（不静默给绿），并**不调用探测工厂**（不占飞行槽）", async () => {
    const factory = vi.fn();
    const m = createHealthzMachine(factory as never);
    const v = await m.handle();
    expect(v.status).toBe(503);
    expect(v.body.ok).toBe(false);
    expect(v.body.measured).toBe(false); // 这一支根本没测，不许冒充实测
    expect(factory).not.toHaveBeenCalled();
  });
});
