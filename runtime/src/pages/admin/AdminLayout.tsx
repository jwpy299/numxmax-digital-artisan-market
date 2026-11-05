/**
 * AdminLayout（/admin）—— 超级终端布局：左侧导航 + 顶栏账号 chip + 退出。
 * 会话守卫：无 token 或 role !== 'admin' 一律重定向 /admin/login。
 */
import { useEffect, useRef, useState } from "react";
import {
  Navigate,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router";
import {
  Inbox,
  UserCheck,
  Activity,
  BarChart3,
  Bell,
  Bug,
  Building2,
  Cpu,
  ClipboardCheck,
  CreditCard,
  Gauge,
  GitBranch,
  Globe,
  Headphones,
  HeartPulse,
  KeyRound,
  Landmark,
  Layers,
  LogOut,
  Panda,
  Network,
  Radar,
  ScrollText,
  TrendingUp,
  BookOpen,
  Headset,
  ShieldAlert,
  ShieldCheck,
  ShoppingCart,
  Store,
  Coins,
  Users,
  Briefcase,
  PackageCheck,
  Star,
  Ticket,
  MonitorPlay,
  Brain,
  Menu,
  X,
} from "lucide-react";
import AdminBuddy from "@/components/admin/AdminBuddy";
import {
  DEFAULT_STATION_TAB,
  stationQueueUrl,
  ROUTE_ADMIN_APPROVALS,
  ROUTE_ADMIN_PROTOCOLS,
  ROUTE_ADMIN_STATIONS,
  ROUTE_ADMIN_KNOWLEDGE,
  ROUTE_ADMIN_WECHAT_CS,
  ROUTE_ADMIN_AGENT_REVIEW_QUEUE,
  ROUTE_ADMIN_AGENT_TRAINING_REVIEW,
  STATION_CODE_REL,
  STATION_CODE_MKT,
  STATION_CODE_FIN,
  STATION_CODE_OPS,
  STATION_CODE_RUNOPS,
  STATION_CODE_LAW,
  STATION_CODE_BRAND,
  STATION_CODE_CH,
  STATION_CODE_KNOW,
  STATION_CODE_MISC,
} from "@/lib/adminStations";
import MechaEntrance from "@/components/digitalhuman/MechaEntrance";
import { useWbSession } from "@/lib/wbSession";
import { cn } from "@/lib/utils";
import { useModalFocusTrap } from "@/lib/useModalFocusTrap";
import { MODAL_DESKTOP_MEDIA_QUERY } from "@/lib/breakpoints";
import { ADMIN_LOGIN_PATH } from "@/lib/buildMode";

const NAV_ITEMS = [
  { to: "/admin", end: true, icon: Gauge, label: "总览" },
  { to: ROUTE_ADMIN_APPROVALS, icon: Inbox, label: "审批中心" },
  { to: "/admin/beta", icon: ShieldCheck, label: "内测审批" }, // AdminBeta 页导航入列（路由已在导航未挂=模块不可见面封死——彭总 2026-10-12 实证）
  { to: "/admin/finance", icon: Landmark, label: "财务中心" },
  { to: "/admin/memory", icon: Brain, label: "记忆治理" },
  // 迭代 35：经营分析 / 企业健康 / 进化看板（adminAnalytics.*）
  { to: "/admin/analytics", icon: BarChart3, label: "经营分析" },
  { to: "/admin/health", icon: HeartPulse, label: "企业健康" },
  { to: "/admin/evo-board", icon: TrendingUp, label: "进化看板" },
  { to: "/admin/users", icon: Users, label: "用户管理" },
  { to: "/admin/factories", icon: Building2, label: "企业管理" },
  // iter91：龙虾租户化 + 熊猫军团流水线
  { to: "/admin/claw-whitelist", icon: Globe, label: "白名单审批" },
  { to: "/admin/corps", icon: Panda, label: "军团总览" },
  { to: "/admin/claw-tiers", icon: Layers, label: "龙虾分级" },
  // iter92：套餐管理 / 技能审核 / 告警日志（上线冲刺）
  { to: "/admin/plans", icon: CreditCard, label: "套餐管理" },
  { to: "/admin/market-review", icon: PackageCheck, label: "技能审核" },
  { to: "/admin/alerts", icon: Bell, label: "告警日志" },
  { to: "/admin/agents", icon: Cpu, label: "数字员工" },
  { to: "/admin/recruitments", icon: Briefcase, label: "招聘与应征" },
  { to: "/admin/orders", icon: ShoppingCart, label: "雇佣订单" },
  { to: "/admin/tokens", icon: Coins, label: "Token 流水" },
  // 迭代 34：Token 充值处理队列（wbBilling.*）
  { to: "/admin/topups", icon: Landmark, label: "充值处理" },
  { to: "/admin/devs", icon: PackageCheck, label: "开发者生态" },
  // 迭代 27：运营监控与安全治理（放「系统健康」前）
  { to: "/admin/ops", icon: Activity, label: "运营监控" },
  { to: "/admin/security", icon: ShieldAlert, label: "反攻击矩阵" },
  { to: "/admin/vulns", icon: Bug, label: "漏洞修复矩阵" },
  // 迭代 30：技能中心（技能体系 + 自进化引擎）
  { to: "/admin/skill-shop", icon: Store, label: "技能商店" },
  // M48：dsh-plugin-store 插件仓管理台（装机即入全员工具体系）
  { to: "/admin/plugin-store", icon: PackageCheck, label: "插件仓" },
  { to: "/admin/cs-center", icon: Headphones, label: "客服中心" },
  { to: "/admin/system", icon: HeartPulse, label: "系统健康" },
  // Harness 交付装配线：发布观测板（制品仓库/在跑指纹/发布流水/回滚指引）
  { to: "/admin/releases", icon: GitBranch, label: "发布观测板" },
  // M32 数字员工考核列编（运行装配线：任务/产出/采纳率/评级/末位预警）
  { to: "/admin/agent-review", icon: ClipboardCheck, label: "员工考核" },
  // P2-4（台账 W3）：待审员工审核流水线（pending 队列 + AI 初审双阈值分流 + 留痕）
  { to: ROUTE_ADMIN_AGENT_REVIEW_QUEUE, icon: UserCheck, label: "待审员工" },
  {
    to: ROUTE_ADMIN_AGENT_TRAINING_REVIEW,
    icon: ShieldCheck,
    label: "个人 Agent 训练复核",
  },
  // 迭代 35：管理端审计日志
  { to: "/admin/audit", icon: ScrollText, label: "审计日志" },
  // 迭代 35 批次B：客服工单 / 推荐位运营 / 实时数据大屏
  { to: "/admin/tickets", icon: Ticket, label: "客服工单" },
  { to: "/admin/recommend", icon: Star, label: "推荐位运营" },
  { to: "/admin/wall", icon: MonitorPlay, label: "数据大屏" },
];

// 迭代 18：广东灵智枢生态科技有限公司 · 灵智枢智能运营（驾驶舱为该分组首页）
const NAV_OPS_ITEMS = [
  { to: "/admin/cockpit", icon: Radar, label: "总经理驾驶舱" },
  { to: "/admin/departments", icon: Network, label: "部门智能管理" },
  // M47：三部门独立管理工作台（配置驻部智能体与主官 + DSH 内嵌对话）
  { to: "/admin/dept-consoles", icon: Briefcase, label: "部门工作台" },
  // M52：共生工作空间退役——会议能力改由「临时会议」插件承载（部门工作台内）
  // iter79：Panda 组织驾驶舱（四角色席位 + 分级审批）
  { to: "/admin/panda", icon: Panda, label: "Panda 组织驾驶舱" },
  { to: "/admin/sandbox-monitor", icon: Panda, label: "沙箱训练监考" },
  // iter100 M2：组织中枢·协议评审台
  { to: ROUTE_ADMIN_PROTOCOLS, icon: ScrollText, label: "协议评审台" },
  // 迭代 19：部门账号分发体系（负责人/员工账号由分发产生，统一入口 /staff/login）
  { to: "/admin/staff-accounts", icon: KeyRound, label: "部门账号分发" },
  // 迭代 20：企业知识库 + 对外智能客服（微信公众号/服务号接入）
  { to: ROUTE_ADMIN_KNOWLEDGE, icon: BookOpen, label: "企业知识库" },
  { to: ROUTE_ADMIN_WECHAT_CS, icon: Headset, label: "对外智能客服" },
];

/** v180 舱分组（彭总定调 2026-08-30；2026-09-05 补齐十舱：运营舱/品牌舱入列，按十舱典序重排）：页面一个不动，只重排归属 */
const NAV_STATIONS: {
  id: string;
  label: string;
  color: string;
  items: { to: string; end?: boolean; icon: typeof Gauge; label: string }[];
}[] = [
  {
    id: STATION_CODE_REL,
    label: "更新舱 · 进化发布",
    color: "text-amber-300/80",
    items: NAV_ITEMS.filter((i) =>
      [
        "/admin/evo-board",
        "/admin/releases",
        "/admin/agent-review",
        "/admin/memory",
      ].includes(i.to),
    ),
  },
  {
    id: STATION_CODE_MKT,
    label: "市场舱 · 超市运营",
    color: "text-pink-300/80",
    items: NAV_ITEMS.filter((i) =>
      [
        "/admin/agents",
        ROUTE_ADMIN_AGENT_REVIEW_QUEUE,
        ROUTE_ADMIN_AGENT_TRAINING_REVIEW,
        "/admin/orders",
        "/admin/skill-shop",
        "/admin/market-review",
        "/admin/plans",
        "/admin/corps",
        "/admin/claw-tiers",
        "/admin/plugin-store",
        "/admin/devs",
      ].includes(i.to),
    ),
  },
  {
    id: STATION_CODE_FIN,
    label: "财务舱 · 账房",
    color: "text-yellow-300/80",
    items: NAV_ITEMS.filter((i) =>
      ["/admin/finance", "/admin/topups", "/admin/tokens"].includes(i.to),
    ),
  },
  {
    id: STATION_CODE_OPS,
    label: "运行舱 · 系统健康",
    color: "text-emerald-300/80",
    items: NAV_ITEMS.filter((i) =>
      [
        "/admin",
        "/admin/system",
        "/admin/alerts",
        "/admin/audit",
        "/admin/security",
        "/admin/vulns",
        "/admin/health",
        "/admin/wall",
      ].includes(i.to),
    ),
  },
  {
    id: STATION_CODE_RUNOPS,
    label: "运营舱 · 运营与经营",
    color: "text-teal-300/80",
    items: NAV_ITEMS.filter((i) =>
      ["/admin/ops", "/admin/analytics", "/admin/recommend"].includes(i.to),
    ),
  },
  {
    id: STATION_CODE_LAW,
    label: "法务舱 · 备案合规",
    color: "text-sky-300/80",
    items: NAV_OPS_ITEMS.filter((i) => [ROUTE_ADMIN_PROTOCOLS].includes(i.to)),
  },
  {
    id: STATION_CODE_BRAND,
    label: "品牌舱 · 品牌与客服",
    color: "text-rose-300/80",
    items: [
      ...NAV_ITEMS.filter((i) =>
        ["/admin/cs-center", "/admin/tickets"].includes(i.to),
      ),
      ...NAV_OPS_ITEMS.filter((i) => [ROUTE_ADMIN_WECHAT_CS].includes(i.to)),
    ],
  },
  {
    id: STATION_CODE_CH,
    label: "渠道舱 · 用户与合伙人",
    color: "text-indigo-300/80",
    items: NAV_ITEMS.filter((i) =>
      [
        "/admin/factories",
        "/admin/users",
        ROUTE_ADMIN_APPROVALS,
        "/admin/claw-whitelist",
        "/admin/recruitments",
      ].includes(i.to),
    ),
  },
  {
    id: STATION_CODE_KNOW,
    label: "文化知识舱 · 品牌人格",
    color: "text-violet-300/80",
    items: NAV_OPS_ITEMS.filter((i) => [ROUTE_ADMIN_KNOWLEDGE].includes(i.to)),
  },
];

// v180 防漏网：任何未归舱的导航项自动落「未归舱（待分）」组——分组重排绝不丢页面
const _stationed = new Set(
  NAV_STATIONS.flatMap((g) => g.items.map((i) => i.to)),
);
const NAV_LEFT = NAV_ITEMS.filter((i) => !_stationed.has(i.to));
if (NAV_LEFT.length > 0) {
  NAV_STATIONS.push({
    id: STATION_CODE_MISC,
    label: "未归舱（待分）",
    color: "text-ink-faint",
    items: NAV_LEFT,
  });
}

function renderNavLink(item: {
  to: string;
  end?: boolean;
  icon: typeof Gauge;
  label: string;
}) {
  return (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-sm transition-colors duration-300",
          isActive
            ? "bg-forge-amber/[0.12] font-medium text-forge-amber"
            : "text-ink-secondary hover:bg-pulse-cyan/[0.06] hover:text-ink-primary",
        )
      }
    >
      <item.icon className="h-4 w-4 shrink-0" />
      {item.label}
    </NavLink>
  );
}

/** 舱组展开语义终稿（R28 票②③：显式偏好绝对优先——显式 false 恒折叠（当前组 toggle 生效）、
 *  显式 true 恒展开；无显式时当前组派生展开。不再做「当前组临时覆盖」——用户折叠即用户意图） */
function resolveStationOpen(
  explicit: boolean | undefined,
  isCurrent: boolean,
): boolean {
  return explicit ?? isCurrent;
}

/** 当前路由所属舱组 id 派生（R12 票②：禁嵌套三元——if/return 早分支）：
 *  /admin/stations 队列页从 ?tab= 白名单派生（URLSearchParams 防部分匹配；无 tab 回落 x_ops 与 StationQueues 同口径）；
 *  其余路径按 end 精确/前缀匹配。 */
function resolveCurrentStationId(
  pathname: string,
  search: string,
): string | undefined {
  if (pathname === ROUTE_ADMIN_STATIONS) {
    const tab = new URLSearchParams(search).get("tab");
    if (tab && NAV_STATIONS.some((g) => g.id === tab)) return tab;
    return DEFAULT_STATION_TAB;
  }
  return NAV_STATIONS.find((g) =>
    g.items.some((i) =>
      i.end
        ? pathname === i.to
        : pathname === i.to || pathname.startsWith(i.to + "/"),
    ),
  )?.id;
}

const OPEN_KEY_PREFIX = "admin_nav_open_stations"; // R28 票④：键带账号域（不同管理员折叠偏好互不污染——DISMISS_KEY(username) 仓惯例）
function loadOpenStations(openKey: string): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(openKey) ?? "{}");
    // 票⑥：JSON.parse('null')/坏值防护——cast 掩盖的 null 会让 openStations[g.id] 整页崩
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return {};
    // 票⑤：逐值 boolean 校验——手改/坏值（如 "false" 字符串 truthy）不入状态
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export default function AdminLayout() {
  const { session, clear } = useWbSession();
  const navigate = useNavigate();
  const location = useLocation();
  const currentStationId = resolveCurrentStationId(
    location.pathname,
    location.search,
  );
  const openKey = `${OPEN_KEY_PREFIX}:${session?.username ?? "anon"}`;
  const [openStations, setOpenStations] = useState<Record<string, boolean>>(
    () => loadOpenStations(openKey),
  );
  const [navOpen, setNavOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const navTriggerRef = useRef<HTMLButtonElement>(null);
  const navCloseRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setNavOpen(false), [location.pathname, location.search]);
  useModalFocusTrap({
    open: navOpen,
    containerRef: navRef,
    initialFocusRef: navCloseRef,
    restoreFocusRef: navTriggerRef,
    onClose: () => setNavOpen(false),
    // 必须与 Tailwind lg: 抽屉显隐断点保持一致。
    closeOnMediaQuery: MODAL_DESKTOP_MEDIA_QUERY,
  });

  // R30 票①：账号切换竞态根治——loadedKey 双缓冲：openKey 变化的同一 commit 只加载不写
  // （旧偏好绝不写进新账号键），下一回合（loadedKey==openKey 且偏好已换）才持久化
  const [loadedKey, setLoadedKey] = useState(openKey);
  useEffect(() => {
    if (loadedKey !== openKey) {
      setOpenStations(loadOpenStations(openKey));
      setLoadedKey(openKey);
      return;
    }
    if (!session?.username) return; // R29 票③：无 session 不持久化（anon 键不写空 map）
    try {
      localStorage.setItem(openKey, JSON.stringify(openStations));
    } catch {
      // 隐私模式写失败——展开态仅本次会话有效，不阻断
    }
  }, [openStations, openKey, loadedKey, session?.username]);

  if (!session?.token || session.role !== "admin") {
    return <Navigate to={ADMIN_LOGIN_PATH} replace />;
  }

  function handleLogout() {
    clear();
    navigate(ADMIN_LOGIN_PATH, { replace: true });
  }

  return (
    <div className="cyber-grid-bg flex min-h-screen bg-void text-ink-primary">
      {/* 左侧导航 */}
      {navOpen && (
        <div
          role="presentation"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-[15] bg-black/60 lg:hidden"
          aria-hidden="true"
        />
      )}
      <aside
        ref={navRef}
        id="admin-nav-drawer"
        role={navOpen ? "dialog" : undefined}
        aria-modal={navOpen ? true : undefined}
        aria-label={navOpen ? "管理导航" : undefined}
        className={cn(
          "fixed inset-y-0 left-0 z-20 flex w-56 flex-col border-r border-line-subtle bg-panel/90 backdrop-blur transition-[transform,visibility] lg:translate-x-0",
          navOpen ? "translate-x-0" : "-translate-x-full max-lg:invisible",
        )}
      >
        <div className="flex items-center gap-2.5 border-b border-line-subtle px-5 py-5">
          <img
            src="/logo-mark.png"
            alt="NumX Max"
            className="h-7 w-7 shrink-0 object-contain"
          />
          <ShieldCheck className="h-5 w-5 shrink-0 text-forge-amber" />
          <div className="min-w-0">
            <p className="truncate font-display text-sm font-bold">NumX Max</p>
            <p className="hud-label mt-0.5 text-[10px] text-forge-amber/70">
              ADMIN CONSOLE
            </p>
          </div>
          <button
            ref={navCloseRef}
            type="button"
            aria-label="关闭导航"
            onClick={() => setNavOpen(false)}
            className="ml-auto inline-flex shrink-0 rounded-lg border border-line-subtle p-1.5 text-ink-secondary lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <nav
          className="flex-1 space-y-1 overflow-y-auto px-3 py-4"
          onClick={(event) => {
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            if (event.target instanceof Element && event.target.closest("a"))
              setNavOpen(false);
          }}
        >
          {/* v185 舱上之舱：总经理驾驶舱置顶（彭毅全景首屏，不占舱位） */}
          <p className="hud-label px-3 pb-1 text-[10px] text-forge-amber/90">
            舱上之舱
          </p>
          {NAV_OPS_ITEMS.filter((i) => i.to === "/admin/cockpit").map(
            renderNavLink,
          )}
          {/* v185 五舱+二：运行/更新/市场/渠道/财务/法务/文化知识 */}
          {/* 波 1·P1-2：导航三层折叠——非战略舱组默认收起（点开即展，localStorage 记展开态；
              异常/待办角标仍走既有 queue 队列机制上浮，不埋菜单也不丢信号） */}
          {NAV_STATIONS.map((g) => {
            // 两态分离（R7 票①）：persisted（用户手动，localStorage）∪ 当前路由组（路由派生不持久化——
            // 逛一遍不再把全部组写死展开，折叠偏好不被稀释）；key 用稳定 id（label 改名/本地化不失忆——票②）
            const open =
              g.id === STATION_CODE_MISC
                ? true
                : resolveStationOpen(
                    openStations[g.id],
                    currentStationId === g.id,
                  );
            return (
              <div key={g.id}>
                <div className="flex items-center justify-between pr-3">
                  {g.id === STATION_CODE_MISC ? (
                    <div
                      className={cn(
                        "hud-label flex flex-1 items-center px-3 pb-1 pt-4 text-[10px]",
                        g.color,
                      )}
                    >
                      <span>▾ {g.label}</span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-controls={`station-items-${g.id}`}
                      onClick={() =>
                        setOpenStations((prev) => ({ ...prev, [g.id]: !open }))
                      }
                      className={cn(
                        "hud-label flex flex-1 items-center px-3 pb-1 pt-4 text-[10px] text-left",
                        g.color,
                      )}
                    >
                      <span>
                        {open ? "▾" : "▸"} {g.label}
                      </span>
                    </button>
                  )}
                  {g.id !== STATION_CODE_MISC && (
                    <NavLink
                      to={stationQueueUrl(g.id)}
                      className={cn(
                        "hud-label pb-1 pt-4 text-[10px] hover:text-pulse-cyan",
                        g.color,
                      )}
                    >
                      队列 ›
                    </NavLink>
                  )}
                </div>
                {open && (
                  <div id={`station-items-${g.id}`}>
                    {g.items.map(renderNavLink)}
                  </div>
                )}
              </div>
            );
          })}
          <p className="hud-label px-3 pb-1 pt-4 text-[10px] text-forge-amber/70">
            灵智枢智能运营（迁内部版工作台）
          </p>
          {/* 2026-09-05 十舱归位：已入舱的项（法务/文化知识/品牌舱）不再重复出现 */}
          {NAV_OPS_ITEMS.filter(
            (i) =>
              ![
                ROUTE_ADMIN_PROTOCOLS,
                ROUTE_ADMIN_KNOWLEDGE,
                ROUTE_ADMIN_WECHAT_CS,
              ].includes(i.to),
          ).map(renderNavLink)}
        </nav>
        <div className="border-t border-line-subtle px-5 py-4">
          <p className="text-[11px] leading-relaxed text-ink-faint">
            变更操作提交后由系统执行，页面刷新后生效。
          </p>
        </div>
      </aside>

      {/* 主区域 */}
      <div
        className="ml-0 flex min-w-0 flex-1 flex-col lg:ml-56"
        inert={navOpen ? true : undefined}
        aria-hidden={navOpen ? true : undefined}
      >
        <header className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-line-subtle bg-void/85 px-3 py-3.5 backdrop-blur sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <button
              ref={navTriggerRef}
              type="button"
              aria-label="打开导航"
              aria-expanded={navOpen}
              aria-controls="admin-nav-drawer"
              onClick={() => setNavOpen(true)}
              className={cn(
                "inline-flex shrink-0 items-center rounded-lg border border-line-subtle p-2 text-ink-secondary lg:hidden",
              )}
            >
              <Menu className="h-4 w-4" />
            </button>
            <p className="hud-label hidden text-forge-amber/80 sm:block">
              NEBULA UNIFIED ADMIN
            </p>
          </div>
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <span className="inline-flex min-w-0 items-center gap-2 rounded-full border border-forge-amber/30 bg-forge-amber/[0.08] px-2 py-1 text-xs text-forge-amber sm:px-3">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
              <span className="max-w-28 truncate sm:max-w-48">
                {String(session.displayName ?? session.username ?? "管理员")}
              </span>
              <span className="hidden text-ink-faint sm:inline">· 管理员</span>
            </span>
            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex items-center gap-1.5 rounded-[8px] border border-line-subtle px-3 py-1.5 text-xs text-ink-secondary transition-colors duration-300 hover:border-ember-red/40 hover:text-ember-red"
            >
              <LogOut className="h-3.5 w-3.5" />
              退出
            </button>
          </div>
        </header>
        <main className="min-w-0 flex-1 px-3 py-4 sm:px-6 sm:py-6">
          <Outlet />
        </main>
      </div>

      {/* iter96：灵枢/星云语音助手（右下角悬浮，fixed 定位不影响布局） */}
      <div
        className={cn(navOpen && "max-lg:invisible max-lg:pointer-events-none")}
        aria-hidden={navOpen ? true : undefined}
        inert={navOpen ? true : undefined}
      >
        <AdminBuddy />
      </div>
      {/* M13.5 数字人具身入场层（每会话一次，sessionStorage 去重）：
          欢迎语播完后 dispatch 'admin:open-buddy'，AdminBuddy 开面板 + TTS + 持续聆听 */}
      <div
        className={cn(navOpen && "max-lg:invisible max-lg:pointer-events-none")}
        aria-hidden={navOpen ? true : undefined}
        inert={navOpen ? true : undefined}
      >
        <MechaEntrance
          storageKey="admin_mecha_entered"
          openEventName="admin:open-buddy"
          enterLabel="进入终端 · 开启语音"
        />
      </div>
    </div>
  );
}
