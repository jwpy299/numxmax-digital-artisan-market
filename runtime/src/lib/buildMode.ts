/**
 * 构建模式变体（迭代 14）：
 * - 默认（未设置）：NumX Max·数字匠市门户包，行为完全不变；
 * - VITE_NEBULA_MODE=workbench：「NumX Max 智能工作台」独立部署包（WB_ONLY），
 *   `/` 重定向 /wb/login，仅保留 /wb/* 与 /login 路由，Navbar 不渲染
 *  （WbLayout 自带导航），document.title 含「NumX Max 智能工作台」。
 */
export const WB_ONLY: boolean =
  import.meta.env.VITE_NEBULA_MODE === "workbench";

/** 系统品牌名单源（对齐 wb 仓 PR#17 并线口径：后续品牌变更只改本行。
 *  人格名（灵枢/星云）是精灵角色名非品牌面，不在本常量域） */
export const BRAND_NAME = "NumX Max";
/** 工作台部署包站点标题 */
export const WB_SITE_TITLE = `${BRAND_NAME} 智能工作台`;

/**
 * 迭代 17 Stage 3：VITE_NEBULA_MODE=admin ——「NumX Max 超级终端」独立部署包（ADMIN_ONLY）。
 * `/` 重定向 /admin/login，仅保留 /admin/* 与 /login 路由，不渲染门户 Navbar。
 */
export const ADMIN_ONLY: boolean = import.meta.env.VITE_NEBULA_MODE === "admin";

/** 超级终端部署包站点标题 */
export const ADMIN_SITE_TITLE = `${BRAND_NAME} 超级终端`;

/** admin 独立部署包的登录入口；门户统一使用 src/const.ts 的 LOGIN_PATH。 */
export const ADMIN_LOGIN_PATH = "/admin/login";
