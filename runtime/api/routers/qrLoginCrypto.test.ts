import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptQrToken, encryptQrToken } from "./qrLoginCrypto";

afterEach(() => { vi.unstubAllEnvs(); });

describe("qrLoginCrypto 管理 token 密文面", () => {
  it("AES-GCM 往返+qk1 格式；篡改密文返 null", () => {
    vi.stubEnv("QR_LOGIN_ENC_KEY", "a".repeat(64));
    const enc = encryptQrToken("nt_admin_test");
    expect(enc.startsWith("qk1")).toBe(true);
    expect(enc.split(".")).toHaveLength(3);
    expect(decryptQrToken(enc)).toBe("nt_admin_test");
    const parts = enc.split(".");
    parts[2] = parts[2].slice(0, -2) + "AA";
    expect(decryptQrToken(parts.join("."))).toBeNull();
  });

  it("缺钥/坏钥=fail-loud，不静默烧会话", () => {
    vi.stubEnv("QR_LOGIN_ENC_KEY", "");
    expect(() => encryptQrToken("nt_admin_test")).toThrow("QR_LOGIN_ENC_KEY");
    vi.stubEnv("QR_LOGIN_ENC_KEY", "bad");
    expect(() => decryptQrToken("qk1AA.AA.AA")).toThrow("QR_LOGIN_ENC_KEY");
  });
});
