/**
 * NumX Max 智能工作台 —— 前端会话与调用助手（/wb/* SPA 共用）。
 *
 * 依据《NumX Max 智能工作台 API 文档》硬性约束：
 * - 会话对象（含 token）保存于 localStorage("nebula_auth")，沿用官方约定；
 * - 所有需要登录态的调用，token 一律放在请求体字段（无 Authorization header）；
 * - token 单点有效：重新登录 / SSO 消费 ticket 后旧 token 立即失效，
 *   因此每次拿到新会话必须覆盖保存；
 * - ticket（st_）/ publishKey（pk_）明文绝不写入本模块（一次性明文，仅调用方即时使用）。
 * - 存量债务：Developers.tsx trpcDev GET-token 待收口。
 *
 * 工作台四组路由（agentic / nebulaLink / workbenchMarket / showroomPortal）与主站
 * 同部署于 /api/trpc，但主 AppRouter 类型尚未合并挂载这四组路由（由主代理接线），
 * 因此这里使用 untyped tRPC client 按字符串路径调用，避免对 AppRouter 类型的依赖。
 */
import {
  createTRPCUntypedClient,
  httpBatchLink,
  TRPCClientError,
} from "@trpc/client";
import superjson from "superjson";
import { useCallback, useEffect, useRef, useState } from "react";
import { NEBULA_AUTH_STORAGE_KEY } from "@/config/workbench";

// ─── 会话模型 ────────────────────────────────────────────────────────────────

/** 工作台会话（localStorage("nebula_auth")），字段与 SessionInfo 对齐 */
export interface WbSession {
  token: string;
  username?: string;
  displayName?: string;
  enterpriseName?: string;
  factoryId?: number;
  role?: string; // admin / owner / member
  [key: string]: unknown;
}

/** 同标签页会话变更事件（storage 事件只跨标签页触发，本页保存后需手动广播） */
const WB_SESSION_EVENT = "wb-session-changed";
const WB_SESSION_REVISION_KEY = "nebula_auth_revision";

export function loadWbSession(): WbSession | null {
  try {
    const raw = localStorage.getItem(NEBULA_AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WbSession;
    return typeof parsed?.token === "string" && parsed.token ? parsed : null;
  } catch {
    return null;
  }
}

/** 保存会话（覆盖式；token 单点有效，必须以最新为准） */
function nextRevision(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}
let volatileRevision: string | null = null;
function rotateRevision(): void {
  volatileRevision = nextRevision();
  try {
    localStorage.setItem(WB_SESSION_REVISION_KEY, volatileRevision);
  } catch {
    /* revision 只作失效提示，不作为 token 保存成败条件 */
  }
}
function loadRevision(): string {
  if (volatileRevision) return volatileRevision;
  try {
    return localStorage.getItem(WB_SESSION_REVISION_KEY) ?? "legacy";
  } catch {
    return "legacy";
  }
}

export type WbSessionSaveResult = { ok: true } | { ok: false; error: string };

function clearSessionStorage(): boolean {
  try {
    localStorage.removeItem(NEBULA_AUTH_STORAGE_KEY);
  } catch {
    return false;
  }
  // revision 旋转失败也不改变“token 已移除”的事实；返回只描述 auth 是否清除。
  rotateRevision();
  return true;
}

export function saveWbSession(session: WbSession): WbSessionSaveResult {
  let serialized: string;
  try {
    serialized = JSON.stringify(session);
  } catch (error) {
    console.warn(
      "[wb-session] session serialization failed:",
      error instanceof Error ? error.name : "unknown",
    );
    return { ok: false, error: "会话数据格式无效，未修改原会话，请重新登录。" };
  }
  try {
    localStorage.setItem(NEBULA_AUTH_STORAGE_KEY, serialized);
    rotateRevision();
    window.dispatchEvent(new Event(WB_SESSION_EVENT));
    return { ok: true };
  } catch (error) {
    console.warn(
      "[wb-session] storage write failed:",
      error instanceof Error ? error.name : "unknown",
    );
    const cleared = clearSessionStorage();
    window.dispatchEvent(new Event(WB_SESSION_EVENT));
    return {
      ok: false,
      error: cleared
        ? "新会话保存失败，已清除可能失效的会话。请检查浏览器存储/隐私设置后重新登录；不要重复注册。"
        : "新会话保存失败，请检查浏览器存储/隐私设置后返回登录页；不要重复注册。",
    };
  }
}

export function useWbSessionRevision(): string {
  const [revision, setRevision] = useState(loadRevision);
  useEffect(() => {
    const sync = (event: Event) => {
      if (event.type === "storage") volatileRevision = null;
      setRevision(loadRevision());
    };
    window.addEventListener("storage", sync);
    window.addEventListener(WB_SESSION_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(WB_SESSION_EVENT, sync);
    };
  }, []);
  return revision;
}

export function clearWbSession(): void {
  clearSessionStorage();
  window.dispatchEvent(new Event(WB_SESSION_EVENT));
}

/** 读取并监听会话变化（本页 + 跨标签页） */
export function useWbSession() {
  const [session, setSession] = useState<WbSession | null>(() =>
    loadWbSession(),
  );

  useEffect(() => {
    const sync = () => setSession(loadWbSession());
    window.addEventListener("storage", sync);
    window.addEventListener(WB_SESSION_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(WB_SESSION_EVENT, sync);
    };
  }, []);

  const save = useCallback((s: WbSession) => saveWbSession(s), []);
  const clear = useCallback(() => clearWbSession(), []);
  return { session, save, clear };
}

// ─── tRPC 调用（untyped client，/api/trpc，superjson）───────────────────────

const wbClient = createTRPCUntypedClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      // token 只走 body 红线：query 一律 POST（默认 GET 会把含 token 的 input 拼进 URL，
      // 落 nginx/CDN 访问日志）。当前 @trpc/client 11.x 该选项名为 methodOverride
      // （语义即「所有请求无论 query/mutation 一律 POST」）。
      methodOverride: "POST",
      transformer: superjson,
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

export function wbQuery<T>(
  path: string,
  input?: unknown,
  options?: { signal?: AbortSignal },
): Promise<T> {
  return wbClient.query(path, input, { signal: options?.signal }) as Promise<T>;
}

export function wbMutation<T>(
  path: string,
  input?: unknown,
  options?: { signal?: AbortSignal },
): Promise<T> {
  return wbClient.mutation(path, input, {
    signal: options?.signal,
  }) as Promise<T>;
}

/**
 * callWb 助手：把 token 注入请求体（文档硬性约束：token 在 body 而非 header）。
 * 用法：callWb('query', 'workbenchMarket.myPublishKeys', session, { ... })
 */
export function callWb<T>(
  kind: "query" | "mutation",
  path: string,
  session: WbSession | null,
  input?: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<T> {
  if (!session?.token) {
    return Promise.reject(new Error("未登录或会话已失效，请重新登录"));
  }
  const body = { ...(input ?? {}), token: session.token };
  return kind === "query"
    ? wbQuery<T>(path, body, options)
    : wbMutation<T>(path, body, options);
}

/** 判断是否为会话失效类错误（服务端 sessionMe 统一 UNAUTHORIZED「token 无效或已过期」） */
export function isWbAuthError(err: unknown): boolean {
  if (err instanceof TRPCClientError) {
    const code = (err.data as { code?: string } | undefined)?.code;
    if (code === "UNAUTHORIZED") return true;
    return /token 无效|未登录|已失效/.test(err.message);
  }
  return err instanceof Error && /token 无效|未登录|已失效/.test(err.message);
}

/** 提取用户可读错误信息 */
export function wbErrorMessage(err: unknown): string {
  if (err instanceof TRPCClientError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 轻量查询 hook：token 就绪后自动请求，返回 { data, error, loading, refetch }。
 * 会话失效错误自动清除本地会话（由 WbLayout 统一兜底跳转登录页）。
 */
export function useWbQuery<T>(
  path: string,
  session: WbSession | null,
  input?: Record<string, unknown>,
  options?: { enabled?: boolean; withToken?: boolean },
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authFailed, setAuthFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const enabled = options?.enabled ?? true;
  const withToken = options?.withToken ?? true;
  const inputKey = JSON.stringify(input ?? {});
  const previousInputKey = useRef(inputKey);
  const previousSessionToken = useRef(session?.token ?? "");
  const queryGeneration = useRef(0);

  useEffect(() => {
    if (withToken && !session?.token) {
      queryGeneration.current += 1;
      setData(null);
      setLoading(false);
      setError(null);
      setAuthFailed(false);
      return;
    }
    if (!enabled) {
      queryGeneration.current += 1;
      setLoading(false);
      return;
    }
    let cancelled = false;
    const generation = ++queryGeneration.current;
    const sessionToken = session?.token ?? "";
    if (
      previousInputKey.current !== inputKey ||
      previousSessionToken.current !== sessionToken
    ) {
      previousInputKey.current = inputKey;
      previousSessionToken.current = sessionToken;
      setAuthFailed(false);
      setData(null);
    }
    setLoading(true);
    setError(null);
    const body = withToken
      ? { ...JSON.parse(inputKey), token: session!.token }
      : JSON.parse(inputKey);
    wbQuery<T>(path, body)
      .then((res) => {
        if (cancelled || generation !== queryGeneration.current) return;
        setData(res);
        setAuthFailed(false);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || generation !== queryGeneration.current) return;
        if (isWbAuthError(err)) {
          setAuthFailed(true);
          clearWbSession();
        }
        setError(wbErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, inputKey, session?.token, enabled, withToken, tick]);

  return {
    data,
    error,
    loading,
    authFailed,
    refetch: () => setTick((t) => t + 1),
    replaceData: (value: T | null) => {
      queryGeneration.current += 1;
      setData(value);
      setError(null);
      setAuthFailed(false);
      setLoading(false);
    },
  };
}

// ─── SSE 流式端点（M8-c/M9-a）───────────────────────────────────────────────

/**
 * 构造 SSE 端点 URL。EventSource 只能发 GET，token 走 query 是全系统唯一例外
 * （服务端该路径日志打码）；本 URL 不得写入任何日志/上报。
 * 会话缺失时返回 null（调用方应走降级链路）。
 */
export function wbStreamUrl(
  path: "/api/stream/duty-chat" | "/api/stream/events" | "/api/stream/agent-market-live",
  session: WbSession | null,
  params?: Record<string, string>,
): string | null {
  if (!session?.token) return null;
  const q = new URLSearchParams({ token: session.token, ...(params ?? {}) });
  return `${path}?${q.toString()}`;
}
