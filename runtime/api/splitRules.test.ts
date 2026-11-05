import { describe, it, expect } from "vitest";
import { computeSplit, DEFAULT_RULES } from "./routers/splitRules";

describe("#19 分账规则", () => {
  it("默认规则表完整（雇佣/工单/租赁/商城/推荐）", () => {
    const bizs = new Set(DEFAULT_RULES.map((r) => r.biz));
    expect([...bizs].sort()).toEqual(["hire", "mall", "order_settle", "referral", "rental"].sort());
  });
  it("雇佣默认 15/85，分毫不差", () => {
    const r = computeSplit(10000, 1500, 8500);
    expect(r).toEqual({ platform: 1500, supply: 8500, referrer: 0 });
  });
  it("推荐人 5% 从平台出：供给侧不动", () => {
    const r = computeSplit(10000, 1500, 8500, 500);
    expect(r.referrer).toBe(500);
    expect(r.platform).toBe(1000); // 1500-500
    expect(r.supply).toBe(8500);   // 供给侧分毫不动
  });
  it("奇数金额无尾差", () => {
    const r = computeSplit(999, 1500, 8500, 500);
    expect(r.platform + r.supply + r.referrer).toBe(999);
  });
  it("租赁 20/80、商城 30/70", () => {
    expect(computeSplit(10000, 2000, 8000).supply).toBe(8000);
    expect(computeSplit(10000, 3000, 7000).platform).toBe(3000);
  });
});
