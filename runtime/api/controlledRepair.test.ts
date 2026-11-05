/** v177 L3 受控自修闸（纯判定） */
import { describe, expect, it } from "vitest";
import { gateOf } from "./harness/controlledRepair";

describe("受控自修闸", () => {
  it("双证齐全才放行", () => {
    expect(gateOf(true, true, true).pass).toBe(true);
  });
  it("缺一即拒（fail-closed）", () => {
    expect(gateOf(false, true, true).missing).toContain("双签票据未消费");
    expect(gateOf(true, false, true).missing).toContain("沙箱全绿证明缺失");
    expect(gateOf(true, true, false).missing).toContain("补丁草案未过校验");
    expect(gateOf(false, false, false).pass).toBe(false);
  });
});
