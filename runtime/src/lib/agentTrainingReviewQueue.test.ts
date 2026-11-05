import { describe, expect, it } from "vitest";
import {
  isDeterministicReviewRejection,
  reconcileCompletedReviewIds,
} from "./agentTrainingReviewQueue";

describe("训练复核完成项回读对账", () => {
  it("仍在待审队列的完成项恢复可操作，已消失项允许清理", () => {
    expect(
      reconcileCompletedReviewIds(new Set([1, 2, 3]), new Set([2])),
    ).toEqual({ reactivate: [2], finished: [1, 3] });
  });
  it("回读仍全部可见时不得静默吞掉队列项", () => {
    expect(
      reconcileCompletedReviewIds(new Set([7, 8]), new Set([7, 8])).reactivate,
    ).toEqual([7, 8]);
  });
});

describe("复核提交错误分类", () => {
  it("确定 4xx 拒绝保留草稿，网络/5xx 才属于结果未知", () => {
    expect(
      isDeterministicReviewRejection({ data: { code: "FORBIDDEN" } }),
    ).toBe(true);
    expect(
      isDeterministicReviewRejection({
        data: { code: "UNPROCESSABLE_CONTENT" },
      }),
    ).toBe(true);
    expect(isDeterministicReviewRejection({ data: { httpStatus: 409 } })).toBe(
      true,
    );
    expect(
      isDeterministicReviewRejection({
        data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
      }),
    ).toBe(false);
    expect(isDeterministicReviewRejection(new Error("network timeout"))).toBe(
      false,
    );
  });
});
