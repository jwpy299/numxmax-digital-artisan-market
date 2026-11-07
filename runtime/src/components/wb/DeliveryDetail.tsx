import { Link } from "react-router";
import { useEffect, useMemo, useState } from "react";
import {
  callWb,
  clearWbSession,
  isWbAuthError,
  useWbSessionRevision,
  wbErrorMessage,
  type WbSession,
} from "@/lib/wbSession";
import { stableSerialize } from "@/lib/stableSerialize";
import { ADMIN_ONLY, ADMIN_LOGIN_PATH } from "@/lib/buildMode";
import { LOGIN_PATH } from "@/const";

interface DeliveryBody {
  deliverable: string | null;
  evidenceSha256: string | null;
}
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
function isDeliveryBody(value: unknown): value is DeliveryBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return (
    "deliverable" in body &&
    "evidenceSha256" in body &&
    isNullableString(body.deliverable) &&
    isNullableString(body.evidenceSha256)
  );
}
interface DeliveryDetailProps {
  path: string;
  input: Record<string, unknown>;
  resultKey: "task" | "claim";
  session: WbSession | null;
  label: string;
  cacheKey?: string | null;
}
interface DeliveryState {
  status: "idle" | "loading" | "ready" | "error";
  key?: string;
  credential?: string;
  delivery?: DeliveryBody;
  error?: string;
  authError?: boolean;
}

/** 按需证据原文：列表不载正文，展开才鉴权读取；cacheKey（证据哈希）变化时强制重新加载。 */
export function DeliveryDetail({
  path,
  input,
  resultKey,
  session,
  label,
  cacheKey,
}: DeliveryDetailProps) {
  const [open, setOpen] = useState(false);
  const loginHref = ADMIN_ONLY ? ADMIN_LOGIN_PATH : LOGIN_PATH;
  const [retryToken, setRetryToken] = useState(0);
  const [state, setState] = useState<DeliveryState>({ status: "idle" });
  const sessionRevision = useWbSessionRevision()
  const credential = `${sessionRevision}:${session?.token ?? ''}`;
  const { requestKey, serializationFailed } = useMemo(() => {
    try {
      return {
        requestKey: stableSerialize({ path, input, cacheKey, resultKey }),
        serializationFailed: false,
      };
    } catch {
      return {
        requestKey: `unserializable:${path}:${cacheKey ?? ""}:${resultKey}`,
        serializationFailed: true,
      };
    }
  }, [path, input, cacheKey, resultKey]);
  const stateIsCurrent =
    state.key === requestKey && state.credential === credential;
  const ready = stateIsCurrent && state.status === "ready";
  const errorVisible =
    state.status === "error" &&
    state.key === requestKey &&
    (state.credential === credential || state.authError);
  const reload = () => {
    setState({ status: "loading", key: requestKey, credential });
    setRetryToken((value) => value + 1);
  };

  useEffect(() => {
    if (!open || serializationFailed || ready) return;
    if (!session?.token) {
      setState({
        status: "error",
        key: requestKey,
        credential,
        authError: true,
        error: "登录会话已失效，请重新登录后重试读取。",
      });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setState({ status: "loading", key: requestKey, credential });
    async function load() {
      try {
        const response = await callWb<Record<string, DeliveryBody>>(
          "query",
          path,
          session,
          input,
          { signal: controller.signal },
        );
        if (cancelled || controller.signal.aborted) return;
        if (!response || typeof response !== "object") {
          setState({
            status: "error",
            key: requestKey,
            credential,
            error: "交付响应包络无效",
          });
        } else {
          const delivery = response[resultKey];
          if (!isDeliveryBody(delivery))
            setState({
              status: "error",
              key: requestKey,
              credential,
              error: "交付响应形状无效，缺少 deliverable/evidenceSha256 字段",
            });
          else
            setState({
              status: "ready",
              key: requestKey,
              credential,
              delivery,
            });
        }
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        const authError = isWbAuthError(error);
        if (authError) clearWbSession();
        setState({
          status: "error",
          key: requestKey,
          credential,
          authError,
          error: wbErrorMessage(error),
        });
      }
    }
    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // credential 同时绑定 revision 与 token；revision 未变但 token 改变也必须重新鉴权。
    // 请求只由 open/requestKey/credential 驱动；ready/error 状态变化本身不得再次触发请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, requestKey, credential, retryToken, serializationFailed]);

  return (
    <details
      className="mt-3"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-xs text-pulse-cyan">
        {label}
      </summary>
      {open && serializationFailed && (
        <p className="text-xs text-ember-red">
          当前交付参数无法安全序列化，已阻止读取；请刷新或联系管理员核查。
        </p>
      )}
      {open &&
        !serializationFailed &&
        session?.token &&
        (!stateIsCurrent || state.status === "loading") &&
        !errorVisible && (
          <p role="status" className="text-xs text-ink-faint">
            正在按权限读取交付原文…
          </p>
        )}
      {open && !serializationFailed && errorVisible && (
        <div className="mt-2 flex items-center gap-3">
          <p role="alert" className="text-xs text-ember-red">
            {state.error}
          </p>
          {session?.token ? (
            <button
              type="button"
              onClick={reload}
              className="rounded border border-pulse-cyan px-2 py-1 text-xs text-pulse-cyan"
            >
              重试读取
            </button>
          ) : (
            <Link
              to={loginHref}
              className="rounded border border-pulse-cyan px-2 py-1 text-xs text-pulse-cyan"
            >
              重新登录后重试
            </Link>
          )}
        </div>
      )}
      {open &&
        !serializationFailed &&
        ready &&
        (state.delivery?.deliverable !== null ? (
          <>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-void p-3 text-xs">
              {state.delivery?.deliverable}
            </pre>
            {state.delivery?.evidenceSha256 && (
              <p className="mt-2 break-all font-mono text-[10px] text-ink-faint">
                SHA-256 {state.delivery.evidenceSha256}
              </p>
            )}
          </>
        ) : (
          <p role="status" className="mt-2 text-xs text-ink-faint">
            当前没有可查看的交付原文（可能已被返工或改派，请刷新列表）。
          </p>
        ))}
      {open && !serializationFailed && ready && (
        <button
          type="button"
          onClick={reload}
          className="mt-2 rounded border border-line-subtle px-2 py-1 text-xs text-ink-secondary"
        >
          重新读取
        </button>
      )}
    </details>
  );
}
