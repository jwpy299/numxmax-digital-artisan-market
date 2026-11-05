/** v179 DSH⇄Harness 适配桥（纯映射规则） */
import { describe, expect, it } from "vitest";
import { DSH_MAP, mapEventLevel, mapPrimitive, mayEmitNow, routeTask, sessionKey } from "./harness/dshBridge";

describe("概念映射", () => {
  it("五原语一对一（无多对一防混流）", () => {
    const targets = Object.values(DSH_MAP);
    expect(new Set(targets).size).toBe(targets.length);
    expect(mapPrimitive("task")).toBe("hire_order");
    expect(mapPrimitive("event")).toBe("report_bus");
  });
});
describe("任务路由", () => {
  it("有合约走雇佣工单，无合约走实习练兵", () => {
    expect(routeTask(true)).toBe("hire_order");
    expect(routeTask(false)).toBe("intern_task");
  });
});
describe("汇报纪律桥接", () => {
  it("等级映射 + 免打扰：alert 穿透，info 夜间静默", () => {
    expect(mapEventLevel("critical")).toBe("alert");
    expect(mapEventLevel("info")).toBe("info");
    expect(mayEmitNow("alert", true)).toBe(true);
    expect(mayEmitNow("info", true)).toBe(false);
    expect(mayEmitNow("info", false)).toBe(true);
  });
});
describe("会话钥匙", () => {
  it("同人同人格同线程（跨端续聊）", () => {
    expect(sessionKey(42, "lingshu")).toBe("dsh:u42:lingshu");
    expect(sessionKey(42, "lingshu")).toBe(sessionKey(42, "lingshu"));
  });
});
