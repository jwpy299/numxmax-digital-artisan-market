/**
 * `BRIDGE_TOKEN_TIER` 档位谓词三态直测（门禁 portal#48 R3 的 :34，test·low）。
 *
 * 为什么必须这样测：档位与令牌取值都是**模块级常量**（import 时求值），普通单测只能看到进程启动时的
 * 那一档 ⇒ 要覆盖 rw / 空串 / 缺省三态，只能 `vi.resetModules()` + 动态 `import()`。
 * 这条谓词是**安全相关分支**（决定 POST 用写令牌还是回落到只读令牌），而且已经因"两套语义打架"
 * 回归过一次（R2），所以它值得一个专门的钉子。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

/** 用指定环境变量值重新加载模块，读回档位。`undefined` = 该变量不存在。 */
async function tierWith(value: string | undefined): Promise<string> {
  vi.resetModules();
  if (value === undefined) vi.stubEnv("BRIDGE_TOKEN", undefined as unknown as string);
  else vi.stubEnv("BRIDGE_TOKEN", value);
  const mod = await import("./teamProgress");
  return mod.__bridgeTierForTest();
}

describe("BRIDGE_TOKEN_TIER 档位谓词（安全相关分支，三态）", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("配置了非空写令牌 ⇒ rw", async () => {
    expect(await tierWith("RW-TOKEN")).toBe("rw");
  });

  it("未配置 ⇒ ro-fallback", async () => {
    expect(await tierWith(undefined)).toBe("ro-fallback");
  });

  it("配置了但为空串 ⇒ ro-fallback（空令牌没有任何用途，按未配置处理）", async () => {
    // 这一格正是 R2 的回归点：当时令牌用 `??`（空串会**原样**当令牌）而档位用真值判断（空串算未配），
    // 两者在 `BRIDGE_TOKEN=""` 时互相打架 —— 档位自称回落、实际却拿空串去写（必然 401）。
    expect(await tierWith("")).toBe("ro-fallback");
  });
});
