/** v174 音色注册表（拍板阵容） */
import { describe, expect, it } from "vitest";
import { VOICE_REGISTRY, resolveVoice } from "./routers/voiceMedia";

describe("音色注册表", () => {
  it("七格全齐：粤普双轨", () => {
    expect(Object.keys(VOICE_REGISTRY).sort()).toEqual([
      "lingshu", "lingshu_ba", "lingshu_dj", "lingshu_yue", "xingyun", "xingyun_warm", "xingyun_yue",
    ]);
  });
  it("每格有官方音色 ID 与回落人格", () => {
    for (const v of Object.values(VOICE_REGISTRY)) {
      expect(v.mmx.length).toBeGreaterThan(4);
      expect(["lingshu", "xingyun"]).toContain(v.gwFallback);
    }
  });
  it("非法人格回落灵枢", () => {
    expect(resolveVoice("不存在的").key).toBe("lingshu");
    expect(resolveVoice("lingshu_yue").def.label).toContain("广仔");
  });
});
