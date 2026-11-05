// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveStaffSession, STAFF_AUTH_STORAGE_KEY } from "./staffSession";

const session = {
  token: "staff-token",
  displayName: "Staff",
  deptKey: "dept-a",
  deptName: "部门A",
  role: "staff" as const,
};
beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("staffSession 保存边界", () => {
  it("token 写入失败返回明确错误并清理失效会话", () => {
    const listener = vi.fn();
    window.addEventListener("staff-session-changed", listener);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(saveStaffSession(session)).toMatchObject({
      ok: false,
      error: expect.stringContaining("存储/隐私设置"),
    });
    expect(localStorage.getItem(STAFF_AUTH_STORAGE_KEY)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("staff-session-changed", listener);
  });

  it("订阅者异常不会删除已经保存的会话", () => {
    vi.spyOn(window, "dispatchEvent").mockImplementation(() => {
      throw new Error("subscriber");
    });
    expect(() => saveStaffSession(session)).toThrow("subscriber");
    expect(localStorage.getItem(STAFF_AUTH_STORAGE_KEY)).toContain(
      "staff-token",
    );
  });
});
