import type { ReactNode } from "react";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { DeliveryDetail } from "./DeliveryDetail";

vi.mock("react-router", () => ({
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string;
    children: ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
import { stableSerialize } from "@/lib/stableSerialize";

const callWb = vi.hoisted(() => vi.fn());
const clearWbSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/wbSession", () => ({
  callWb,
  clearWbSession,
  isWbAuthError: () => true,
  wbErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  useWbSessionRevision: () => revision.value,
}));

const revision = vi.hoisted(() => ({ value: "r1" }));
const session = { token: "test-token", role: "admin" };

describe("DeliveryDetail", () => {
  afterEach(cleanup);
  beforeEach(() => {
    callWb.mockReset();
    clearWbSession.mockReset();
  });

  it("鉴权失败清理会话并展示错误", async () => {
    callWb.mockRejectedValue(new Error("token 无效或已过期"));
    render(
      <DeliveryDetail
        path="agentWork.delivery"
        input={{ claimId: 1 }}
        resultKey="claim"
        session={session}
        label="查看交付"
        cacheKey="a"
      />,
    );
    fireEvent.click(screen.getByText("查看交付"));
    expect(await screen.findByText("token 无效或已过期")).toBeTruthy();
    expect(clearWbSession).toHaveBeenCalledTimes(1);
  });

  it("会话缺失时进入明确鉴权终态，不永久 loading 也不发请求", async () => {
    render(
      <DeliveryDetail
        path="agentWork.delivery"
        input={{ claimId: 1 }}
        resultKey="claim"
        session={null}
        label="查看交付"
        cacheKey="a"
      />,
    );
    fireEvent.click(screen.getByText("查看交付"));
    expect(await screen.findByText(/登录会话已失效/)).toBeTruthy();
    expect(screen.queryByText(/正在按权限读取交付原文/)).toBeNull();
    expect(callWb).not.toHaveBeenCalled();
  });

  it("同哈希复用缓存，哈希变化重新请求", async () => {
    callWb.mockImplementation(async (_kind, _path, _session, input) => ({
      claim: { deliverable: `交付-${input.claimId}`, evidenceSha256: "a" },
    }));
    const { rerender } = render(
      <DeliveryDetail
        path="agentWork.delivery"
        input={{ claimId: 1 }}
        resultKey="claim"
        session={session}
        label="查看交付"
        cacheKey="a"
      />,
    );
    fireEvent.click(screen.getByText("查看交付"));
    expect(await screen.findByText("交付-1")).toBeTruthy();
    fireEvent.click(screen.getByText("查看交付"));
    fireEvent.click(screen.getByText("查看交付"));
    expect(callWb).toHaveBeenCalledTimes(1);
    rerender(
      <DeliveryDetail
        path="agentWork.delivery"
        input={{ claimId: 1 }}
        resultKey="claim"
        session={session}
        label="查看交付"
        cacheKey="b"
      />,
    );
    expect(callWb).toHaveBeenCalledTimes(2);
  });

  it("空交付显示明确空态而非空白或残缺哈希", async () => {
    callWb.mockResolvedValue({
      claim: { deliverable: null, evidenceSha256: null },
    });
    render(
      <DeliveryDetail
        path="agentWork.delivery"
        input={{ claimId: 1 }}
        resultKey="claim"
        session={session}
        label="查看交付"
        cacheKey="a"
      />,
    );
    fireEvent.click(screen.getByText("查看交付"));
    expect(await screen.findByText(/当前没有可查看的交付原文/)).toBeTruthy();
    expect(screen.queryByText(/SHA-256/)).toBeNull();
  });

  it("稳定序列化区分 undefined，并对循环引用显式留标而不崩溃", () => {
    const circular: { name: string; self?: unknown } = { name: "循环输入" };
    circular.self = circular;
    expect(stableSerialize([undefined])).not.toBe(stableSerialize([]));
    expect(stableSerialize({ value: undefined })).not.toBe(stableSerialize({}));
    expect(() => stableSerialize(circular)).toThrow(
      "stable_serialize_circular_unsupported",
    );
    expect(stableSerialize(BigInt(7))).toBe("bigint:7");
    expect(stableSerialize(new Map([["a", 1]]))).not.toBe(
      stableSerialize(new Map([["a", 2]])),
    );
    expect(stableSerialize(new Set([1, 2]))).toBe(
      stableSerialize(new Set([2, 1])),
    );
    expect(stableSerialize(new Uint8Array([1, 2]))).not.toBe(
      stableSerialize(new Uint8Array([1, 3])),
    );
    expect(stableSerialize(new Number(1))).not.toBe(
      stableSerialize(new Number(2)),
    );
    expect(stableSerialize(/a/)).not.toBe(stableSerialize(/b/));
    expect(stableSerialize(new URL("https://a.test/x"))).not.toBe(
      stableSerialize(new URL("https://b.test/y")),
    );
    expect(() =>
      stableSerialize(
        new (class PrivateState {
          value = 1;
        })(),
      ),
    ).toThrow("stable_serialize_class_unsupported");
    expect(() => stableSerialize(() => undefined)).toThrow(
      "stable_serialize_function_unsupported",
    );
    expect(() => stableSerialize(Symbol("a"))).toThrow(
      "stable_serialize_symbol_unsupported",
    );
    expect(() => stableSerialize({ [Symbol("a")]: 1 })).toThrow(
      "stable_serialize_symbol_key_unsupported",
    );
    expect(stableSerialize(-0)).not.toBe(stableSerialize(0));
    expect(stableSerialize(new Array(1))).not.toBe(stableSerialize([]));
    const getter = vi.fn(() => {
      throw new Error("getter-must-not-run");
    });
    const withGetter = Object.defineProperty({}, "secret", {
      get: getter,
      enumerable: true,
    });
    expect(() => stableSerialize(withGetter)).toThrow(
      "stable_serialize_accessor_unsupported",
    );
    const arrayWithGetter = Object.defineProperty(new Array(1), "0", {
      get: getter,
      enumerable: true,
    });
    expect(() => stableSerialize(arrayWithGetter)).toThrow(
      "stable_serialize_accessor_unsupported",
    );
    expect(getter).not.toHaveBeenCalled();
    const inheritedIndex = Object.setPrototypeOf(new Array(1), {
      0: "inherited",
    });
    expect(() => stableSerialize(inheritedIndex)).toThrow(
      "stable_serialize_class_unsupported",
    );
  });

  it("会话变化即重新鉴权读取，不能复用上一会话证据", async () => {
    callWb.mockImplementation(async (_kind, _path, currentSession) => ({
      claim: {
        deliverable: `交付-${currentSession.token}`,
        evidenceSha256: "a",
      },
    }));
    const { rerender } = render(
      <DeliveryDetail
        path="agentWork.delivery"
        input={{ claimId: 1 }}
        resultKey="claim"
        session={session}
        label="查看交付"
        cacheKey="a"
      />,
    );
    fireEvent.click(screen.getByText("查看交付"));
    expect(await screen.findByText("交付-test-token")).toBeTruthy();
    revision.value = "r2";
    rerender(
      <DeliveryDetail
        path="agentWork.delivery"
        input={{ claimId: 1 }}
        resultKey="claim"
        session={{ ...session, token: "other-token" }}
        label="查看交付"
        cacheKey="a"
      />,
    );
    expect(await screen.findByText("交付-other-token")).toBeTruthy();
    expect(screen.queryByText("交付-test-token")).toBeNull();
    expect(callWb).toHaveBeenCalledTimes(2);
  });

  it("空字符串是有效交付，不误报为没有交付", async () => {
    callWb.mockResolvedValue({
      claim: { deliverable: "", evidenceSha256: "a" },
    });
    render(
      <DeliveryDetail
        path="agentWork.delivery"
        input={{ claimId: 1 }}
        resultKey="claim"
        session={session}
        label="查看交付"
        cacheKey="a"
      />,
    );
    fireEvent.click(screen.getByText("查看交付"));
    await screen.findByText(/SHA-256/);
    expect(screen.queryByText(/当前没有可查看的交付原文/)).toBeNull();
    expect(document.querySelector("pre")?.textContent).toBe("");
  });

  it("折叠时中止在飞请求，重新展开不复用旧请求", async () => {
    callWb.mockImplementation(() => new Promise(() => undefined));
    render(
      <DeliveryDetail
        path="agentWork.delivery"
        input={{ claimId: 1 }}
        resultKey="claim"
        session={session}
        label="查看交付"
        cacheKey="a"
      />,
    );
    fireEvent.click(screen.getByText("查看交付"));
    await waitFor(() => expect(callWb).toHaveBeenCalledTimes(1));
    const options = callWb.mock.calls[0][4];
    const details = document.querySelector("details")!;
    details.open = false;
    fireEvent(details, new Event("toggle"));
    expect(options.signal.aborted).toBe(true);
  });

  it("就绪状态也可强制重新读取，不依赖可选 cacheKey", async () => {
    callWb.mockResolvedValue({
      claim: { deliverable: "重读交付", evidenceSha256: "a" },
    });
    render(
      <DeliveryDetail
        path="agentWork.delivery"
        input={{ claimId: 1 }}
        resultKey="claim"
        session={session}
        label="查看交付"
      />,
    );
    fireEvent.click(screen.getByText("查看交付"));
    expect(await screen.findByText("重读交付")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await waitFor(() => expect(callWb).toHaveBeenCalledTimes(2));
  });

  it("读取失败后可显式重试，不需要更换证据哈希", async () => {
    callWb
      .mockRejectedValueOnce(new Error("网络超时"))
      .mockResolvedValueOnce({
        claim: { deliverable: "重试后的交付", evidenceSha256: "a" },
      });
    render(
      <DeliveryDetail
        path="agentWork.delivery"
        input={{ claimId: 1 }}
        resultKey="claim"
        session={session}
        label="查看交付"
        cacheKey="a"
      />,
    );
    fireEvent.click(screen.getByText("查看交付"));
    expect(await screen.findByText("网络超时")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试读取" }));
    expect(await screen.findByText("重试后的交付")).toBeTruthy();
    expect(callWb).toHaveBeenCalledTimes(2);
  });

  it("序列化失败时明确阻断并提示，不发请求也不留空白", async () => {
    const input = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error("revoked-proxy");
        },
      },
    );
    render(
      <DeliveryDetail
        path="agentWork.delivery"
        input={input}
        resultKey="claim"
        session={session}
        label="查看交付"
        cacheKey="a"
      />,
    );
    fireEvent.click(screen.getByText("查看交付"));
    expect(await screen.findByText(/无法安全序列化/)).toBeTruthy();
    expect(callWb).not.toHaveBeenCalled();
  });
});
