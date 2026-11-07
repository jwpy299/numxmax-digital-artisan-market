// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { clearStaffSession, saveStaffSession, STAFF_AUTH_STORAGE_KEY, useStaffSession } from "./staffSession";

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
    expect(saveStaffSession(session)).toEqual({ ok: true });
    expect(localStorage.getItem(STAFF_AUTH_STORAGE_KEY)).toContain(
      "staff-token",
    );
  });

  it("订阅者异常不会把保存或清除变成未处理异常", () => {
    vi.spyOn(window, "dispatchEvent").mockImplementation(() => {
      throw new Error("subscriber");
    });
    expect(saveStaffSession(session)).toEqual({ ok: true });
    expect(clearStaffSession()).toBe(true);
  })

  it("removeItem 失败仍广播失效且 hook 不恢复旧身份", () => {
    localStorage.setItem(STAFF_AUTH_STORAGE_KEY, JSON.stringify(session));
    const listener = vi.fn();
    window.addEventListener("staff-session-changed", listener);
    const { result } = renderHook(() => useStaffSession());
    expect(result.current.session?.token).toBe("staff-token");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("remove blocked");
    });
    let cleared = false;
    act(() => { cleared = clearStaffSession(); });
    expect(cleared).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    act(() => { result.current.clear(); });
    expect(result.current.session).toBeNull();
    window.removeEventListener("staff-session-changed", listener);
  });
});
