import { describe, it, expect } from "vitest";
import { detectIntent, mapDeviceAction } from "./routers/spiritIntent";

describe("精灵意图识别", () => {
  it("设备控制：动词+设备", () => {
    const i = detectIntent("帮我打开空调");
    expect(i.kind).toBe("device");
    expect(i.target).toBe("空调");
    expect(mapDeviceAction(i.action!)).toBe("power_on");
  });
  it("打印文件", () => {
    const i = detectIntent("帮我打印文件");
    expect(i.kind).toBe("device");
    expect(mapDeviceAction(i.action!)).toBe("print");
  });
  it("APP 功能：查待办/看纪要", () => {
    expect(detectIntent("我今天待办有哪些").action).toBe("open_todos");
    expect(detectIntent("昨晚会议纪要呢").action).toBe("open_meetings");
  });
  it("闲聊不动作", () => {
    expect(detectIntent("今天天气不错").kind).toBe("chat");
  });
  it("关电视", () => {
    const i = detectIntent("关掉电视");
    expect(i.kind).toBe("device");
    expect(mapDeviceAction(i.action!)).toBe("power_off");
  });
});
