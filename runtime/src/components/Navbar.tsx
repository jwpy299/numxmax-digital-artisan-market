import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { AnimatePresence, motion } from "framer-motion";
import { LogOut, Menu, Search, UserRound, X } from "lucide-react";
import { cn } from "@/lib/utils";
import GlowButton from "@/components/GlowButton";
import { useWbSession, clearWbSession } from "@/lib/wbSession";
import { WB_ONLY } from "@/lib/buildMode";
import { ROUTE_AGENT_EMPLOYMENT } from "@/lib/portalRoutes";
import { DESKTOP_NAV_MEDIA_QUERY } from "@/lib/breakpoints";
import { WIDE_CONTAINER_CLASS } from "@/lib/layout";
import { useModalFocusTrap } from "@/lib/useModalFocusTrap";

const NAV_LINKS = [
  { to: "/", label: "首页" },
  { to: "/market", label: "数字匠市" },
  { to: "/developers", label: "开发者" },
  { to: "/leaderboard", label: "排行榜" },
  { to: "/enterprise", label: "企业中心" },
  { to: ROUTE_AGENT_EMPLOYMENT, label: "Agent 就业" },
  { to: "/get-desktop", label: "下载注册中心" }, // 彭总 2026-10-20 令：下载+注册聚合中心入导航（首页下载/网页版钮摘除——动线收口中心页）
  { to: "/masters", label: "老师傅" },
  // 「智能工作台」导航项已摘（彭总 2026-10-15 令：工作台入口归首页「报名→下载→进入」动线，不占导航——中转页 /workbench 直链可达）
  { to: "/lifecycle", label: "生命周期" },
  { to: "/pricing", label: "定价模式" },
  { to: "/packages", label: "套餐矩阵" },
  { to: "/shop", label: "技能商店" },
  { to: "/architecture", label: "技术架构" },
  { to: "/roadmap", label: "运营路线" },
];

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // 账号态：读取 localStorage("nebula_auth")（WorkbenchSession 约定）
  const { session } = useWbSession();
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const searchRestoreRef = useRef<HTMLButtonElement | null>(null);
  const closeSearchRef = useRef<() => void>(() => undefined);
  useModalFocusTrap({
    open,
    containerRef: drawerRef,
    initialFocusRef: drawerCloseRef,
    restoreFocusRef: menuButtonRef,
    onClose: () => setOpen(false),
    closeOnMediaQuery: DESKTOP_NAV_MEDIA_QUERY,
  });

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 60);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const media = window.matchMedia(DESKTOP_NAV_MEDIA_QUERY);
    const closeAtDesktop = () => {
      if (media.matches) setSearchOpen(false);
    };
    closeAtDesktop();
    media.addEventListener("change", closeAtDesktop);
    return () => media.removeEventListener("change", closeAtDesktop);
  }, []);

  useEffect(() => {
    setOpen(false);
    setSearchOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeSearchRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [searchOpen]);


  function closeSearch() {
    setSearchOpen(false);
    searchRestoreRef.current?.focus();
  }

  useEffect(() => {
    closeSearchRef.current = closeSearch;
  }, [closeSearch]);

  function openSearch() {
    searchRestoreRef.current = window.matchMedia(DESKTOP_NAV_MEDIA_QUERY)
      .matches
      ? searchToggleRef.current
      : menuButtonRef.current;
    setSearchOpen(true);
  }

  // 工作台独立部署包：Navbar 不渲染（WbLayout 自带导航）
  if (WB_ONLY) return null;

  /** 退出：清除 localStorage(nebula_auth) 并回首页 */
  function handleLogout() {
    clearWbSession();
    setOpen(false);
    navigate("/");
  }

  const accountLabel =
    session?.enterpriseName ||
    session?.displayName ||
    session?.username ||
    "我的账号";

  return (
    <>
      <header
        className={cn(
          "sticky top-0 z-50 w-full transition-all duration-300",
          scrolled
            ? "border-b border-line-subtle bg-void/85 backdrop-blur-md"
            : "bg-transparent",
        )}
      >
        <div
          className={cn(
            "mx-auto flex h-16 max-w-site items-center justify-between px-5 md:px-12",
            WIDE_CONTAINER_CLASS,
          )}
        >
          {/* brand */}
          <Link to="/" className="flex shrink-0 items-center gap-3">
            <img
              src="/logo-mark.png"
              alt="NumX Max"
              className="h-8 w-8 object-contain"
            />
            <span className="leading-tight">
              <span className="block font-display text-lg font-bold tracking-wide text-ink-primary">
                NumX Max·数字匠市
              </span>
              <span className="block font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">
                NumX Max Artisan Market
              </span>
            </span>
          </Link>

          {/* desktop nav */}
          <nav className="hidden items-center gap-2 2xl:flex">
            {NAV_LINKS.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.to === "/"}
                className={({ isActive }) =>
                  cn(
                    "group relative whitespace-nowrap py-1 text-xs transition-all duration-300 hover:-translate-y-0.5 hover:text-pulse-cyan",
                    isActive ? "text-ink-primary" : "text-ink-secondary",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {l.label}
                    <span
                      className={cn(
                        "absolute -bottom-0.5 left-0 h-[2px] w-full bg-brand-gradient transition-transform duration-300",
                        isActive
                          ? "scale-x-100"
                          : "scale-x-0 group-hover:scale-x-100",
                      )}
                      style={{ transformOrigin: "left" }}
                    />
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          {/* right actions */}
          <div className="hidden shrink-0 items-center gap-3 2xl:flex">
            <button
              aria-label="搜索"
              ref={searchToggleRef}
              aria-expanded={searchOpen}
              aria-controls="portal-search-panel"
              onClick={() => {
                if (searchOpen) closeSearch();
                else openSearch();
              }}
              className="rounded-full p-2 text-ink-secondary transition-colors hover:text-pulse-cyan"
            >
              <Search className="h-4.5 w-4.5" />
            </button>
            <GlowButton
              to="/market"
              variant="primary"
              className="px-4 py-2 text-xs"
            >
              开始雇佣
            </GlowButton>
            {/* AUTH-SLOT: 登录/注册 或 账号 chip（localStorage nebula_auth） */}
            {
              session ? (
                <span className="flex items-center gap-2">
                  <Link
                    to="/my"
                    className="flex h-8 max-w-[200px] items-center gap-1.5 truncate rounded-full border border-line-subtle bg-panel px-3 text-xs font-medium text-pulse-cyan transition-colors hover:border-pulse-cyan/40 hover:bg-panel/80"
                    title={accountLabel + " · 买家中心"}
                  >
                    <UserRound className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{accountLabel}</span>
                  </Link>
                  <button
                    aria-label="退出登录"
                    onClick={handleLogout}
                    className="rounded-full p-2 text-ink-faint transition-colors hover:text-ember-red"
                    title="退出登录"
                  >
                    <LogOut className="h-4 w-4" />
                  </button>
                </span>
              ) : null /* 「登录/注册」导航钮已摘（彭总 2026-10-15 令：注册登录链路归首页动线[网页版→账号卡/桌面端→壳内]）；账号 chip 保留 */
            }
          </div>

          {/* mobile hamburger */}
          <button
            aria-label="菜单"
            aria-expanded={open}
            aria-controls="portal-mobile-drawer"
            ref={menuButtonRef}
            className="rounded-md p-2 text-ink-primary 2xl:hidden"
            onClick={() => {
              setSearchOpen(false);
              setOpen(true);
            }}
          >
            <Menu className="h-6 w-6" />
          </button>
        </div>

        {/* full-width search overlay */}
        <AnimatePresence>
          {searchOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3 }}
              id="portal-search-panel"
              className="overflow-hidden border-b border-line-subtle bg-void/95 backdrop-blur-md"
            >
              <div
                className={cn(
                  "mx-auto flex max-w-site items-center gap-3 px-5 py-4 md:px-12",
                  WIDE_CONTAINER_CLASS,
                )}
              >
                <Search className="h-4 w-4 text-pulse-cyan" />
                <input
                  ref={searchInputRef}
                  placeholder="搜索数字工匠、技能或行业…"
                  className="w-full bg-transparent text-sm text-ink-primary outline-none placeholder:text-ink-faint"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      closeSearch();
                      navigate("/market");
                    }
                  }}
                />
                <button
                  aria-label="关闭搜索"
                  onClick={closeSearch}
                  className="text-ink-faint hover:text-ink-primary"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      {/* mobile drawer */}
      <AnimatePresence>
        {open && (
          <motion.div
            id="portal-mobile-drawer"
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="站点导航"
            data-lenis-prevent
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] overflow-y-auto overscroll-contain bg-void/95 backdrop-blur-lg 2xl:hidden"
          >
            <div className="flex h-16 items-center justify-between px-5">
              <span className="flex items-center gap-3">
                <img
                  src="/logo-mark.png"
                  alt="NumX Max"
                  className="h-8 w-8 object-contain"
                />
                <span className="font-display text-lg font-bold">
                  NumX Max·数字匠市
                </span>
              </span>
              <button
                ref={drawerCloseRef}
                aria-label="关闭菜单"
                onClick={() => setOpen(false)}
                className="p-2 text-ink-primary"
              >
                <X className="h-6 w-6" />
              </button>
            </div>
            <nav className="mt-8 flex flex-col gap-2 px-8">
              {NAV_LINKS.map((l, i) => (
                <motion.div
                  key={l.to}
                  initial={{ opacity: 0, x: -24 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{
                    delay: 0.06 * i,
                    duration: 0.4,
                    ease: [0.16, 1, 0.3, 1],
                  }}
                >
                  <NavLink
                    to={l.to}
                    end={l.to === "/"}
                    onClick={() => setOpen(false)}
                    className={({ isActive }) =>
                      cn(
                        "block py-3 font-display text-2xl font-bold",
                        isActive ? "text-brand-gradient" : "text-ink-secondary",
                      )
                    }
                  >
                    {l.label}
                  </NavLink>
                </motion.div>
              ))}
              <motion.div
                initial={{ opacity: 0, x: -24 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.06 * NAV_LINKS.length, duration: 0.4 }}
                className="mt-6 flex flex-col gap-3"
              >
                <button
                  onClick={() => {
                    setOpen(false);
                    openSearch();
                  }}
                  className="flex items-center gap-2 rounded-full border border-line-subtle px-4 py-2 text-sm text-ink-secondary"
                >
                  <Search className="h-4 w-4" />
                  搜索数字工匠
                </button>
                {session ? (
                  <Link
                    to="/my"
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-2 rounded-full border border-line-subtle px-4 py-2 text-sm text-pulse-cyan"
                  >
                    <UserRound className="h-4 w-4" />
                    {accountLabel} · 买家中心
                  </Link>
                ) : null}
                <GlowButton to="/market" variant="primary" className="w-full">
                  开始雇佣
                </GlowButton>
                {session ? (
                  <button
                    onClick={handleLogout}
                    className="flex w-full items-center justify-center gap-2 rounded-full border border-line-subtle px-4 py-2 text-sm text-ink-secondary transition-colors hover:border-ember-red/40 hover:text-ember-red"
                  >
                    <LogOut className="h-4 w-4" />
                    退出（{accountLabel}）
                  </button>
                ) : null}
                {/* 移动端「登录/注册」钮同摘（同桌面面——彭总 2026-10-15 令注册登录归首页动线） */}
              </motion.div>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
