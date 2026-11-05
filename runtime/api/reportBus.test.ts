/** v148 汇报总线纯规则：免打扰窗（含跨夜） */
import { describe, expect, it } from "vitest";
import { inQuietHours } from "./routers/reportBus";

describe("reportBus 免打扰", () => {
  it("跨夜窗 22:00-08:00", () => {
    expect(inQuietHours("23:30", "22:00", "08:00")).toBe(true);
    expect(inQuietHours("07:59", "22:00", "08:00")).toBe(true);
    expect(inQuietHours("12:00", "22:00", "08:00")).toBe(false);
    expect(inQuietHours("22:00", "22:00", "08:00")).toBe(true);
  });
  it("同日窗与关闭窗", () => {
    expect(inQuietHours("13:00", "12:00", "14:00")).toBe(true);
    expect(inQuietHours("15:00", "12:00", "14:00")).toBe(false);
    expect(inQuietHours("12:00", "00:00", "00:00")).toBe(false); // 起=止 视为关闭
  });
});
