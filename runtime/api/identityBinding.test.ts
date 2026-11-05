/** v148 身份绑定状态机纯规则（B4 负例核心）：确权与解权的边界 */
import { describe, expect, it } from "vitest";
import { canConfirm, canRevoke } from "./routers/identityBinding";

describe("identityBinding 状态机", () => {
  it("confirm：仅 pending 且本人", () => {
    expect(canConfirm("pending", true)).toBe(true);
    expect(canConfirm("pending", false)).toBe(false); // 企业代确认永不
    expect(canConfirm("active", true)).toBe(false);
    expect(canConfirm("revoked", true)).toBe(false);
  });
  it("revoke：本人或本厂 admin；跨厂/普通成员永不", () => {
    expect(canRevoke("active", true, false)).toBe(true);   // 本人退
    expect(canRevoke("active", false, true)).toBe(true);  // 本厂负责人移除
    expect(canRevoke("pending", false, true)).toBe(true); // 负责人撤邀请
    expect(canRevoke("active", false, false)).toBe(false);
    expect(canRevoke("revoked", true, true)).toBe(false); // 已脱钩不可再操作
  });
});
