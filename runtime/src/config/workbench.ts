/**
 * 星云智能工作台跳转配置
 *
 * 「星云智能工作台」是独立的执行端产品，市场只负责雇佣与供给。
 * 两段式 SSO 已按官方 API 文档打通：
 * 市场持 token 调 nebulaLink.createWorkbenchTicket 签发一次性 ticket（st_ 前缀，TTL 300s），
 * 再整页跳转 entryUrl（形如 /bridge?ticket=...），由工作台 consumeWorkbenchTicket 原子核销。
 *
 * 前端无法读取 process.env，这里通过 Vite 的 import.meta.env 注入：
 * 部署时在构建环境配置 VITE_WORKBENCH_WEB_URL 为工作台站点地址；
 * 默认指向工作台独立部署站点（迭代 17：工作台独立部署于服务器2，
 * 与市场门户共享同一数据库，SSO ticket 跨站核销）；
 * 设为空字符串 '' 时回退同源模式（本地开发）。
 */
export const NEBULA_WORKBENCH_URL: string =
  (import.meta.env.VITE_WORKBENCH_WEB_URL as string | undefined) ??
  'https://wb.example.invalid' // :3000 死端口摘（NumX 抓：公网 TCP 拒——兜底指 443 活面）

/** localStorage 会话键：沿用工作台官方文档约定，登录/注册后保存含 token 的会话对象 */
export const NEBULA_AUTH_STORAGE_KEY = 'nebula_auth'

/** 工作台落地页白名单（与官方文档 bridgeStatus.supportedTargets 一致，作为自检失败时的静态兜底） */
export const WORKBENCH_TARGETS = [
  '/dept',
  '/dashboard',
  '/market',
  '/showroom',
  '/skillmall',
  '/org',
] as const

export type WorkbenchTarget = (typeof WORKBENCH_TARGETS)[number]

/** 落地页中文标签（仅展示用） */
export const WORKBENCH_TARGET_LABELS: Record<string, string> = {
  '/dept': '组织部门',
  '/dashboard': '数据看板',
  '/market': '工作台市场',
  '/showroom': '企业展厅',
  '/skillmall': '技能商城',
  '/org': '组织管理',
}

/**
 * 将工作台返回的 entryUrl 解析为可整页跳转的地址。
 * - 已是绝对 URL：原样使用；
 * - 配置了外部工作台地址（NEBULA_WORKBENCH_URL 非空）：所有 /wb/ 及相对路径
 *   一律拼到外部工作台站点（迭代 17 跨站 SSO）；
 * - NEBULA_WORKBENCH_URL 为空（本地开发回退）：同源承载工作台 SPA。
 */
/** wb 登录页个人注册 tab 路径（单源——WbLogin 的 tab 参数集契约面[OCR portal#62 票：跳链字面量入 config 保 greppable]；wb 域=wb 仓 3460 新版面认 person[公网 bundle 实证]） */
export const WB_LOGIN_PERSON_PATH = '/wb/login?tab=person'

export function resolveWorkbenchUrl(entryUrl: string): string {
  if (/^https?:\/\//i.test(entryUrl)) return entryUrl
  const base = NEBULA_WORKBENCH_URL.replace(/\/+$/, '')
  const path = entryUrl.startsWith('/') ? entryUrl : `/${entryUrl}`
  if (!base) return path
  return `${base}${path}`
}
