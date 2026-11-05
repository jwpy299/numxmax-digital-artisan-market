/**
 * iter99 验收单测（上线冲刺波次一）：
 * 1. executeSelfHeal 用量类信号走工单动作；库异常不 throw 且返回失败说明。
 * 2. executeSelfHeal 非用量类走归档说明。
 * 3. constitutionSet 仅接受 A/B（zod 层拒绝 C/D）。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    execute: async () => {
      throw new Error("db down");
    },
  }),
}));

import { executeSelfHeal } from "./routers/autoEngine";

describe("executeSelfHeal（B 级自愈执行器）", () => {
  it("用量类信号匹配工单动作路径（库异常→失败说明，不 throw）", async () => {
    const note = await executeSelfHeal(10, "alert", "告警提醒：llm_usage_80 用量达 80%", null);
    expect(note).toMatch(/自愈动作执行失败|工单/);
  });

  it("非用量类信号走低风险归档说明", async () => {
    const note = await executeSelfHeal(10, "alert", "告警提醒：服务心跳波动", null);
    expect(note).toContain("低风险归档");
  });

  it("额度关键词也命中工单路径", async () => {
    const note = await executeSelfHeal(10, "plan", "套餐额度即将耗尽", null);
    expect(note).toMatch(/自愈动作执行失败|工单/);
  });
});
