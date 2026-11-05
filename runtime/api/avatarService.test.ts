/** v152 分身形象服务纯规则：预设皮肤/模板配饰/装扮映射 */
import { describe, expect, it } from "vitest";
import { AVATAR_PRESETS, DRESS_ACCESSORIES, TEMPLATE_ACCESSORIES } from "./routers/avatarService";

describe("形象预设", () => {
  it("个人玉绿/企业琥珀双基色在场", () => {
    expect(AVATAR_PRESETS.personal_jade.palette?.teal).toBe(0x34d399);
    expect(AVATAR_PRESETS.ent_amber.palette?.teal).toBe(0xfbbf24);
  });
});
describe("模板即穿（企业工坊）", () => {
  it("四职业配饰映射", () => {
    expect(TEMPLATE_ACCESSORIES.cs).toContain("headset");
    expect(TEMPLATE_ACCESSORIES.inspect).toContain("hardhat");
    expect(TEMPLATE_ACCESSORIES.finance).toContain("tie");
    expect(TEMPLATE_ACCESSORIES.sales).toContain("cap");
    expect(TEMPLATE_ACCESSORIES.custom).toEqual([]);
  });
});
describe("装扮可见化（个人装扮间）", () => {
  it("技能键映射配饰", () => {
    expect(DRESS_ACCESSORIES["skill:cs"]).toBe("headset");
    expect(DRESS_ACCESSORIES["skill:finance"]).toBe("tie");
  });
});
