/** v177 待办中心：紧迫判定与深链（纯规则） */
import { describe, expect, it } from "vitest";
import { isUrgent, todoRef } from "./routers/todoCenter";

describe("紧迫判定", () => {
  it("验收待 24h+ 才急", () => {
    expect(isUrgent("review", 23, null)).toBe(false);
    expect(isUrgent("review", 24, null)).toBe(true);
  });
  it("续约 ≤3 天急", () => {
    expect(isUrgent("renewal", 0, 3)).toBe(true);
    expect(isUrgent("renewal", 0, 7)).toBe(false);
  });
  it("厂牌连坐永远急；合伙人申请不急", () => {
    expect(isUrgent("brand", 0, null)).toBe(true);
    expect(isUrgent("partner", 999, null)).toBe(false);
  });
});
describe("深链", () => {
  it("todo:// 协议五端同认", () => {
    expect(todoRef("review", "HO-42-001")).toBe("todo://review/HO-42-001");
    expect(todoRef("partner", 7)).toBe("todo://partner/7");
  });
});
