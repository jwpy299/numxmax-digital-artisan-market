import { afterEach, describe, expect, it, vi } from "vitest";

async function appWithRole(role: string) {
  vi.resetModules();
  vi.stubEnv("NEBULA_DEPLOY_ROLE", role);
  return (await import("../boot")).default;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("admin-qr 部署角色路由闸", () => {
  it("public 角色必须 404；admin 角色路由存在", async () => {
    const publicApp = await appWithRole("public");
    const missing = await publicApp.fetch(new Request("http://localhost/api/admin-qr?text=bad"));
    expect(missing.status).toBe(404);
    const adminApp = await appWithRole("admin");
    const present = await adminApp.fetch(new Request("http://localhost/api/admin-qr?text=bad"));
    expect(present.status).not.toBe(404);
    expect(present.status).toBe(400);
  }, 60_000);
});
