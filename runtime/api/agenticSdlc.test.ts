/** v163 AI-Native SDLC 预审判定解析 */
import { describe, expect, it } from "vitest";
import { parseReviewVerdict } from "./harness/agenticSdlc";

describe("预审判定解析", () => {
  it("可行→pass，风险行入列", () => {
    const v = parseReviewVerdict("判定：可行\n风险：跨厂数据未隔离\n风险：性能未测");
    expect(v.verdict).toBe("pass");
    expect(v.risks.length).toBe(2);
  });
  it("不可行/高危→reject", () => {
    expect(parseReviewVerdict("判定：不可行，高危").verdict).toBe("reject");
  });
  it("中性→warn", () => {
    expect(parseReviewVerdict("判定：待定").verdict).toBe("warn");
  });
});
