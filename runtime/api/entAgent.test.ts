/** v152 企业版造人工坊纯规则：模板/厂牌连坐/合规口径 */
import { describe, expect, it } from "vitest";
import { exposureAfterStrike, isValidTemplate, needsComplianceReview, BRAND } from "./routers/entAgent";

describe("模板校验", () => {
  it("五模板合法，其他拒绝", () => {
    for (const t of ["cs","sales","finance","inspect","custom"]) expect(isValidTemplate(t)).toBe(true);
    expect(isValidTemplate("hacker")).toBe(false);
  });
});
describe("厂牌连坐", () => {
  it("strike≥3 降 limited，以下保持 normal", () => {
    expect(exposureAfterStrike(0)).toBe("normal");
    expect(exposureAfterStrike(2)).toBe("normal");
    expect(exposureAfterStrike(3)).toBe("limited");
    expect(BRAND.STRIKE_SCORE).toBe(3.0);
  });
});
describe("合规口径", () => {
  it("industry 必审，enterprise 免审但过牙齿", () => {
    expect(needsComplianceReview("industry")).toBe(true);
    expect(needsComplianceReview("enterprise")).toBe(false);
  });
});
