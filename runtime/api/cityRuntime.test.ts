/** v172 城市运营官：状态机与晨报文案（确定性） */
import { describe, expect, it } from "vitest";
import { cityDailyCopy, officerState } from "./routers/cityRuntime";

describe("运营官状态机", () => {
  it("有点亮=在岗，空城=观察中（如实不装忙）", () => {
    expect(officerState({ enterprises: 3, users: 0, todayNew: 0, weeklyDeliveries: 9 })).toBe("on_duty");
    expect(officerState({ enterprises: 0, users: 0, todayNew: 0, weeklyDeliveries: 0 })).toBe("observing");
  });
});

describe("城市晨报", () => {
  it("有数据：数字全来自 KPI", () => {
    const c = cityDailyCopy("佛枢", "佛山", { enterprises: 3, users: 1, todayNew: 2, weeklyDeliveries: 9 });
    expect(c.title).toContain("佛山晨报");
    expect(c.title).toContain("佛枢");
    expect(c.body).toContain("昨日新增点亮 2");
    expect(c.body).toContain("9 单");
  });
  it("空城：待拓口径不编造数字", () => {
    const c = cityDailyCopy("肇星", "肇庆", { enterprises: 0, users: 0, todayNew: 0, weeklyDeliveries: 0 });
    expect(c.title).toContain("空城待拓");
    expect(c.body).not.toMatch(/点亮 [1-9]/);
  });
  it("无新点亮：给今日目标", () => {
    const c = cityDailyCopy("佛枢", "佛山", { enterprises: 3, users: 0, todayNew: 0, weeklyDeliveries: 5 });
    expect(c.body).toContain("新增至少 1 家");
  });
});
