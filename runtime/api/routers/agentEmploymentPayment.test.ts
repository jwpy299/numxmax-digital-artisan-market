import { describe, expect, it } from "vitest";
import { signSandboxCallback, verifySandboxCallback } from "./agentEmployment";

describe("支付沙箱回调签名", () => {
  const unsigned = {
    eventId: "evt_test_001",
    orderNo: "AO_test_001",
    status: "paid" as const,
    amountCents: 9900,
    amountJobTokens: 990,
    attemptNo: 1,
    environment: "sandbox" as const,
  };
  it("同一规范载荷可验签，篡改人民币金额/token/订单/环境即失败", () => {
    const secret = "test-only-sandbox-secret-not-production";
    const signature = signSandboxCallback(unsigned, secret);
    expect(verifySandboxCallback({ ...unsigned, signature }, secret)).toBe(true);
    expect(verifySandboxCallback({ ...unsigned, amountCents: 100, signature }, secret)).toBe(false);
    expect(verifySandboxCallback({ ...unsigned, amountJobTokens: 10, signature }, secret)).toBe(false);
    expect(verifySandboxCallback({ ...unsigned, orderNo: "AO_other", signature }, secret)).toBe(false);
    expect(verifySandboxCallback({ ...unsigned, signature: "00".repeat(32) }, secret)).toBe(false);
    expect(verifySandboxCallback({ ...unsigned, signature: "not-hex" }, secret)).toBe(false);
  });
});
