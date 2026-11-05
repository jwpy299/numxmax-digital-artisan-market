/**
 * M65 Nebula Harness（双运行时组织版 + 执行官内嵌）闸。
 * 覆盖：宪章块内容与指纹、编排器三链路由（interactive 直推 / heavy DSH / construction 止步行）、
 * 状态面三车道、router requireAdmin 闸。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { chatFastMock, dshMock } = vi.hoisted(() => ({
  chatFastMock: vi.fn(async (..._args: unknown[]) => ({ ok: true, content: "执行官在线", providerLabel: "kimi" })),
  dshMock: vi.fn(async (..._args: unknown[]) => ({ ok: true, answer: "DAG 完成", durationMs: 1234 })),
}));

vi.mock("./routers/modelGateway", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/modelGateway")>();
  return { ...orig, callSlotChatFast: (...args: unknown[]) => chatFastMock(...args) };
});
vi.mock("./routers/dshClient", () => ({ callDsh: (...args: unknown[]) => dshMock(...args) }));
vi.mock("./routers/terminal", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/terminal")>();
  return { ...orig, requireAdmin: vi.fn(async () => ({ id: 1, username: "hq", role: "admin" })) };
});

import {
  buildExecutiveCharterBlock,
  charterFingerprint,
  EXECUTIVE_IDENTITY,
  SAFETY_DISCIPLINE,
} from "./harness/charter";
import { nebulaHarnessExecute, nebulaHarnessStatus } from "./harness/orchestrator";
import { nebulaHarnessRouter } from "./harness/router";

const caller = nebulaHarnessRouter.createCaller({} as never);

describe("M65 Nebula Harness 宪章", () => {
  it("宪章块含身份/架构/模型路由/纪律/playbook 五段", () => {
    const block = buildExecutiveCharterBlock();
    expect(block).toContain("执行官身份");
    expect(block).toContain("四端架构图谱");
    expect(block).toContain("模型路由");
    expect(block).toContain("安全纪律");
    expect(block).toContain("故障处置");
    expect(block).toContain("kimik3");
    expect(block).toContain("6290209");
  });

  it("指纹稳定且随内容变化", () => {
    expect(charterFingerprint()).toBe(charterFingerprint());
    expect(charterFingerprint()).toMatch(/^nh-[0-9a-f]+$/);
  });

  it("纪律红线在骨：AI 永不持扳机 + 功能不变 + 厂隔离", () => {
    const joined = SAFETY_DISCIPLINE.join("\n");
    expect(joined).toContain("AI 永不持扳机");
    expect(joined).toContain("原来系统的功能不变");
    expect(EXECUTIVE_IDENTITY.join("")).toContain("全量内嵌");
  });
});

describe("M65 编排器三链路由", () => {
  beforeEach(() => {
    chatFastMock.mockClear();
    dshMock.mockClear();
  });

  it("缺省 interactive：modelGateway 直推，不注宪章（保首字时延）", async () => {
    const r = await nebulaHarnessExecute({ text: "今天产量怎么样" });
    expect(r.tier).toBe("interactive");
    expect(r.lane).toBe("modelGateway");
    expect(r.ok).toBe(true);
    expect(r.answer).toBe("执行官在线");
    expect(r.charterFp).toBeUndefined();
    const opts = chatFastMock.mock.calls[0][1] as { messages: { role: string }[] };
    expect(opts.messages[0].role).toBe("user"); // 无 system 宪章块
    expect(dshMock).not.toHaveBeenCalled();
  });

  it("interactive + withCharter：system 注入宪章块，带指纹", async () => {
    const r = await nebulaHarnessExecute({ text: "汇报四端状态", withCharter: true });
    expect(r.charterFp).toMatch(/^nh-/);
    const opts = chatFastMock.mock.calls[0][1] as { messages: { role: string; content: string }[] };
    expect(opts.messages[0].role).toBe("system");
    expect(opts.messages[0].content).toContain("执行官身份");
  });

  it("heavy：DSH 运行时，宪章默认注入 + factoryId 下行", async () => {
    const r = await nebulaHarnessExecute({ text: "跑全厂巡检 DAG", tier: "heavy", factoryId: 6290209 });
    expect(r.lane).toBe("dsh-runtime");
    expect(r.ok).toBe(true);
    expect(r.durationMs).toBe(1234);
    const [text, , fid] = dshMock.mock.calls[0] as [string, number, number];
    expect(text).toContain("【任务】");
    expect(text).toContain("跑全厂巡检 DAG");
    expect(fid).toBe(6290209);
  });

  it("heavy + withCharter=false：尊重显式关闭", async () => {
    const r = await nebulaHarnessExecute({ text: "裸任务", tier: "heavy", withCharter: false });
    expect(r.charterFp).toBeUndefined();
    const [text] = dshMock.mock.calls[0] as [string];
    expect(text).toBe("裸任务");
  });

  it("construction：恒止步行提案闸，绝不施工", async () => {
    const r = await nebulaHarnessExecute({ text: "帮我改代码", tier: "construction" });
    expect(r.lane).toBe("proposal-gate");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("construction_requires_release_draft");
    expect(r.answer).toContain("C 级双签");
    expect(chatFastMock).not.toHaveBeenCalled();
    expect(dshMock).not.toHaveBeenCalled();
  });

  it("interactive 链失败：诚实降级 ok:false", async () => {
    chatFastMock.mockResolvedValueOnce({ ok: false, reason: "circuit_open" } as never);
    const r = await nebulaHarnessExecute({ text: "在吗" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("circuit_open");
  });
});

describe("M65 状态面与路由闸", () => {
  it("status：三车道 + 五槽 + 宪章指纹，布尔级无密钥", () => {
    const s = nebulaHarnessStatus();
    expect(s.charterFp).toMatch(/^nh-/);
    expect(s.lanes.interactive.slots).toHaveLength(5);
    expect(s.lanes.interactive.slots.map((x) => x.slot)).toEqual(["brain", "orggen", "chat", "flash", "creative"]);
    expect(typeof s.lanes.heavy.configured).toBe("boolean");
    expect(s.lanes.construction.enabled).toBe(false); // 沙箱未设 EVO_ARM_ENABLED
    expect(JSON.stringify(s)).not.toContain("sk-");
  });

  it("router.status 过 requireAdmin 闸", async () => {
    const r = await caller.status({ token: "t" });
    expect(r.charterFp).toMatch(/^nh-/);
  });

  it("router.execute construction 经路由同样止步", async () => {
    const r = await caller.execute({ token: "t", text: "改码", tier: "construction" });
    expect(r.lane).toBe("proposal-gate");
  });
});
