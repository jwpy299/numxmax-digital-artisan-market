// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  clearWbSession,
  saveWbSession,
  useWbQuery,
  useWbSession,
  type WbSession,
} from "./wbSession";
import { NEBULA_AUTH_STORAGE_KEY } from "@/config/workbench";

const fetchMock = vi.fn();
const session: WbSession = { token: "test-session-token" };
function response(value: unknown): Response {
  return new Response(JSON.stringify({ result: { data: { json: value } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("wbSession 查询与广播边界", () => {
  it("公共查询输入变化时立即清掉上一主体旧数据", async () => {
    let resolveSecond: ((value: Response) => void) | undefined;
    fetchMock
      .mockImplementationOnce(async () => response({ agent: "one" }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const { result, rerender } = renderHook(
      ({ agentId }) =>
        useWbQuery<{ agent: string }>(
          "public.agent",
          null,
          { agentId },
          { withToken: false },
        ),
      { initialProps: { agentId: 1 } },
    );
    await waitFor(() => expect(result.current.data?.agent).toBe("one"));
    rerender({ agentId: 2 });
    await waitFor(() => expect(result.current.data).toBeNull());
    expect(result.current.loading).toBe(true);
    resolveSecond?.(response({ agent: "two" }));
    await waitFor(() => expect(result.current.data?.agent).toBe("two"));
  });

  it("登出时清数据并停止在飞 loading", async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    const { result, rerender } = renderHook(
      ({ current }) =>
        useWbQuery("private.mine", current, {}, { withToken: true }),
      { initialProps: { current: session as WbSession | null } },
    );
    await waitFor(() => expect(result.current.loading).toBe(true));
    rerender({ current: null });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
  });

  it("revision 写入异常不阻断 token 保存，仍广播会话变化", () => {
    const listener = vi.fn();
    window.addEventListener("wb-session-changed", listener);
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(
      function (key, value) {
        if (key === "nebula_auth_revision") throw new Error("quota");
        return original.call(this, key, value);
      },
    );
    expect(saveWbSession(session)).toEqual({ ok: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(NEBULA_AUTH_STORAGE_KEY)).toContain(
      "test-session-token",
    );
    window.removeEventListener("wb-session-changed", listener);
  });
  it("订阅者异常不会误删已保存会话或把保存判为失败", () => {
    vi.spyOn(window, "dispatchEvent").mockImplementation(() => {
      throw new Error("subscriber");
    });
    expect(saveWbSession(session)).toEqual({ ok: true });
    expect(localStorage.getItem(NEBULA_AUTH_STORAGE_KEY)).toContain("test-session-token");
  });

  it("replaceData 后旧请求不得覆盖新快照", async () => {
    let resolveOld: ((value: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveOld = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useWbQuery<{ agent: string }>(
        "public.agent",
        null,
        { agentId: 1 },
        { withToken: false },
      ),
    );
    await waitFor(() => expect(result.current.loading).toBe(true));
    result.current.replaceData({ agent: "fresh" });
    resolveOld?.(response({ agent: "stale" }));
    await waitFor(() => expect(result.current.data?.agent).toBe("fresh"));
  });

  it("登出移除 token 并旋转 revision", () => {
    saveWbSession(session);
    const before = localStorage.getItem("nebula_auth_revision");
    clearWbSession();
    expect(localStorage.getItem(NEBULA_AUTH_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem("nebula_auth_revision")).not.toBe(before);
  });

  it("removeItem 失败仍强制内存退出，不恢复旧身份", () => {
    localStorage.setItem(NEBULA_AUTH_STORAGE_KEY, JSON.stringify(session));
    const { result } = renderHook(() => useWbSession());
    expect(result.current.session?.token).toBe("test-session-token");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("remove blocked");
    });
    let cleared = false;
    act(() => { cleared = result.current.clear(); });
    expect(cleared).toBe(false);
    expect(result.current.session).toBeNull();
  });

  it("token 本体写入失败返回可操作错误并清除失效会话", () => {
    const listener = vi.fn();
    window.addEventListener("wb-session-changed", listener);
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(
      function (key, value) {
        if (key === "nebula_auth") throw new Error("quota");
        return original.call(this, key, value);
      },
    );
    expect(saveWbSession(session)).toMatchObject({
      ok: false,
      error: expect.stringContaining("存储/隐私设置"),
    });
    expect(localStorage.getItem(NEBULA_AUTH_STORAGE_KEY)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("wb-session-changed", listener);
  });
});
