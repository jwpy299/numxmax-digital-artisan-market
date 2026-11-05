/**
 * StaffLogin（/staff/login）—— NumX Max 超级终端 · 部门工作台统一入口。
 *
 * 部门负责人与员工统一登录：staff.login（identifier + password）→ nt_ 单点 token，
 * 会话存 localStorage("nebula_staff_auth")（独立于管理员会话），成功后跳 /staff/workspace。
 * 账号全部由分发产生（总经理分发负责人、负责人分发员工），本页不提供注册。
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { Loader2, LogIn, Users } from "lucide-react";
import HudCorner from "@/components/HudCorner";
import {
  useStaffSession,
  wbMutation,
  wbErrorMessage,
  type StaffSession,
} from "@/lib/staffSession";
import { WbError, wbInputCls, wbLabelCls } from "@/components/wb/ui";
import { ADMIN_LOGIN_PATH } from "@/lib/buildMode";

export default function StaffLogin() {
  const { session, save } = useStaffSession();
  const navigate = useNavigate();
  const [form, setForm] = useState({ identifier: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // 已是部门会话 → 直接进入工作台
  useEffect(() => {
    if (session?.token) navigate("/staff/workspace", { replace: true });
  }, [session?.token, navigate]);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const info = await wbMutation<StaffSession>("staff.login", {
        identifier: form.identifier.trim(),
        password: form.password,
      });
      const saved = save({ ...info });
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      navigate("/staff/workspace", { replace: true });
    } catch (err) {
      setError(wbErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="cyber-grid-bg relative flex min-h-screen items-center justify-center bg-void px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2.5">
            <img
              src="/logo-mark.png"
              alt="NumX Max"
              className="h-10 w-10 object-contain"
            />
            <Users className="h-6 w-6 text-forge-amber" />
            <span className="font-display text-lg font-bold text-ink-primary">
              NumX Max 超级终端 · 部门工作台入口
            </span>
          </div>
          <p className="hud-label mt-3 text-forge-amber/80">
            NEBULA DEPT WORKSPACE · STAFF ONLY
          </p>
        </div>

        <div className="cyber-scanline cyber-glow-card relative rounded-2xl bg-panel/80 p-7 md:p-9">
          <HudCorner />
          <p className="mb-6 text-xs leading-relaxed text-ink-faint">
            部门负责人与员工统一入口；账号由总经理或部门负责人分发，本页不提供注册。
          </p>
          <form onSubmit={(e) => void handleLogin(e)} className="space-y-4">
            <div>
              <label className={wbLabelCls}>账号</label>
              <input
                className={wbInputCls}
                value={form.identifier}
                onChange={(e) =>
                  setForm({ ...form, identifier: e.target.value })
                }
                placeholder="手机号 / 账号名"
                required
                autoComplete="username"
              />
            </div>
            <div>
              <label className={wbLabelCls}>密码</label>
              <input
                className={wbInputCls}
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="登录密码"
                required
                autoComplete="current-password"
              />
            </div>
            <WbError message={error} />
            <button
              type="submit"
              disabled={pending}
              className="inline-flex w-full items-center justify-center gap-2 rounded-[10px] bg-amber-gradient px-4 py-2.5 text-sm font-medium text-[#1A1206] transition-shadow duration-300 hover:shadow-[0_0_20px_rgba(245,165,36,0.35)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <LogIn className="h-4 w-4" />
              )}
              登录部门工作台
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-ink-faint">
          管理员请前往{" "}
          <Link
            to={ADMIN_LOGIN_PATH}
            className="text-forge-amber/90 underline-offset-2 hover:underline"
          >
            超级终端管理入口 →
          </Link>
        </p>
      </div>
    </div>
  );
}
