import { afterEach, describe, expect, it, vi } from "vitest";
import { isAdminDeploy } from "./deployRole";

afterEach(() => { vi.unstubAllEnvs(); });
describe("deployRole 部署角色", () => {
  it("admin 周边空白归一；其他值仍 public", () => {
    vi.stubEnv("NEBULA_DEPLOY_ROLE", " admin \n");
    expect(isAdminDeploy()).toBe(true);
    vi.stubEnv("NEBULA_DEPLOY_ROLE", "public");
    expect(isAdminDeploy()).toBe(false);
  });
});
