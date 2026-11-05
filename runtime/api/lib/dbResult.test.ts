import { describe, expect, it } from "vitest";
import { affectedRowsOf, insertIdOf } from "./dbResult";

describe("dbResult 写结果单源", () => {
  it("affectedRows 兼容 string；insertId 缺值/零值 fail-loud", () => {
    expect(affectedRowsOf([{ affectedRows: "1" }])).toBe(1);
    expect(insertIdOf([{ insertId: 7 }])).toBe(7);
    expect(() => insertIdOf([{ insertId: 0 }])).toThrow("有效 insertId");
    expect(() => insertIdOf([{}])).toThrow("有效 insertId");
  });

  it("形状异常不伪装 0 行；超安全整数 id 直接拒", () => {
    expect(() => affectedRowsOf(undefined)).toThrow("形状无效");
    expect(() => affectedRowsOf([{ affectedRows: "not-a-number" }])).toThrow("有效 affectedRows");
    expect(() => affectedRowsOf([{ affectedRows: null }])).toThrow("有效 affectedRows");
    expect(() => affectedRowsOf([{ affectedRows: false }])).toThrow("有效 affectedRows");
    expect(() => affectedRowsOf([{ affectedRows: [] }])).toThrow("有效 affectedRows");
    expect(() => insertIdOf([{ insertId: "18446744073709551615" }])).toThrow("有效 insertId");
    expect(insertIdOf([{ insertId: Number.MAX_SAFE_INTEGER }])).toBe(Number.MAX_SAFE_INTEGER);
  });
});
