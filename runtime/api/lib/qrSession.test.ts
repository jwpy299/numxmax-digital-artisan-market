import { describe, expect, it } from "vitest";
import { QR_SESSION_RE, newQrSession } from "./qrSession";

describe("qrSession 会话号单源", () => {
  it("newQrSession：ql_ + 24 hex，与扫码四端格式闸一致", () => {
    const session = newQrSession();
    expect(session).toMatch(QR_SESSION_RE);
    expect(session).toHaveLength(27);
  });
});
