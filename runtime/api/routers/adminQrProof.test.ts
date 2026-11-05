import { afterEach, describe, expect, it, vi } from "vitest";
import { adminConsoleId, adminConsoleProof, buildAdminConsoleQrText, parseAdminConsoleQrText, verifyAdminConsoleProof } from "./adminQrProof";

afterEach(() => { vi.unstubAllEnvs(); });

describe("adminQrProof 实例/会话/有效期签名", () => {
  it("build→parse→verify 真链；篡改签名/实例均 fail-closed", () => {
    vi.stubEnv("QR_LOGIN_ENC_KEY", "a".repeat(64));
    vi.stubEnv("ADMIN_CONSOLE_ID", "lingshu-prod-admin");
    const session = "ql_0123456789abcdef01234567";
    const expiresAt = Date.now() + 300_000;
    const text = buildAdminConsoleQrText(session, expiresAt);
    const parsed = parseAdminConsoleQrText(text);
    expect(parsed).not.toBeNull();
    expect(verifyAdminConsoleProof(session, parsed!.consoleId, parsed!.expiresAt, parsed!.proof)).toBe(true);
    expect(verifyAdminConsoleProof(session, parsed!.consoleId, parsed!.expiresAt, "0".repeat(32))).toBe(false);
    expect(verifyAdminConsoleProof(session, "other-admin", parsed!.expiresAt, parsed!.proof)).toBe(false);
    expect(adminConsoleProof(session, parsed!.consoleId, parsed!.expiresAt)).toBe(parsed!.proof);
  });

  it("生产缺实例 ID=fail-loud；非生产只用中性占位并留痕", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_CONSOLE_ID", "");
    expect(() => adminConsoleId()).toThrow("未配置");
    vi.stubEnv("NODE_ENV", "test");
    expect(adminConsoleId()).toBe("numx-dev-admin-unconfigured");
  });
});
