/**
 * 角色挂载钉（彭总 2026-10-20 令——公网挂载面收口面守门）：
 *  public 角色=内管面不挂（gate./admin./opsCenter. 前缀零命中）；admin 角色=全挂。
 *  行为钉纪律：真导模块按角色断——非字符串钉。
 *  判据面：tRPC 嵌套 router 在 _def.procedures 里是扁平点前缀键（gate.authChains），不是 'gate' 键[首轮钉写法错面修]。
 */
import { describe, expect, it, vi } from "vitest";

const hasNs = (r: unknown, ns: string) =>
  Object.keys((r as { _def: { procedures: Record<string, unknown> } })._def.procedures).some((k) => k.startsWith(ns + "."));

describe("角色挂载钉（公网不收内管面）", () => {
  it("缺省/非 admin 角色：内管面不挂+公开面照挂", async () => {
    vi.resetModules();
    vi.stubEnv("NEBULA_DEPLOY_ROLE", "public");
    const { appRouter } = await import("./router");
    expect(hasNs(appRouter, "gate")).toBe(false); // 内管面摘
    expect(hasNs(appRouter, "admin")).toBe(false); // 注意 adminAuth/adminAi 同族同摘（admin. 前缀面）
    expect(hasNs(appRouter, "opsCenter")).toBe(false);
    for (const ns of ["adminDaily", "adminRelease", "adminQr", "adminTraining", "agentTrainingReview"]) expect(hasNs(appRouter, ns)).toBe(false);
    expect(hasNs(appRouter, "agents")).toBe(true); // 公开面在
    expect(hasNs(appRouter, "betaApply")).toBe(true);
    vi.unstubAllEnvs();
  }, 60_000); // 全树导入重——超时放宽（真导模块面）

  it("admin 角色：内管面全挂", async () => {
    vi.resetModules();
    vi.stubEnv("NEBULA_DEPLOY_ROLE", "admin");
    const { appRouter } = await import("./router");
    expect(hasNs(appRouter, "gate")).toBe(true);
    expect(hasNs(appRouter, "admin")).toBe(true);
    for (const ns of ["adminDaily", "adminRelease", "adminQr", "adminTraining", "agentTrainingReview"]) expect(hasNs(appRouter, ns)).toBe(true);
    expect(hasNs(appRouter, "agents")).toBe(true);
    vi.unstubAllEnvs();
  }, 60_000);
});
