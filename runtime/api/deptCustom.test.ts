/** v149 企业自定义编制纯规则 */
import { describe, expect, it } from "vitest";
import { isValidCustomDeptCode } from "./routers/deptCustom";

describe("自定义部门码规则", () => {
  it("x_ 前缀+2~10位小写", () => {
    expect(isValidCustomDeptCode("x_design")).toBe(true);
    expect(isValidCustomDeptCode("x_ai2")).toBe(true);
    expect(isValidCustomDeptCode("tech")).toBe(false);     // 平台码不可冒充
    expect(isValidCustomDeptCode("x_")).toBe(false);
    expect(isValidCustomDeptCode("X_design")).toBe(false);
    expect(isValidCustomDeptCode("x_这个部门")).toBe(false);
  });
});
