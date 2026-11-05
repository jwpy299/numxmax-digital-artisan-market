/** v160 物理 MCP 注册中心纯规则：manifest 校验清洗 + cap 映射分级 */
import { describe, expect, it } from "vitest";
import { parseManifest, capOfTool } from "./routers/deviceMcp";

describe("manifest 校验清洗", () => {
  it("合法 manifest 通过并消毒", () => {
    const m = parseManifest({ device_class: "printer", tools: [{ name: "print_document", desc: "打印<script>alert(1)</script>", level: "B", schema: { type: "object" } }] });
    expect(m.device_class).toBe("printer");
    expect(m.tools[0]!.desc).not.toContain("<script>");
  });
  it("缺类/空工具/级别非法/工具名非法全拒", () => {
    expect(() => parseManifest({ tools: [] })).toThrow();
    expect(() => parseManifest({ device_class: "x", tools: [] })).toThrow();
    expect(() => parseManifest({ device_class: "x", tools: [{ name: "!!", desc: "", level: "B" }] })).toThrow();
  });
  it("超 20 工具拒收", () => {
    const tools = Array.from({ length: 21 }, (_, i) => ({ name: `t${i}`, desc: "", level: "B" }));
    expect(() => parseManifest({ device_class: "x", tools })).toThrow();
  });
});
describe("cap 映射分级（与指令面同构）", () => {
  it("B/C 分级正确", () => {
    expect(capOfTool("print_document").level).toBe("B");
    expect(capOfTool("snapshot").level).toBe("B");
    expect(capOfTool("open_gate").level).toBe("C");
    expect(capOfTool("run_script").level).toBe("C");
    expect(capOfTool("read_sensor").level).toBe("C"); // plugin_invoke 触 LAN 为 C
    expect(capOfTool("未登记工具").level).toBe("C"); // 默认最严
  });
});
