/**
 * Login（/login）—— 「登录 / 注册 · NumX Max·数字匠市」门户账号页（迭代 14 重写，已移除第三方 OAuth）。
 *
 * 三个 tab：登录（手机号+密码 / M25 短信验证码双方式）/ 企业注册 / 个人注册（M25 短信验证码链路）；
 * M25 短信三公开口（sms.sendCode / sms.loginByPhone / sms.registerByPhone）无 token 概念；
 * 成功后会话对象写入 localStorage("nebula_auth")（沿用 WorkbenchSession 约定），
 * 企业账号跳 /workbench 中转（SSO 到独立工作台站），个人账号跳 /market。
 */
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { Loader2, LogIn } from "lucide-react";
import HudCorner from "@/components/HudCorner";
import {
  saveWbSession,
  wbMutation,
  wbErrorMessage,
  type WbSession,
} from "@/lib/wbSession";
import { cn } from "@/lib/utils";
import { SmsCodeRow } from "@/components/auth/SmsCodeRow";
import {
  EntRegisterForm,
  PersonRegisterForm,
} from "@/components/auth/PortalRegisterForms";
import { WbError, wbInputCls, wbLabelCls } from "@/components/wb/ui";

type Tab = "login" | "enterprise" | "person";

const TABS: { key: Tab; label: string }[] = [
  { key: "login", label: "登录" },
  { key: "enterprise", label: "企业注册" },
  { key: "person", label: "个人注册" },
];

export default function Login() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("login");
  const [finishError, setFinishError] = useState<string | null>(null);

  /** 成功：会话写入 localStorage(nebula_auth)，按账号类型分流。
   *  企业账号去 /workbench 中转页（迭代 17：工作台独立部署，经两段式 SSO 免密跳转）。 */
  function finish(session: WbSession) {
    const saved = saveWbSession(session);
    if (!saved.ok) {
      const registered = tab !== "login";
      setFinishError(registered ? `账号已创建，但本地会话保存失败，请直接登录，禁止重复注册。${saved.error}` : saved.error);
      if (registered) setTab("login");
      return;
    }
    setFinishError(null);
    navigate(session.kind === "person" ? "/market" : "/workbench", {
      replace: true,
    });
  }

  return (
    <div className="cyber-grid-bg cyber-scanline relative min-h-screen overflow-hidden bg-void">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[820px] -translate-x-1/2 bg-[radial-gradient(ellipse,rgba(245,165,36,0.12),transparent_65%)]" />

      <div className="relative mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center px-4 py-14">
        <div className="mb-8 text-center">
          <Link to="/" className="inline-flex items-center gap-3">
            <img
              src="/logo-mark.png"
              alt="NumX Max"
              className="h-10 w-10 object-contain"
            />
            <span className="font-display text-xl font-bold tracking-wide text-ink-primary">
              登录 / 注册 · NumX Max·数字匠市
            </span>
          </Link>
          <p className="hud-label mt-3 text-amber-400/80">
            NEBULA ARTISAN MARKET · SIGN IN
          </p>
        </div>

        <div
          onSubmitCapture={() => setFinishError(null)}
          className="cyber-glow-card relative w-full rounded-2xl bg-zinc-950/80 p-7 md:p-9"
        >
          <HudCorner />
          {/* 每次新登录/注册尝试先清上一轮存储错误，避免与本轮鉴权错误混淆。 */}
          {finishError && (
            <div className="mb-4">
              <WbError message={finishError} />
            </div>
          )}

          {/* Tab 切换 */}
          <div className="mb-6 grid grid-cols-3 gap-1 rounded-[10px] border border-line-subtle bg-void/60 p-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => {
                  setFinishError(null);
                  setTab(t.key);
                }}
                className={cn(
                  "rounded-[8px] py-2 text-sm font-medium transition-colors duration-300",
                  tab === t.key
                    ? "bg-pulse-cyan/[0.12] text-pulse-cyan"
                    : "text-ink-secondary hover:text-ink-primary",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === "login" && <LoginForm onSuccess={finish} />}
          {tab === "enterprise" && <EntRegisterForm onSuccess={finish} />}
          {tab === "person" && (
            <PersonRegisterForm
              onSuccess={finish}
              smsCodeRow={({ phone, code, onCodeChange }) => (
                <SmsCodeRow
                  phone={phone}
                  purpose="register"
                  code={code}
                  onCodeChange={onCodeChange}
                />
              )}
            />
          )}
        </div>

        {tab !== "login" && (
          <p className="mt-4 text-center text-xs text-ink-faint">
            注册即代表同意
            <Link
              to="/legal/terms"
              className="mx-1 text-pulse-cyan hover:underline"
            >
              《用户协议》
            </Link>
            与
            <Link
              to="/legal/privacy"
              className="mx-1 text-pulse-cyan hover:underline"
            >
              《隐私政策》
            </Link>
          </p>
        )}

        <p className="mt-6 text-center text-xs text-ink-faint">
          登录 / 注册会重颁 token（单点有效），其他端的旧登录态将失效。
        </p>
      </div>
    </div>
  );
}

// ─── 登录（手机号 + 密码 / M25 短信验证码双方式）───────────────────────────────
function LoginForm({ onSuccess }: { onSuccess: (s: WbSession) => void }) {
  const [mode, setMode] = useState<"password" | "sms">("password");
  const [form, setForm] = useState({ phone: "", password: "", code: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      // M25 短信登录：sms.loginByPhone {phone, code}（公开口）；密码登录保留并存
      const session =
        mode === "sms"
          ? await wbMutation<WbSession>("sms.loginByPhone", {
              phone: form.phone.trim(),
              code: form.code.trim(),
            })
          : await wbMutation<WbSession>("agentic.authLogin", {
              identifier: form.phone.trim(),
              password: form.password,
            });
      onSuccess(session);
    } catch (err) {
      setError(wbErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      {/* M25 登录方式切换：密码登录 / 短信验证码登录 */}
      <div className="grid grid-cols-2 gap-1 rounded-[10px] border border-line-subtle bg-void/60 p-1">
        {(["password", "sms"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setError(null);
            }}
            className={cn(
              "rounded-[8px] py-1.5 text-xs font-medium transition-colors duration-300",
              mode === m
                ? "bg-pulse-cyan/[0.12] text-pulse-cyan"
                : "text-ink-secondary hover:text-ink-primary",
            )}
          >
            {m === "password" ? "密码登录" : "短信验证码登录"}
          </button>
        ))}
      </div>
      <div>
        <label className={wbLabelCls}>手机号</label>
        <input
          className={wbInputCls}
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
          placeholder="注册时使用的手机号"
          inputMode="numeric"
          maxLength={mode === "sms" ? 11 : undefined}
          required
        />
      </div>
      {mode === "password" ? (
        <div>
          <label className={wbLabelCls}>密码</label>
          <input
            type="password"
            className={wbInputCls}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="登录密码"
            required
          />
        </div>
      ) : (
        <SmsCodeRow
          phone={form.phone}
          purpose="login"
          code={form.code}
          onCodeChange={(v) => setForm({ ...form, code: v })}
        />
      )}
      <WbError message={error} />
      <button
        type="submit"
        disabled={pending}
        className="flex w-full items-center justify-center gap-2 rounded-[10px] bg-amber-gradient py-2.5 text-sm font-medium text-[#1A1206] transition-shadow hover:shadow-[0_0_24px_rgba(245,165,36,0.4)] disabled:opacity-50"
      >
        {pending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <LogIn className="h-4 w-4" />
        )}
        登录
      </button>
    </form>
  );
}
