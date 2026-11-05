/**
 * 身份证号 GB11643 校验位函数断言（迭代 14）。
 * 演示/测试号 110101199003077758：前 17 位加权和 = 246，246 mod 11 = 4，
 * 余数映射 '10X98765432'[4] = '8'，与末位一致 → 合法。
 */
import { describe, expect, it } from "vitest";
import { maskIdCard, verifyIdCard } from "@/lib/idCard";

describe("verifyIdCard（GB11643 加权校验位）", () => {
  it("合法测试号 110101199003077758 通过校验", () => {
    expect(verifyIdCard("110101199003077758")).toBe(true);
  });

  it("末位 X（大小写）按映射表校验", () => {
    // 余数为 2 → 映射 'X'：11010119900307774X（前 17 位加权和 244，244%11=2）
    expect(verifyIdCard("11010119900307774X")).toBe(true);
    expect(verifyIdCard("11010119900307774x")).toBe(true);
  });

  it("校验位错误 / 长度错误 / 非法字符均拒绝", () => {
    expect(verifyIdCard("110101199003077759")).toBe(false); // 校验位错
    expect(verifyIdCard("11010119900307775")).toBe(false); // 17 位
    expect(verifyIdCard("1101011990030777580")).toBe(false); // 19 位
    expect(verifyIdCard("11010119900307775A")).toBe(false); // 非法字符
    expect(verifyIdCard("")).toBe(false);
  });
});

describe("maskIdCard（前4+10*+后4）", () => {
  it("掩码形态正确且不泄露中间段", () => {
    const masked = maskIdCard("110101199003077758");
    expect(masked).toBe("1101**********7758");
    expect(masked).toHaveLength(18);
    expect(masked).not.toContain("19900307");
  });
});
