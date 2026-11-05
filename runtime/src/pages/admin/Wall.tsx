/**
 * Wall（/admin/wall）—— 实时数据大屏（迭代 35 批次B，adminAnalytics.wallStats）。
 * 独立路由（不带后台侧边栏），深色大屏版式，10 秒轮询。
 * 内容：大数字卡片（今日新增用户/任务/GMV/开放工单）+ 漏斗摘要 + 健康分 Top5
 *      + 近 8 条审计滚动 + 7 日营收迷你图。所有数字来自后端，无口径则显示 —。
 * 设计基调：低饱和、暖色点缀（forge-amber）、克制高级感，不用蓝紫渐变。
 */
import { useEffect } from "react";
import { Navigate, useNavigate } from "react-router";
import {
  Activity,
  ArrowLeft,
  Coins,
  Filter,
  HeartPulse,
  ListTodo,
  ScrollText,
  Ticket,
  UserPlus,
} from "lucide-react";
import { useWbQuery, useWbSession } from "@/lib/wbSession";
import ScreenScale from "@/components/ScreenScale";
import { cn } from "@/lib/utils";
import { ADMIN_LOGIN_PATH } from "@/lib/buildMode";

type Row = Record<string, unknown>;

interface WallStatsResp {
  generatedAt?: unknown;
  today?: {
    newUsers?: unknown;
    newTasks?: unknown;
    gmv?: unknown;
    ticketsOpen?: unknown;
  };
  funnel?: unknown;
  topFactories?: Row[];
  recentAudit?: Row[];
  revenue7d?: unknown;
}

function pick(obj: Row | undefined, ...keys: string[]): unknown {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}
function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function fmtNum(v: unknown): string {
  const n = num(v);
  return n === null ? "—" : n.toLocaleString("zh-CN");
}
function fmtTime(v: unknown): string {
  return v
    ? new Date(String(v)).toLocaleString("zh-CN", { hour12: false })
    : "—";
}

// 漏斗归一化：数组 [{stage/label/name, value/count}] 或对象 {stage: value}
function normalizeFunnel(raw: unknown): { label: string; value: number }[] {
  if (Array.isArray(raw)) {
    return raw
      .map((r) => {
        const row = r as Row;
        return {
          label: String(pick(row, "label", "stage", "name", "step") ?? "—"),
          value: num(pick(row, "value", "count", "total")) ?? 0,
        };
      })
      .filter((f) => f.label !== "—");
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Row)
      .filter(([k]) => k !== "note")
      .map(([k, v]) => ({ label: k, value: num(v) ?? 0 }));
  }
  return [];
}

// 7 日营收归一化：[{date, amount/value}] 或 [number]
function normalizeRevenue(raw: unknown): { date: string; amount: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r, i) => {
    if (typeof r === "number") return { date: `D${i + 1}`, amount: r };
    const row = r as Row;
    const d = pick(row, "date", "day", "ts");
    const label = d
      ? new Date(String(d)).toLocaleDateString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
        })
      : `D${i + 1}`;
    return {
      date: label,
      amount: num(pick(row, "amount", "value", "gmv", "revenue")) ?? 0,
    };
  });
}

// ─── 迷你柱状图（纯 div，低饱和暖色）─────────────────────────────────────────

function RevenueMiniChart({
  data,
}: {
  data: { date: string; amount: number }[];
}) {
  if (data.length === 0)
    return <p className="py-6 text-center text-xs text-[#7A756C]">暂无口径</p>;
  const max = Math.max(...data.map((d) => d.amount), 1);
  return (
    <div className="flex h-28 items-end gap-2">
      {data.map((d) => (
        <div
          key={d.date}
          className="group flex min-w-0 flex-1 flex-col items-center gap-1.5"
        >
          <span className="font-mono text-[10px] text-[#B0A894] opacity-0 transition-opacity group-hover:opacity-100">
            {d.amount.toLocaleString("zh-CN")}
          </span>
          <div
            className="w-full max-w-[36px] rounded-t-[4px] bg-[#8C6D3F]/70 transition-colors group-hover:bg-[#C99B5F]"
            style={{
              height: `${Math.max(4, Math.round((d.amount / max) * 72))}px`,
            }}
          />
          <span className="font-mono text-[10px] text-[#7A756C]">{d.date}</span>
        </div>
      ))}
    </div>
  );
}

// ─── 大数字卡片 ──────────────────────────────────────────────────────────────

function BigStat({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Coins;
  label: string;
  value: unknown;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-[#2E2A24] bg-[#191613] p-6">
      <p className="flex items-center gap-2 text-xs tracking-widest text-[#8A8478]">
        <Icon className="h-4 w-4 text-[#C99B5F]" />
        {label}
      </p>
      <p className="mt-3 font-grotesk text-4xl font-bold text-[#EDE6D8]">
        {fmtNum(value)}
      </p>
      {sub && <p className="mt-1.5 text-[11px] text-[#7A756C]">{sub}</p>}
    </div>
  );
}

function WallPanel({
  icon: Icon,
  title,
  hud,
  children,
  className,
}: {
  icon: typeof Activity;
  title: string;
  hud: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-[#2E2A24] bg-[#191613] p-6",
        className,
      )}
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-bold text-[#EDE6D8]">
          <Icon className="h-4 w-4 text-[#C99B5F]" />
          {title}
        </h2>
        <span className="font-mono text-[10px] tracking-widest text-[#6B655A]">
          {hud}
        </span>
      </div>
      {children}
    </section>
  );
}

function healthTone(score: number): string {
  if (score >= 70) return "text-[#7FA884]";
  if (score >= 40) return "text-[#C99B5F]";
  return "text-[#C47A6B]";
}

export default function AdminWall() {
  const { session } = useWbSession();
  const navigate = useNavigate();
  const query = useWbQuery<WallStatsResp>(
    "adminAnalytics.wallStats",
    session,
    {},
    { enabled: !!session?.token },
  );

  // 10 秒轮询（契约：refetchInterval 10000）
  useEffect(() => {
    if (!session?.token) return;
    const timer = window.setInterval(() => query.refetch(), 10000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token]);

  if (!session?.token || session.role !== "admin") {
    return <Navigate to={ADMIN_LOGIN_PATH} replace />;
  }

  const d = query.data;
  const today = d?.today ?? {};
  const funnel = normalizeFunnel(d?.funnel);
  const funnelMax = Math.max(...funnel.map((f) => f.value), 1);
  const topFactories = d?.topFactories;
  const recentAudit = d?.recentAudit;
  const top = Array.isArray(topFactories) ? topFactories.slice(0, 5) : [];
  const audits = Array.isArray(recentAudit) ? recentAudit.slice(0, 8) : [];
  const revenue = normalizeRevenue(d?.revenue7d);

  return (
    <ScreenScale>
      <div className="h-full w-full overflow-hidden bg-[#12100D] px-8 py-6 text-[#EDE6D8]">
        {/* 顶栏 */}
        <header className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => navigate("/admin")}
              className="flex items-center gap-1.5 rounded-lg border border-[#2E2A24] px-3 py-1.5 text-xs text-[#8A8478] transition-colors hover:border-[#C99B5F]/50 hover:text-[#C99B5F]"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> 返回后台
            </button>
            <div>
              <h1 className="font-display text-2xl font-bold tracking-wide">
                NumX Max 实时数据大屏
              </h1>
              <p className="mt-0.5 font-mono text-[11px] tracking-[0.3em] text-[#6B655A]">
                NUMX MAX LIVE OPERATIONS WALL
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="flex items-center justify-end gap-1.5 text-xs text-[#8A8478]">
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  query.error ? "bg-[#C47A6B]" : "animate-pulse bg-[#7FA884]",
                )}
              />
              {query.error ? "连接异常" : "10s 实时轮询中"}
            </p>
            <p className="mt-1 font-mono text-[11px] text-[#6B655A]">
              数据生成于 {d?.generatedAt ? fmtTime(d.generatedAt) : "—"}
            </p>
          </div>
        </header>

        {query.error && (
          <p className="mb-6 rounded-xl border border-[#C47A6B]/30 bg-[#C47A6B]/[0.06] px-4 py-3 text-xs text-[#C47A6B]">
            {query.error}
          </p>
        )}

        {/* 大数字卡片 */}
        <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <BigStat
            icon={UserPlus}
            label="今日新增用户 NEW USERS"
            value={today.newUsers}
          />
          <BigStat
            icon={ListTodo}
            label="今日任务 NEW TASKS"
            value={today.newTasks}
          />
          <BigStat icon={Coins} label="今日 GMV" value={today.gmv} />
          <BigStat
            icon={Ticket}
            label="开放工单 OPEN TICKETS"
            value={today.ticketsOpen}
          />
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          {/* 漏斗摘要 */}
          <WallPanel icon={Filter} title="转化漏斗摘要" hud="FUNNEL">
            {funnel.length === 0 ? (
              <p className="py-6 text-center text-xs text-[#7A756C]">
                暂无口径
              </p>
            ) : (
              <div className="space-y-3">
                {funnel.map((f) => (
                  <div key={f.label}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="text-[#B0A894]">{f.label}</span>
                      <span className="font-mono text-[#EDE6D8]">
                        {f.value.toLocaleString("zh-CN")}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-[#0E0C0A]">
                      <div
                        className="h-full rounded-full bg-[#8C6D3F]/80"
                        style={{
                          width: `${Math.max(2, (f.value / funnelMax) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </WallPanel>

          {/* 健康分 Top5 */}
          <WallPanel
            icon={HeartPulse}
            title="企业健康分 Top 5"
            hud="HEALTH TOP5"
          >
            {top.length === 0 ? (
              <p className="py-6 text-center text-xs text-[#7A756C]">
                暂无数据
              </p>
            ) : (
              <ol className="space-y-2.5">
                {top.map((f, i) => {
                  const score = num(pick(f, "score")) ?? 0;
                  return (
                    <li
                      key={String(
                        pick(f, "factoryId", "factory_id", "id") ?? i,
                      )}
                      className="flex items-center gap-3"
                    >
                      <span className="w-5 shrink-0 text-center font-mono text-xs text-[#6B655A]">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-[#B0A894]">
                        {String(
                          pick(f, "name", "factoryName", "factory_name") ??
                            `#${pick(f, "factoryId", "factory_id", "id") ?? "—"}`,
                        )}
                      </span>
                      <div className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-[#0E0C0A]">
                        <div
                          className="h-full rounded-full bg-[#8C6D3F]/70"
                          style={{
                            width: `${Math.min(100, Math.max(0, score))}%`,
                          }}
                        />
                      </div>
                      <span
                        className={cn(
                          "w-8 shrink-0 text-right font-mono text-sm font-bold",
                          healthTone(score),
                        )}
                      >
                        {score}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </WallPanel>

          {/* 近 8 条审计滚动 */}
          <WallPanel icon={ScrollText} title="最新审计留痕" hud="AUDIT TAIL">
            {audits.length === 0 ? (
              <p className="py-6 text-center text-xs text-[#7A756C]">
                暂无数据
              </p>
            ) : (
              <ul className="space-y-2.5">
                {audits.map((a, i) => (
                  <li
                    key={String(pick(a, "id") ?? i)}
                    className="flex items-start gap-2.5 text-xs"
                  >
                    <Activity className="mt-0.5 h-3 w-3 shrink-0 text-[#8C6D3F]" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[#B0A894]">
                        <span className="font-mono text-[#C99B5F]">
                          {String(pick(a, "action") ?? "—")}
                        </span>
                        <span className="mx-1.5 text-[#6B655A]">·</span>
                        {String(pick(a, "adminName", "admin_name") ?? "—")}
                        <span className="mx-1.5 text-[#6B655A]">→</span>
                        <span className="font-mono text-[#8A8478]">
                          {String(pick(a, "target") ?? "—")}
                        </span>
                      </p>
                      <p className="mt-0.5 font-mono text-[10px] text-[#6B655A]">
                        {fmtTime(pick(a, "createdAt", "created_at"))}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </WallPanel>
        </div>

        {/* 7 日营收迷你图 */}
        <WallPanel
          icon={Coins}
          title="近 7 日营收"
          hud="REVENUE 7D"
          className="mt-4"
        >
          <RevenueMiniChart data={revenue} />
        </WallPanel>

        <p className="mt-6 text-center font-mono text-[10px] tracking-widest text-[#4A453D]">
          NumX Max · 数据每 10 秒自动刷新 · 无口径字段显示 —（不伪造）
        </p>
      </div>
    </ScreenScale>
  );
}
