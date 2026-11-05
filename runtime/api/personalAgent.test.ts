/** v151 个人版分身系统纯规则：晋升/冻结/上架闸 */
import { describe, expect, it } from "vitest";
import { canList, canUnlockSlot, nextSlotState, PROMOTION, shouldFreeze } from "./routers/personalAgent";

describe("晋升解锁", () => {
  it("满2月且评分≥4.0 才解锁", () => {
    expect(canUnlockSlot(2, 4.0)).toBe(true);
    expect(canUnlockSlot(3, 4.5)).toBe(true);
    expect(canUnlockSlot(1, 4.5)).toBe(false); // 时间不够
    expect(canUnlockSlot(2, 3.9)).toBe(false); // 评分不够
    expect(canUnlockSlot(2, null)).toBe(false); // 无评分不达标
    expect(PROMOTION.MAX_SLOTS).toBe(10);
  });
});
describe("低评冻结", () => {
  it("评分<3.5 冻结；无评分不冻", () => {
    expect(shouldFreeze(3.4)).toBe(true);
    expect(shouldFreeze(3.5)).toBe(false);
    expect(shouldFreeze(null)).toBe(false);
  });
});
describe("上架闸", () => {
  it("实习≥10单且评分≥4.2", () => {
    expect(canList(10, 4.2)).toBe(true);
    expect(canList(9, 4.9)).toBe(false);
    expect(canList(12, 4.1)).toBe(false);
  });
});
describe("名额摘要", () => {
  it("有空缺提示造分身，满员提示晋升条件", () => {
    expect(nextSlotState([{ slot_no: 1, state: "used" }, { slot_no: 2, state: "open" }]).openSlots).toBe(1);
    expect(nextSlotState([{ slot_no: 1, state: "used" }]).nextUnlockHint).toContain("2 个月");
  });
});
