/** v180 企业舱位制（纯规则） */
import { describe, expect, it } from "vitest";
import { INDUSTRY_PRESETS, isValidCabinCode, PRESET_CODES } from "./routers/entCabin";

describe("舱码规则", () => {
  it("行业预置码放行", () => {
    expect(isValidCabinCode("produce")).toBe(true);
    expect(isValidCabinCode("finance")).toBe(true);
  });
  it("x_ 自建码放行，乱码拒", () => {
    expect(isValidCabinCode("x_logistics")).toBe(true);
    expect(isValidCabinCode("生产")).toBe(false);
    expect(isValidCabinCode("")).toBe(false);
  });
});
describe("行业预置舱图", () => {
  it("制造业六舱：生产/质量/采购/销售/财务/行政", () => {
    const names = INDUSTRY_PRESETS.manufacturing.map((c) => c.name);
    expect(names).toEqual(["生产舱", "质量舱", "采购舱", "销售舱", "财务舱", "行政舱"]);
  });
  it("预置码集合与三行业一致", () => {
    expect(PRESET_CODES.has("produce")).toBe(true);
    expect(PRESET_CODES.has("ops")).toBe(true);
    expect(PRESET_CODES.has("x_custom")).toBe(false);
  });
});
