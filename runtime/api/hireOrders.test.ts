/** v176 雇佣工单闭环：状态机与单号（纯规则） */
import { describe, expect, it } from "vitest";
import { canTransit, orderNo, ORDER_STATUS } from "./routers/hireOrders";

describe("工单状态机", () => {
  it("主链：dispatched→running→delivered→accepted", () => {
    expect(canTransit("dispatched", "running")).toBe(true);
    expect(canTransit("running", "delivered")).toBe(true);
    expect(canTransit("delivered", "accepted")).toBe(true);
  });
  it("验收后才算数：running 不可直接 accepted", () => {
    expect(canTransit("running", "accepted")).toBe(false);
    expect(canTransit("dispatched", "accepted")).toBe(false);
  });
  it("驳回可返工回原单号，accepted/cancelled 是终态", () => {
    expect(canTransit("rejected", "dispatched")).toBe(true);
    expect(canTransit("accepted", "dispatched")).toBe(false);
    expect(canTransit("cancelled", "dispatched")).toBe(false);
  });
  it("状态枚举封闭", () => {
    expect(ORDER_STATUS).toHaveLength(6);
  });
});

describe("工单号（一单到底）", () => {
  it("HO-<hireId>-<seq> 补位", () => {
    expect(orderNo(42, 1)).toBe("HO-42-001");
    expect(orderNo(42, 12)).toBe("HO-42-012");
  });
});
