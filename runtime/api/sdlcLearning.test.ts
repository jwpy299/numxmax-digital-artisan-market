/** v165 学习环第二步：结果对账判定口径（纯函数） */
import { describe, expect, it } from "vitest";
import { accuracyOf, outcomeOf, OBSERVE_DAYS } from "./harness/sdlcLearning";

describe("对账判定", () => {
  it("回滚审计在案 → incident（不看状态不看账龄）", () => {
    expect(outcomeOf({ releaseStatus: "published", hasRollbackAudit: true, ageDays: 1 })?.outcome).toBe("incident");
  });
  it("发布状态 rolled_back → incident", () => {
    expect(outcomeOf({ releaseStatus: "rolled_back", hasRollbackAudit: false, ageDays: 0 })?.outcome).toBe("incident");
  });
  it("verified + 观察期满 → clean", () => {
    const r = outcomeOf({ releaseStatus: "verified", hasRollbackAudit: false, ageDays: OBSERVE_DAYS });
    expect(r?.outcome).toBe("clean");
    expect(r?.evidence).toContain("观察期");
  });
  it("published + 观察期满 → clean", () => {
    expect(outcomeOf({ releaseStatus: "published", hasRollbackAudit: false, ageDays: OBSERVE_DAYS + 3 })?.outcome).toBe("clean");
  });
  it("观察期内不结案（返回 null，下轮再对）", () => {
    expect(outcomeOf({ releaseStatus: "verified", hasRollbackAudit: false, ageDays: 2 })).toBeNull();
  });
  it("draft 状态永不结案", () => {
    expect(outcomeOf({ releaseStatus: "draft", hasRollbackAudit: false, ageDays: 30 })).toBeNull();
  });
});

describe("预审准星", () => {
  it("三率计算正确", () => {
    const r = accuracyOf([
      { verdict: "pass", outcome: "clean" },
      { verdict: "pass", outcome: "incident" }, // 漏判
      { verdict: "reject", outcome: "clean" }, // 误判
      { verdict: "warn", outcome: "clean" },
    ]);
    expect(r).toEqual({ total: 4, accuracy: 50, missRate: 25, falseRate: 25 });
  });
  it("空账零除保护", () => {
    expect(accuracyOf([])).toEqual({ total: 0, accuracy: 0, missRate: 0, falseRate: 0 });
  });
});
