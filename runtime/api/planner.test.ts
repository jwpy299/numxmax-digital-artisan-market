/**
 * M7-d 集群规划骨架验收单测：
 * 1. 步骤校验：白名单外动作被拒（含递归元意图自身）。
 * 2. 步骤校验：dept 必须是本厂真实部门，幽灵部门被拒。
 * 3. AI 拆解：LLM 返回合法步骤数组 → 解析为 PlanStep（seq 重排、payload 兜底、reason 截断）。
 * 4. AI 拆解：LLM 故障/非数组输出 → 抛出可读错误，绝不产出空计划。
 * 5. 拆解输出不允许超过 5 步。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const chatMock = vi.fn();

vi.mock("./routers/modelGateway", () => ({
  callSlotChat: (...args: unknown[]) => chatMock(...args),
}));
vi.mock("./queries/connection", () => ({ getDb: () => ({ execute: async () => [[]] }) }));

import { decomposeGoal, validateSteps, type PlanStep } from "./routers/planner";

const protocols = [
  { code: "sandbox_dispatch", name: "沙箱训练派单", level: "B" },
  { code: "device_rehearsal", name: "设备预演工单", level: "B" },
  { code: "llm_limit_adjust", name: "全厂LLM限额调整", level: "C" },
];
const depts = ["总经办", "生产部", "质检部"];

beforeEach(() => chatMock.mockReset());

describe("步骤校验（validateSteps）", () => {
  const base: PlanStep = { seq: 1, actionType: "sandbox_dispatch", payload: { instruction: "x", skillKey: "k" }, dept: "生产部", reason: "训练" };

  it("白名单内 + 真实部门 → 通过", () => {
    expect(validateSteps([base], protocols, depts)).toEqual([]);
  });

  it("白名单外动作 → 拒绝", () => {
    const errs = validateSteps([{ ...base, actionType: "hack_all" }], protocols, depts);
    expect(errs.join()).toMatch(/不在白名单/);
  });

  it("递归元意图自身 → 拒绝", () => {
    const errs = validateSteps([{ ...base, actionType: "intent_plan_submit" }], protocols, depts);
    expect(errs.join()).toMatch(/不在白名单/);
  });

  it("幽灵部门 → 拒绝", () => {
    const errs = validateSteps([{ ...base, dept: "不存在的部" }], protocols, depts);
    expect(errs.join()).toMatch(/不在本厂部门清单/);
  });

  it("dept=null 放行（跨部门由中枢统筹）", () => {
    expect(validateSteps([{ ...base, dept: null }], protocols, depts)).toEqual([]);
  });
});

describe("AI 拆解（decomposeGoal）", () => {
  it("合法 JSON 数组 → PlanStep（seq 重排连续）", async () => {
    chatMock.mockResolvedValue({
      ok: true,
      content: '[{"seq":5,"actionType":"sandbox_dispatch","payload":{"instruction":"巡检训练","skillKey":"dev-check"},"dept":"生产部","reason":"先练兵"},{"seq":9,"actionType":"device_rehearsal","payload":{"deviceName":"三号机"},"dept":"生产部","reason":"再开工单"}]',
    });
    const steps = await decomposeGoal("让军团训练设备巡检并给三号机开工单", protocols, depts);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.seq).toBe(1);
    expect(steps[1]!.seq).toBe(2);
    expect(steps[0]!.actionType).toBe("sandbox_dispatch");
    expect(steps[1]!.payload).toEqual({ deviceName: "三号机" });
    expect(validateSteps(steps, protocols, depts)).toEqual([]);
  });

  it("LLM 故障 → 抛错，不产出空计划", async () => {
    chatMock.mockResolvedValue({ ok: false, reason: "daily_cap" });
    await expect(decomposeGoal("降限额", protocols, depts)).rejects.toThrow(/规划器暂时不可用/);
  });

  it("LLM 输出非数组 → 抛错", async () => {
    chatMock.mockResolvedValue({ ok: true, content: '{"not":"array"}' });
    await expect(decomposeGoal("降限额", protocols, depts)).rejects.toThrow();
  });

  it("超过 5 步截断为 5 步", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ seq: i + 1, actionType: "sandbox_dispatch", payload: {}, dept: null, reason: `s${i}` }));
    chatMock.mockResolvedValue({ ok: true, content: JSON.stringify(many) });
    const steps = await decomposeGoal("一堆任务", protocols, depts);
    expect(steps).toHaveLength(5);
  });
});
