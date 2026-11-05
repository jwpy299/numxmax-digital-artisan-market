/** v183 默认六部（新企业注册即开箱可邀） */
import { describe, expect, it } from "vitest";

describe("默认部门", () => {
  it("空申报 → 默认六部（管理/销售/采购/生产/财务/行政）", () => {
    const DEFAULT_DEPARTMENTS = ["管理部", "销售部", "采购部", "生产部", "财务部", "行政部"];
    expect(DEFAULT_DEPARTMENTS).toHaveLength(6);
    expect(DEFAULT_DEPARTMENTS[0]).toBe("管理部");
  });
});
