/**
 * betaDlConfig 行为钉（OCR wb#77 二十八轮 test 票——断链回归=全员短信坏链，分支行为必须有钉）：
 * BASE：缺省/尾斜杠剥/相对径拒/query+fragment 拒/空白拒/合法自定义放行；
 * PATH：缺省/补前导斜杠/绝对 URL 拒/空白拒/#拒/合法自定义放行。
 * 模块级常量读 env 于加载——每例 vi.resetModules+动态 import+env 桩（betaInvites.test.ts 同律）。
 */
import { describe, expect, it, vi, afterEach } from "vitest";

const KEYS = ["BETA_DL_BASE", "BETA_DL_PERSONAL_PATH", "BETA_DL_ENTERPRISE_PATH"] as const;

async function fresh(env: Partial<Record<(typeof KEYS)[number], string>>) {
  vi.resetModules();
  for (const k of KEYS) {
    if (env[k] === undefined) delete process.env[k];
    else vi.stubEnv(k, env[k]!);
  }
  return import("./betaDlConfig");
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of KEYS) delete process.env[k];
});

describe("betaDlConfig 误配回退闸（OCR wb#77 票）", () => {
  it("全缺省 → www 域+稳定名路径", async () => {
    const m = await fresh({});
    expect(m.BETA_DL_BASE).toBe("https://downloads.example.invalid");
    expect(m.BETA_DL_PERSONAL_PATH).toBe("/dl/numx-personal-setup.exe");
    expect(m.BETA_DL_ENTERPRISE_PATH).toBe("/dl/numx-enterprise-setup.exe");
  });

  it("BASE 合法自定义+尾斜杠剥", async () => {
    const m = await fresh({ BETA_DL_BASE: "https://cdn.example.com/" });
    expect(m.BETA_DL_BASE).toBe("https://cdn.example.com");
  });

  it("BASE 相对径/带 query/带 fragment/带空白 → 回退缺省（断链短信面封死）", async () => {
    for (const bad of ["/", "https://cdn.example.com/dl?t=1", "https://cdn.example.com/x#a", "https://cdn.example.com/a b", "notaurl"]) {
      const m = await fresh({ BETA_DL_BASE: bad });
      expect(m.BETA_DL_BASE).toBe("https://downloads.example.invalid");
    }
  });

  it("PATH 缺前导斜杠补齐", async () => {
    const m = await fresh({ BETA_DL_PERSONAL_PATH: "dl/custom.exe" });
    expect(m.BETA_DL_PERSONAL_PATH).toBe("/dl/custom.exe");
  });

  it("PATH 绝对 URL/带 query/带空白/带 fragment → 回退缺省（BASE+path 拼断链面封死）", async () => {
    for (const bad of ["https://cdn.example.com/x.exe", "/dl/x.exe?t=1", "/dl/a b.exe", "/dl/x.exe#f"]) {
      const m = await fresh({ BETA_DL_PERSONAL_PATH: bad });
      expect(m.BETA_DL_PERSONAL_PATH).toBe("/dl/numx-personal-setup.exe");
    }
  });

  it("PATH 合法自定义放行", async () => {
    const m = await fresh({ BETA_DL_ENTERPRISE_PATH: "/static/ent.exe" });
    expect(m.BETA_DL_ENTERPRISE_PATH).toBe("/static/ent.exe");
  });
});
