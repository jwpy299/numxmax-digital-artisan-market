import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("betaApply 活码窗与签发锁契约", () => {
  it("预检与锁内重评同带 revoked_at，颁码事务统一走手机号命名锁", () => {
    const source = readFileSync(new URL("./sms.ts", import.meta.url), "utf8");
    expect(source).toContain("consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()");
    expect(source.match(/WHERE \$\{betaLiveWindowCond\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain("withBetaInvitePhoneLock(input.phone, async (tx)");
    expect(source).toContain("const todayLocked");
    expect(source.match(/WHERE \$\{betaDailyCond\(input\.phone\)\}/g)?.length).toBe(2);
    expect(source).toContain("const betaDailyCond = (phone: string)");
    expect(source).toContain("SET revoked_at = NOW()");
  });

  it("审批签发也走同一手机号锁，不留第三条旁路", () => {
    const source = readFileSync(new URL("./betaApply.ts", import.meta.url), "utf8");
    expect(source).toContain("withBetaInvitePhoneLock(rows[0].phone, async (tx)");
  });
});
