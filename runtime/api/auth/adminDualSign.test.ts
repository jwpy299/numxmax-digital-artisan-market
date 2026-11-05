import { afterEach, describe, expect, it, vi } from "vitest";
import { requireDualSign } from "./adminDualSign";

type TestUser = { id: number; username: string; delegated?: boolean; adminOrigin?: "native" };
async function fresh(users: Record<string, TestUser>) {
  vi.resetModules();
  vi.doMock("./cabinGate", () => ({
    requireCabinAction: vi.fn(async (token: string) => ({
      ...users[token],
      displayName: users[token].username,
      cabin: "all",
      cabinRole: "admin",
    })),
  }));
  return import("./adminDualSign");
}

afterEach(() => { vi.restoreAllMocks(); });

describe("adminDualSign 身份域", () => {
  it("不同 id 但同名同账号也判同席，不允许自审", async () => {
    const { requireDualSign } = await fresh({ a: { id: 1, username: "peng" }, b: { id: 2, username: "peng" } });
    await expect(requireDualSign("a", "b", "invite")).rejects.toThrow("同一人");
  });

  it("大小写/空白变体同名也判同席，不允许绕双签", async () => {
    const { requireDualSign } = await fresh({ a: { id: 1, username: " Peng " }, b: { id: 2, username: "peng" } });
    await expect(requireDualSign("a", "b", "invite")).rejects.toThrow("同一人");
  });

  it("无效席位 id 先报身份无效，不冒充同人", async () => {
    const { requireDualSign } = await fresh({ a: { id: 0, username: "peng" }, b: { id: 2, username: "qiu" } });
    await expect(requireDualSign("a", "b", "invite")).rejects.toThrow("席位身份无效");
  });

  it("不同 id 且不同名才可双签", async () => {
    const { requireDualSign } = await fresh({ a: { id: 1, username: "peng" }, b: { id: 2, username: "qiu" } });
    const r = await requireDualSign("a", "b", "invite");
    expect(r.operatorId).toBe(1);
    expect(r.reviewerId).toBe(2);
  });

  it("跨命名空间同数字 id 的不同人不误拒，审计 id 分带", async () => {
    const { requireDualSign } = await fresh({ a: { id: 1, username: "wb_user" }, b: { id: 1, username: "delegate_user", delegated: true } });
    const r = await requireDualSign("a", "b", "invite");
    expect(r.operatorId).toBe(1);
    expect(r.reviewerId).toBe(1_000_000_000_001);
  });

  it("原生席审计 id 走独立 2e12 带，不与 wb 用户撞号", async () => {
    const { requireDualSign } = await fresh({ a: { id: 5, username: "native_admin", delegated: true, adminOrigin: "native" }, b: { id: 8, username: "wb_user" } });
    const r = await requireDualSign("a", "b", "invite");
    expect(r.operatorId).toBe(2_000_000_000_005);
    expect(r.reviewerId).toBe(8);
  });
});
