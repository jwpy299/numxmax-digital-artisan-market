/**
 * wbInvites —— M16b 组织邀请·前端纯逻辑层。
 *
 * 与 api/routers/wbInvites.ts（M16a 后端）契约对齐：
 * - 邀请码明文 iv_+48hex 只出现在落地页 URL query 与请求体，绝不写 localStorage/日志/埋点；
 * - peek 无效（不存在/过期/已用/吊销）后端统一 valid:false，前端统一一套失效文案，不泄露原因；
 * - 已登录接口 token 一律在请求体（useWbQuery/wbMutation 现有封装注入），本模块不碰 token。
 */
import type { WbSession } from './wbSession'

// ─── 角色归一（与 api/routers/wbSession.ts normalizeRole 同口径）─────────────

export type WbRole = 'admin' | 'manager' | 'staff'

/** owner→admin、manager 直通、member/null/未知历史值一律 staff 兜底 */
export function normalizeRole(role: string | null | undefined): WbRole {
  if (role === 'admin' || role === 'owner') return 'admin'
  if (role === 'manager') return 'manager'
  return 'staff'
}

/**
 * 从工作台会话读取归一组织角色：
 * M16a 起 sessionInfo/authMe 输出 orgRole 字段（优先）；旧会话回退 role 字段再归一。
 */
export function orgRoleOf(session: WbSession | null | undefined): WbRole {
  const raw = typeof session?.orgRole === 'string' ? session.orgRole : session?.role
  return normalizeRole(raw)
}

// ─── 显隐判断（体验层；真权限在服务端守卫）──────────────────────────────────

/** 邀请表单与吊销按钮：仅 admin（企业负责人） */
export function canManageInvites(role: WbRole): boolean {
  return role === 'admin'
}

/** 邀请列表（admin 全量 / manager 本部门，服务端已强制收敛） */
export function canViewInvites(role: WbRole): boolean {
  return role === 'admin' || role === 'manager'
}

/** 菜单项显隐：roles 未声明则全角色可见；否则按归一角色过滤 */
export function navItemVisible(roles: WbRole[] | undefined, role: WbRole): boolean {
  if (!roles || roles.length === 0) return true
  return roles.includes(role)
}

/** 路由放行判定（RequireRole 用）：roles 未声明/空 → 放行；否则按归一角色匹配。显隐之外的前端拦截层 */
export function routeAllowed(role: WbRole, roles: WbRole[] | undefined): boolean {
  if (!roles || roles.length === 0) return true
  return roles.includes(role)
}

// ─── 邀请链接解析 ───────────────────────────────────────────────────────────

/** 邀请码格式：iv_ + 48 hex（与后端 zod 校验一致） */
export const INVITE_CODE_RE = /^iv_[0-9a-f]{48}$/

/**
 * 从 URL query（location.search）解析邀请码。
 * 缺失或格式不符一律返回 null（落地页按统一失效文案处理，不区分原因）。
 */
export function parseInviteCode(search: string): string | null {
  try {
    const code = new URLSearchParams(search).get('code')
    if (!code || !INVITE_CODE_RE.test(code)) return null
    return code
  } catch {
    return null
  }
}

/** 拼一次性邀请落地页链接（明文码仅出现在此 URL 与 create 响应中） */
export function buildInviteUrl(code: string): string {
  return `/wb/invite?code=${code}`
}

// ─── peek 失效统一文案 ──────────────────────────────────────────────────────

/** 无效/过期/已用/吊销统一文案（不泄露具体原因，与后端 INVITE_INVALID 同口径） */
export const INVITE_INVALID_TEXT = '邀请链接无效或已使用'
export const INVITE_INVALID_HINT = '请联系企业管理员重新邀请'

/** peek 返回 valid:false 时的全屏失效文案（无论何种原因统一映射，不泄露细节） */
export function inviteInvalidMessage(): string {
  return INVITE_INVALID_TEXT
}

// ─── 邀请列表辅助 ───────────────────────────────────────────────────────────

export type WbInviteStatus = 'pending' | 'consumed' | 'revoked' | 'expired'

export const INVITE_STATUS_LABEL: Record<WbInviteStatus, string> = {
  pending: '待使用',
  consumed: '已使用',
  revoked: '已吊销',
  expired: '已过期',
}

export function inviteStatusLabel(status: string): string {
  return INVITE_STATUS_LABEL[status as WbInviteStatus] ?? status
}

/** 剩余有效期文案（仅 pending 展示；已过 1 天按天、否则按小时，不足 1 小时按分钟） */
export function formatInviteRemaining(expiresAt: string | Date, now: Date = new Date()): string {
  const ms = new Date(expiresAt).getTime() - now.getTime()
  if (Number.isNaN(ms)) return '—'
  if (ms <= 0) return '已过期'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `剩余 ${Math.max(minutes, 1)} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `剩余 ${hours} 小时`
  return `剩余 ${Math.floor(hours / 24)} 天`
}

export const INVITE_ROLE_LABEL: Record<'manager' | 'staff', string> = {
  manager: '部门负责人',
  staff: '员工',
}

export function inviteRoleLabel(role: string): string {
  return INVITE_ROLE_LABEL[role as 'manager' | 'staff'] ?? role
}

// ─── 服务端响应类型（仅声明前端用到的形状）──────────────────────────────────

/** wbInvites.create 输出（code 明文仅此一次，绝不入库/落盘） */
export interface WbInviteCreateResult {
  inviteId: number
  code: string
  inviteUrl: string
  displayName: string
  deptId: string
  deptName: string
  role: 'manager' | 'staff'
  expiresAt: string | Date
}

/** wbInvites.list 行（绝不含 code/codeHash） */
export interface WbInviteRow {
  inviteId: number
  displayName: string
  deptId: string
  deptName: string | null
  role: 'manager' | 'staff'
  status: WbInviteStatus
  expiresAt: string | Date
  createdAt: string | Date
  inviterName: string | null
}

/** wbInvites.peek 输出 */
export type WbInvitePeek =
  | { valid: false }
  | {
      valid: true
      enterpriseName: string
      displayName: string
      deptName: string | null
      role: 'manager' | 'staff'
      expiresAt: string | Date
    }

/** wbInvites.accept 输出（SessionInfo + orgRole/deptName，可直接 saveWbSession） */
export interface WbInviteAcceptResult extends WbSession {
  orgRole?: string
  deptName?: string | null
}
