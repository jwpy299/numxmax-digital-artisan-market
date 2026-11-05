import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.stubEnv("ECONOMY_MODE", "test"));
afterEach(() => vi.unstubAllEnvs());
import {
  MAX_TRAINING_ATTEMPTS,
  JOB_TOKEN_CNY_CENTS,
  REGISTRATION_FEE_JOB_TOKENS,
  RETAKE_FEE_JOB_TOKENS,
  REGISTRATION_FEE_CENTS,
  RETAKE_FEE_CENTS,
  TRAINING_TASK_BANK,
  attemptFeeCents,
  attemptFeeJobTokens,
  canAccessEmployment,
  canTransitionClaim,
  evaluateCycle,
  evidenceSha256,
  outcomeAfterCycle,
  outcomeAfterFailedCycle,
  normalizeRefundFailureCode,
  trainingTaskForDay,
} from "./agentEmploymentDomain";

describe("个人 Agent 收费规则", () => {
  it("首次 99 元，第 2—8 次各 1 元，第 9 次 fail-closed", () => {
    expect(attemptFeeCents(1)).toBe(REGISTRATION_FEE_CENTS);
    expect(attemptFeeCents(1)).toBe(9900);
    expect(attemptFeeJobTokens(1)).toBe(REGISTRATION_FEE_JOB_TOKENS);
    expect(attemptFeeJobTokens(1)).toBe(990);
    expect(REGISTRATION_FEE_JOB_TOKENS * JOB_TOKEN_CNY_CENTS).toBe(REGISTRATION_FEE_CENTS);
    for (let attempt = 2; attempt <= MAX_TRAINING_ATTEMPTS; attempt += 1) {
      expect(attemptFeeCents(attempt)).toBe(RETAKE_FEE_CENTS);
      expect(attemptFeeCents(attempt)).toBe(100);
      expect(attemptFeeJobTokens(attempt)).toBe(RETAKE_FEE_JOB_TOKENS);
      expect(attemptFeeJobTokens(attempt)).toBe(10);
    }
    expect(() => attemptFeeCents(0)).toThrow("training_attempt_out_of_range");
    expect(() => attemptFeeCents(9)).toThrow("training_attempt_out_of_range");
    expect(() => attemptFeeCents(1.5)).toThrow("training_attempt_out_of_range");
  });
});

describe("七天隔离周期", () => {
  it("题库正好七个版本化任务且键不重复", () => {
    expect(TRAINING_TASK_BANK).toHaveLength(7);
    expect(new Set(TRAINING_TASK_BANK.map((task) => task.taskKey)).size).toBe(7);
    expect(trainingTaskForDay(7).taskKey).toContain("day7");
    expect(() => trainingTaskForDay(8)).toThrow("training_day_out_of_range");
  });
});

describe("独立评分与资格迁移", () => {
  it("缺任一每日评分都不是完成或达标", () => {
    expect(evaluateCycle([100, 100, 100, 100, 100, 100])).toEqual({ complete: false, passed: false, score: null });
    expect(evaluateCycle([100, 100, 100, 100, 100, 100, Number.NaN]).complete).toBe(false);
  });
  it("平均分达标但单日低于底线也不通过", () => {
    const result = evaluateCycle([100, 100, 100, 100, 100, 100, 59]);
    expect(result.complete).toBe(true);
    expect(result.score).toBe(94);
    expect(result.passed).toBe(false);
  });
  it("七项完整且满足分数线才通过", () => {
    expect(evaluateCycle([80, 80, 80, 80, 80, 80, 80])).toEqual({ complete: true, passed: true, score: 80 });
  });
  it("达标即合格；第八次失败才淘汰", () => {
    const scores = Array(7).fill(80);
    expect(outcomeAfterCycle({ attemptNo: 1, passed: true, scores })).toBe("qualified");
    expect(outcomeAfterCycle({ attemptNo: 1, passed: false, scores })).toBe("awaiting_retake");
    expect(outcomeAfterCycle({ attemptNo: 7, passed: false, scores })).toBe("awaiting_retake");
    expect(outcomeAfterCycle({ attemptNo: 8, passed: false, scores })).toBe("disqualified");
    expect(outcomeAfterFailedCycle(7)).toBe("awaiting_retake");
    expect(outcomeAfterFailedCycle(8)).toBe("disqualified");
    expect(() => outcomeAfterFailedCycle(9)).toThrow("training_attempt_out_of_range");
    expect(() => outcomeAfterCycle({ attemptNo: 8, passed: false, scores: [80] })).toThrow("training_cycle_incomplete");
  });
  it("只有 qualified 获得就业准入，付费或训练中均无权限", () => {
    expect(canAccessEmployment("pending_payment")).toBe(false);
    expect(canAccessEmployment("training")).toBe(false);
    expect(canAccessEmployment("disqualified")).toBe(false);
    expect(canAccessEmployment("qualified")).toBe(true);
  });
});

describe("退款失败错误掩码", () => {
  it("保留已知业务码，原始驱动与连接细节不得进入数据面", () => {
    expect(normalizeRefundFailureCode(new Error("registration_refund_amount_invalid"))).toBe("registration_refund_amount_invalid");
    const masked = normalizeRefundFailureCode(new Error("connect ECONNREFUSED 127.0.0.1:3306; SELECT * FROM secret_table"));
    expect(masked).toBe("registration_refund_transient_failure");
    expect(masked).not.toContain("ECONNREFUSED");
    expect(masked).not.toContain("SELECT");
    expect(normalizeRefundFailureCode("raw driver text")).toBe("registration_refund_transient_failure");
  });
});

describe("交付与工资状态边界", () => {
  it("claimed 不能直接 accepted，submitted 才可验收", () => {
    expect(canTransitionClaim("claimed", "accepted")).toBe(false);
    expect(canTransitionClaim("claimed", "submitted")).toBe(true);
    expect(canTransitionClaim("submitted", "accepted")).toBe(true);
    expect(canTransitionClaim("submitted", "rejected")).toBe(true);
    expect(canTransitionClaim("accepted", "submitted")).toBe(false);
    expect(canTransitionClaim("rejected", "submitted")).toBe(true);
    expect(canTransitionClaim("rejected", "claimed")).toBe(true);
    expect(canTransitionClaim("rejected", "revoked")).toBe(true);
    expect(canTransitionClaim("revoked", "submitted")).toBe(false);
  });
  it("证据哈希稳定且空交付被拒绝", () => {
    expect(evidenceSha256("真实交付与回读值")).toMatch(/^[0-9a-f]{64}$/);
    expect(evidenceSha256("相同内容")).toBe(evidenceSha256("相同内容"));
    expect(() => evidenceSha256("   ")).toThrow("delivery_evidence_required");
  });
});
