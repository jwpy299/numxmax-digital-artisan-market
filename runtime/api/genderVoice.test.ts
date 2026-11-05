/** v162 注册男女模块纯规则：音色按性别换 */
import { describe, expect, it } from "vitest";
import { voicePersonaFor } from "./routers/voiceMedia";

describe("性别换声", () => {
  it("灵枢：女用户→女声（xingyun 音色组），男用户→男声", () => {
    expect(voicePersonaFor("lingshu", "female")).toBe("xingyun");
    expect(voicePersonaFor("lingshu", "male")).toBe("lingshu");
    expect(voicePersonaFor("lingshu", null)).toBe("lingshu");
    expect(voicePersonaFor("lingshu", undefined)).toBe("lingshu");
  });
  it("星云恒女（不受用户性别影响）", () => {
    expect(voicePersonaFor("xingyun", "male")).toBe("xingyun");
    expect(voicePersonaFor("xingyun", "female")).toBe("xingyun");
  });
});
