/**
 * M36 UGC 本地初筛单测：
 * 1. 正常企业内容全放行（合同/排产/发票正常业务词）。
 * 2. 违禁词命中 → 拦截 + 人话文案（不泄露命中词）。
 * 3. 空文本放行。
 */
import { describe, expect, it } from "vitest";
import { screenText } from "./routers/contentScreen";

describe("M36 内容初筛", () => {
  it("正常内容放行", () => {
    expect(screenText("生产部排产表 2026-08").ok).toBe(true);
    expect(screenText("关于签订采购合同的函").ok).toBe(true);
    expect(screenText("").ok).toBe(true);
  });
  it("违禁内容拦截且文案不泄露命中词", () => {
    const r = screenText("代开发票 联络");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("人工复审");
    expect(r.reason).not.toContain("发票");
  });
});
