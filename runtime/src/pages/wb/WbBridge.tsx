/**
 * WbBridge（/wb/bridge）—— 两段式 SSO 消费端。
 *
 * 流程：URL 取 ticket → nebulaLink.consumeWorkbenchTicket 原子核销 →
 * 保存返回的新会话（nt_ token 覆盖 localStorage("nebula_auth")）→ 跳转 target。
 *
 * 防双调：ticket 一次性（原子核销，二次必失败），React StrictMode 下
 * effect 会执行两次，必须用 useRef 保证只提交一次（官方文档硬性要求）。
 */
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Loader2, ShieldAlert } from "lucide-react";
import HudCorner from "@/components/HudCorner";
import { saveWbSession, wbMutation, wbErrorMessage } from "@/lib/wbSession";
import { WORKBENCH_TARGETS, NEBULA_WORKBENCH_URL } from "@/config/workbench";
import { ADMIN_ONLY } from "@/lib/buildMode";
import type { WbConsumeResult } from "@/lib/wbTypes";

/**
 * 落地页白名单映射：/home → /wb/home（未知 target 一律回落今日工作台 /wb/home）。
 * 白名单 = 官方 WORKBENCH_TARGETS + 迭代 32 新增的 /home、/digest
 * （前端本地扩展：后端 ticket target 枚举仍限定官方集，portal 不会下发新值，
 *  此处仅为未来契约扩展与直链兜底）。
 */
const BRIDGE_TARGETS: readonly string[] = [
  ...WORKBENCH_TARGETS,
  "/home",
  "/digest",
];

function resolveTargetPath(target: string | undefined): string {
  const hit = BRIDGE_TARGETS.find((t) => t === target);
  const safe = hit ?? "/home";
  return `/wb${safe}`;
}

export default function WbBridge() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const submittedRef = useRef(false);

  useEffect(() => {
    // StrictMode 双调用防护：同一 ticket 只允许提交一次
    if (submittedRef.current) return;
    submittedRef.current = true;

    const ticket = params.get("ticket");
    if (!ticket) {
      setError("ticket 无效或已过期");
      return;
    }

    wbMutation<WbConsumeResult>("nebulaLink.consumeWorkbenchTicket", { ticket })
      .then((res) => {
        // 消费成功即重颁 nt_ token（旧 token 失效）：必须覆盖保存新会话
        const saved = saveWbSession({
          token: res.token,
          username: res.username,
          displayName: res.displayName,
          enterpriseName: res.enterpriseName,
          factoryId: res.factoryId,
          role: res.role,
        });
        if (!saved.ok) {
          setError(
            "ticket 已消费，但新会话未能保存。请返回市场重新发起跳转，不要重复使用本 ticket。",
          );
          return;
        }
        // M37：超级终端独立包消费后落 /admin（无 /wb/* 路由）；其余包维持 /wb 目标页
        navigate(ADMIN_ONLY ? "/admin" : resolveTargetPath(res.target), {
          replace: true,
        });
      })
      .catch((err) => {
        // 任何失败统一口径：ticket 无效或已过期（不区分不存在 / 已用 / 过期）
        setError(wbErrorMessage(err) || "ticket 无效或已过期");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-void px-4">
      <div
        aria-hidden
        className="nebula-halo pointer-events-none absolute -top-32 left-1/2 h-80 w-[640px] -translate-x-1/2"
      />
      <div className="glass-panel relative w-full max-w-md rounded-2xl p-9 text-center">
        <HudCorner />
        <p className="hud-label text-pulse-cyan/80">SSO BRIDGE</p>

        {error ? (
          <>
            <div className="mx-auto mt-6 flex h-14 w-14 items-center justify-center rounded-xl border border-ember-red/30 bg-ember-red/10">
              <ShieldAlert className="h-7 w-7 text-ember-red" />
            </div>
            <h1 className="mt-5 font-display text-xl font-bold text-ink-primary">
              免密跳转失败
            </h1>
            <p className="mt-3 rounded-xl border border-ember-red/30 bg-ember-red/[0.06] px-4 py-3 text-xs leading-relaxed text-ember-red">
              {error}
            </p>
            <p className="mt-3 text-xs leading-relaxed text-ink-secondary">
              ticket 为一次性凭据且有效期仅 5
              分钟；过期或被消费后需回到市场重新发起跳转。
            </p>
            <div className="mt-6 flex justify-center gap-3">
              <Link
                to="/workbench"
                className="rounded-[10px] bg-amber-gradient px-5 py-2.5 text-sm font-medium text-[#1A1206] transition-shadow hover:shadow-[0_0_20px_rgba(245,165,36,0.4)]"
              >
                返回市场门户
              </Link>
              <a
                href={`${NEBULA_WORKBENCH_URL}/wb/login`} // 丝滑度修面：/wb/login 是工作台端路由（门户无此路由=死链）——跨端绝对面[单源 NEBULA_WORKBENCH_URL]，不相对
                className="rounded-[10px] border border-line-subtle px-5 py-2.5 text-sm text-ink-primary transition-colors hover:border-pulse-cyan/50 hover:bg-pulse-cyan/[0.08]"
              >
                账号登录
              </a>
            </div>
          </>
        ) : (
          <>
            <Loader2 className="mx-auto mt-6 h-10 w-10 animate-spin text-pulse-cyan" />
            <h1 className="mt-5 font-display text-xl font-bold text-ink-primary">
              正在进入工作台…
            </h1>
            <p className="mt-2 text-xs text-ink-secondary">
              正在核销一次性跳转 ticket 并建立会话（token
              将重颁，旧登录态失效）。
            </p>
          </>
        )}
      </div>
    </div>
  );
}
