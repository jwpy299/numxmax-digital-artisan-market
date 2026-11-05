import { afterEach, describe, expect, it, vi } from "vitest";
import { hqFactoryId } from "./hq";

afterEach(() => { vi.unstubAllEnvs(); });

describe("hqFactoryId 与鉴权同源的 HQ 配置", () => {
  it("HQ_FACTORY_IDS 首项沿用；未配置时生产/开发/测试均 fail-closed", () => {
    vi.stubEnv("HQ_FACTORY_IDS", "6380240, 42");
    expect(hqFactoryId()).toBe(6380240);
    for (const env of ["production", "development", "test", "staging"]) {
      vi.stubEnv("NODE_ENV", env);
      vi.stubEnv("HQ_FACTORY_IDS", "");
      expect(() => hqFactoryId(), env).toThrow("未配置");
    }
  });

  it("旧 HQ_FACTORY_ID 不再另开优先级或旁路", () => {
    vi.stubEnv("HQ_FACTORY_ID", "42");
    vi.stubEnv("HQ_FACTORY_IDS", "6380240,43");
    expect(hqFactoryId()).toBe(6380240);
    vi.stubEnv("HQ_FACTORY_IDS", "");
    expect(() => hqFactoryId()).toThrow("未配置");
  });

  it("与鉴权同口径：非法项剔除，后续合法项仍可用；全非法则报错", () => {
    vi.stubEnv("HQ_FACTORY_IDS", "abc,6290209");
    expect(hqFactoryId()).toBe(6290209);
    vi.stubEnv("HQ_FACTORY_IDS", "1e3,0x1f,9007199254740992");
    expect(() => hqFactoryId()).toThrow();
  });
});
