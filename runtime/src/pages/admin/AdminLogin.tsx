/**
 * AdminLogin（/admin/login）—— NumX Max 超级终端登录页（赛博工业暗色风）。
 *
 * 认证沿用工作台体系：agentic.authLogin（identifier + password）登录成功后
 * 前端校验 role === 'admin'，非管理员拒绝进入；登录失败与非管理员统一提示
 * 「账号或密码错误，或权限不足」。会话存 localStorage("nebula_auth")（token 仅在请求体）。
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import {
  Loader2,
  LogIn,
  ShieldCheck,
  UserPlus,
  SearchCheck,
} from "lucide-react";
import HudCorner from "@/components/HudCorner";
import {
  useWbSession,
  wbMutation,
  wbQuery,
  type WbSession,
} from "@/lib/wbSession";
import { WbError, wbInputCls, wbLabelCls } from "@/components/wb/ui";
import { ADMIN_SITE_TITLE } from "@/lib/buildMode";
import {
  AUTH_LOGIN_FAIL_CLIENT,
  AUTH_SESSION_PERSIST_FAIL_MESSAGE,
} from "@contracts/authLock";

const LOGIN_FAIL_MSG = AUTH_LOGIN_FAIL_CLIENT;

/** M64：注册申请状态查询返回 */
interface MyApplicationResp {
  found: boolean;
  status?: string;
  reviewNote?: string | null;
  createdAt?: string | null;
  reviewedAt?: string | null;
}

export default function AdminLogin() {
  const { session, save } = useWbSession();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"login" | "register">("login");
  const [form, setForm] = useState({ identifier: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // 已是管理员会话 → 直接进入总览
  useEffect(() => {
    if (session?.token && session.role === "admin")
      navigate("/admin", { replace: true });
  }, [session?.token, session?.role, navigate]);

  function persistAdminSession(info: WbSession): boolean {
    const saved = save(info);
    if (!saved.ok) {
      setError(AUTH_SESSION_PERSIST_FAIL_MESSAGE);
      return false;
    }
    navigate("/admin", { replace: true });
    return true;
  }

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const info = await wbMutation<WbSession>("agentic.authLogin", {
        identifier: form.identifier.trim(),
        password: form.password,
      });
      if (info.role !== "admin") {
        // 非管理员：不保存会话，统一口径拒绝
        setError(LOGIN_FAIL_MSG);
        return;
      }
      if (!persistAdminSession({ ...info })) return;
    } catch {
      // 迭代 39：委派管理员回退——指定 COO/CMO 负责人账号经 staff.login + adminWhoami 放行
      try {
        const staff = await wbMutation<{
          token: string;
          displayName: string;
          deptKey: string;
          role: string;
        }>("staff.login", {
          identifier: form.identifier.trim(),
          password: form.password,
        });
        const who = await wbQuery<{
          username: string;
          displayName: string;
          role: string;
          delegated: boolean;
        }>("terminal.adminWhoami", { token: staff.token });
        if (who.role !== "admin" || !who.delegated) {
          setError(LOGIN_FAIL_MSG);
          return;
        }
        if (
          !persistAdminSession({
            token: staff.token,
            username: who.username,
            displayName: who.displayName,
            role: "admin",
            delegated: true,
          })
        )
          return;
      } catch {
        // M64：第三棒——超终原生账号（adminAuth.login，经注册审批开通的账号）
        try {
          const native = await wbMutation<WbSession & { adminOrigin?: string }>(
            "adminAuth.login",
            {
              identifier: form.identifier.trim(),
              password: form.password,
            },
          );
          if (
            !persistAdminSession({
              ...native,
              role: "admin",
              delegated: true,
              adminOrigin: "native",
            })
          )
            return;
          return;
        } catch {
          // 登录失败与权限不足统一提示，不区分账号是否存在
          setError(LOGIN_FAIL_MSG);
        }
      }
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
            <ShieldCheck className="h-6 w-6 text-forge-amber" />
            <span className="font-display text-lg font-bold text-ink-primary">
              {ADMIN_SITE_TITLE}
            </span>
          </div>
          <p className="hud-label mt-3 text-forge-amber/80">
            NEBULA ADMIN CONSOLE · RESTRICTED
          </p>
        </div>

        {/* iter96：品牌点缀——灵枢深色主视觉小卡片（低存在感，不影响登录逻辑） */}
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-line-subtle/60 bg-panel/40 px-4 py-3 opacity-80">
          <img
            src="/ip/m15/lingshu-hero.png"
            alt="灵枢"
            className="h-14 w-auto shrink-0 rounded-lg object-cover"
            draggable={false}
          />
          <p className="text-[11px] leading-relaxed text-ink-faint">
            灵枢与星云在此值守，与管理员一同守护平台秩序。
          </p>
        </div>

        <div className="cyber-scanline cyber-glow-card relative rounded-2xl bg-panel/80 p-7 md:p-9">
          <HudCorner />

          {/* M64：登录 / 注册申请 双通道 */}
          <div className="mb-6 grid grid-cols-2 gap-1 rounded-[10px] border border-line-subtle/60 bg-void/40 p-1">
            <button
              type="button"
              onClick={() => {
                setTab("login");
                setError(null);
              }}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === "login"
                  ? "bg-forge-amber/15 text-forge-amber"
                  : "text-ink-faint hover:text-ink-secondary"
              }`}
            >
              登录
            </button>
            <button
              type="button"
              onClick={() => {
                setTab("register");
                setError(null);
              }}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === "register"
                  ? "bg-forge-amber/15 text-forge-amber"
                  : "text-ink-faint hover:text-ink-secondary"
              }`}
            >
              注册申请
            </button>
          </div>

          {tab === "register" ? (
            <RegisterPanel />
          ) : (
            <>
              <p className="mb-6 text-xs leading-relaxed text-ink-faint">
                仅限管理员账号登录。门户与工作台共享同一数据源，本后台统一管理两边全部数据。
              </p>
              <form onSubmit={(e) => void handleLogin(e)} className="space-y-4">
                <div>
                  <label className={wbLabelCls}>管理员账号</label>
                  <input
                    className={wbInputCls}
                    value={form.identifier}
                    onChange={(e) =>
                      setForm({ ...form, identifier: e.target.value })
                    }
                    placeholder="手机号 / 账号"
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
                    onChange={(e) =>
                      setForm({ ...form, password: e.target.value })
                    }
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
                  登录超级终端
                </button>
              </form>
            </>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-ink-faint">
          <Link
            to="/staff/login"
            className="text-forge-amber/90 underline-offset-2 hover:underline"
          >
            部门负责人/员工入口 →
          </Link>
        </p>
      </div>
    </div>
  );
}

/** M64：注册申请面板——提交申请（一律人工审批）+ 自助查询申请状态 */
function RegisterPanel() {
  const [form, setForm] = useState({
    username: "",
    phone: "",
    displayName: "",
    reason: "",
    inviteCode: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState({ username: "", phone: "" });
  const [status, setStatus] = useState<MyApplicationResp | null>(null);
  const [querying, setQuerying] = useState(false);

  async function handleApply(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      await wbMutation("adminAuth.registerApply", {
        username: form.username.trim(),
        phone: form.phone.trim(),
        displayName: form.displayName.trim(),
        reason: form.reason.trim(),
        ...(form.inviteCode.trim()
          ? { inviteCode: form.inviteCode.trim() }
          : {}),
      });
      setNotice("申请已提交，等待管理员审批。审批通过后初始密码由管理员转告。");
      setForm({
        username: "",
        phone: "",
        displayName: "",
        reason: "",
        inviteCode: "",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败，请稍后再试");
    } finally {
      setPending(false);
    }
  }

  async function handleQuery(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus(null);
    setQuerying(true);
    try {
      const res = await wbQuery<MyApplicationResp>("adminAuth.myApplication", {
        username: query.username.trim(),
        phone: query.phone.trim(),
      });
      setStatus(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "查询失败，请稍后再试");
    } finally {
      setQuerying(false);
    }
  }

  const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
    pending: { text: "审批中", cls: "text-forge-amber" },
    approved: {
      text: "已通过（请联系管理员获取初始密码）",
      cls: "text-emerald-400",
    },
    rejected: { text: "已驳回", cls: "text-red-400" },
  };

  return (
    <div className="space-y-6">
      <p className="text-xs leading-relaxed text-ink-faint">
        申请超级终端管理员账号：提交后由超级管理员人工审批，审批通过后将获得一次性初始密码（首登后请立即修改）。
      </p>
      <form onSubmit={(e) => void handleApply(e)} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={wbLabelCls}>账号名</label>
            <input
              className={wbInputCls}
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="登录账号（≥3 位）"
              required
            />
          </div>
          <div>
            <label className={wbLabelCls}>手机号</label>
            <input
              className={wbInputCls}
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="11 位手机号"
              required
            />
          </div>
        </div>
        <div>
          <label className={wbLabelCls}>姓名</label>
          <input
            className={wbInputCls}
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            placeholder="真实姓名"
            required
          />
        </div>
        <div>
          <label className={wbLabelCls}>申请理由</label>
          <textarea
            className={`${wbInputCls} min-h-[72px] resize-y`}
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
            placeholder="简述用途与职责（选填）"
          />
        </div>
        <div>
          <label className={wbLabelCls}>邀请码（选填）</label>
          <input
            className={wbInputCls}
            value={form.inviteCode}
            onChange={(e) => setForm({ ...form, inviteCode: e.target.value })}
            placeholder="如有邀请码请填写"
          />
        </div>
        <WbError message={error} />
        {notice && (
          <p className="text-xs leading-relaxed text-emerald-400">{notice}</p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="inline-flex w-full items-center justify-center gap-2 rounded-[10px] bg-amber-gradient px-4 py-2.5 text-sm font-medium text-[#1A1206] transition-shadow duration-300 hover:shadow-[0_0_20px_rgba(245,165,36,0.35)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <UserPlus className="h-4 w-4" />
          )}
          提交注册申请
        </button>
      </form>

      <div className="border-t border-line-subtle/50 pt-5">
        <p className="mb-3 text-xs font-medium text-ink-secondary">
          查询我的申请状态
        </p>
        <form onSubmit={(e) => void handleQuery(e)} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input
              className={wbInputCls}
              value={query.username}
              onChange={(e) => setQuery({ ...query, username: e.target.value })}
              placeholder="申请时的账号名"
              required
            />
            <input
              className={wbInputCls}
              value={query.phone}
              onChange={(e) => setQuery({ ...query, phone: e.target.value })}
              placeholder="申请时的手机号"
              required
            />
          </div>
          <button
            type="submit"
            disabled={querying}
            className="inline-flex w-full items-center justify-center gap-2 rounded-[10px] border border-line-subtle bg-panel/60 px-4 py-2 text-xs font-medium text-ink-secondary transition-colors hover:border-forge-amber/40 hover:text-forge-amber disabled:opacity-50"
          >
            {querying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <SearchCheck className="h-3.5 w-3.5" />
            )}
            查询状态
          </button>
        </form>
        {status && (
          <div className="mt-3 rounded-lg border border-line-subtle/60 bg-void/40 px-3 py-2.5 text-xs leading-relaxed">
            {!status.found ? (
              <span className="text-ink-faint">
                未查询到匹配的申请记录，请核对账号名与手机号。
              </span>
            ) : (
              <>
                <span
                  className={
                    STATUS_LABEL[status.status ?? ""]?.cls ??
                    "text-ink-secondary"
                  }
                >
                  {STATUS_LABEL[status.status ?? ""]?.text ?? status.status}
                </span>
                {status.reviewNote && (
                  <p className="mt-1 text-ink-faint">
                    审批备注：{status.reviewNote}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
