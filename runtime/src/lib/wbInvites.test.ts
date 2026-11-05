/**
 * M16b 组织邀请·前端纯逻辑层测试：
 * - normalizeRole/orgRoleOf：orgRole 显隐判断的角色归一（与后端 normalizeRole 同口径）；
 * - parseInviteCode：邀请链接解析（缺失/格式错一律 null）；
 * - inviteInvalidMessage：peek 无效统一文案映射（不泄露原因）；
 * - canManageInvites/canViewInvites/navItemVisible：orgRole 显隐判断；
 * - formatInviteRemaining/inviteStatusLabel：邀请列表展示辅助。
 */
import { describe, expect, it } from 'vitest'
import {
  INVITE_INVALID_TEXT,
  buildInviteUrl,
  canManageInvites,
  canViewInvites,
  formatInviteRemaining,
  inviteInvalidMessage,
  inviteRoleLabel,
  inviteStatusLabel,
  navItemVisible,
  normalizeRole,
  routeAllowed,
  orgRoleOf,
  parseInviteCode,
} from './wbInvites'
import type { WbSession } from './wbSession'

const VALID_CODE = `iv_${'a1'.repeat(24)}`

describe('normalizeRole（与 api/routers/wbSession.ts 同口径）', () => {
  it('owner→admin（存量老板归一）', () => {
    expect(normalizeRole('owner')).toBe('admin')
  })
  it('admin→admin', () => {
    expect(normalizeRole('admin')).toBe('admin')
  })
  it('manager/staff 直通', () => {
    expect(normalizeRole('manager')).toBe('manager')
    expect(normalizeRole('staff')).toBe('staff')
  })
  it('member→staff（存量员工归一）', () => {
    expect(normalizeRole('member')).toBe('staff')
  })
  it('null/undefined/未知值一律 staff 兜底', () => {
    expect(normalizeRole(null)).toBe('staff')
    expect(normalizeRole(undefined)).toBe('staff')
    expect(normalizeRole('superuser')).toBe('staff')
    expect(normalizeRole('')).toBe('staff')
  })
})

describe('orgRoleOf（优先 orgRole 字段，回退 role 归一）', () => {
  it('会话带 orgRole 时优先使用', () => {
    const s = { token: 'nt_x', role: 'member', orgRole: 'manager' } as unknown as WbSession
    expect(orgRoleOf(s)).toBe('manager')
  })
  it('无 orgRole 时回退 role 字段归一', () => {
    expect(orgRoleOf({ token: 'nt_x', role: 'owner' })).toBe('admin')
    expect(orgRoleOf({ token: 'nt_x', role: 'member' })).toBe('staff')
  })
  it('无会话/无角色 → staff', () => {
    expect(orgRoleOf(null)).toBe('staff')
    expect(orgRoleOf(undefined)).toBe('staff')
    expect(orgRoleOf({ token: 'nt_x' })).toBe('staff')
  })
})

describe('parseInviteCode（邀请链接解析）', () => {
  it('标准链接解析出明文码', () => {
    expect(parseInviteCode(`?code=${VALID_CODE}`)).toBe(VALID_CODE)
  })
  it('多参数混合仍能取到 code', () => {
    expect(parseInviteCode(`?from=share&code=${VALID_CODE}&t=1`)).toBe(VALID_CODE)
  })
  it('缺 code 参数 → null', () => {
    expect(parseInviteCode('')).toBeNull()
    expect(parseInviteCode('?foo=bar')).toBeNull()
  })
  it('格式不符（前缀/长度/字符）→ null（按统一失效文案处理）', () => {
    expect(parseInviteCode('?code=st_a1b2')).toBeNull()
    expect(parseInviteCode(`?code=iv_${'a1'.repeat(23)}`)).toBeNull() // 46 hex 太短
    expect(parseInviteCode(`?code=iv_${'a1'.repeat(24)}00`)).toBeNull() // 50 hex 太长
    expect(parseInviteCode(`?code=iv_${'A1'.repeat(24)}`)).toBeNull() // 大写不符
    expect(parseInviteCode(`?code=iv_${'zz'.repeat(24)}`)).toBeNull() // 非 hex
  })
  it('buildInviteUrl 拼出的链接可被 parseInviteCode 还原', () => {
    expect(parseInviteCode(new URL(buildInviteUrl(VALID_CODE), 'https://x.test').search)).toBe(VALID_CODE)
    expect(buildInviteUrl(VALID_CODE)).toBe(`/wb/invite?code=${VALID_CODE}`)
  })
})

describe('peek 无效统一文案映射', () => {
  it('无论何种原因统一返回同一文案（不泄露过期/已用/吊销细节）', () => {
    expect(inviteInvalidMessage()).toBe(INVITE_INVALID_TEXT)
    expect(inviteInvalidMessage()).toBe('邀请链接无效或已使用')
  })
})

describe('orgRole 显隐判断', () => {
  it('邀请表单与吊销：仅 admin', () => {
    expect(canManageInvites('admin')).toBe(true)
    expect(canManageInvites('manager')).toBe(false)
    expect(canManageInvites('staff')).toBe(false)
  })
  it('邀请列表：admin/manager 可见，staff 不可见', () => {
    expect(canViewInvites('admin')).toBe(true)
    expect(canViewInvites('manager')).toBe(true)
    expect(canViewInvites('staff')).toBe(false)
  })
  it('菜单项：roles 未声明全角色可见', () => {
    expect(navItemVisible(undefined, 'staff')).toBe(true)
    expect(navItemVisible([], 'staff')).toBe(true)
  })
  it('菜单项：org 页 admin/manager 可见、staff 隐藏', () => {
    const orgRoles: Array<'admin' | 'manager'> = ['admin', 'manager']
    expect(navItemVisible(orgRoles, 'admin')).toBe(true)
    expect(navItemVisible(orgRoles, 'manager')).toBe(true)
    expect(navItemVisible(orgRoles, 'staff')).toBe(false)
  })
  it('菜单项：admin-only 项 manager/staff 均隐藏', () => {
    expect(navItemVisible(['admin'], 'manager')).toBe(false)
    expect(navItemVisible(['admin'], 'staff')).toBe(false)
  })
  it('routeAllowed：org 路由 staff 拦截、admin/manager 放行', () => {
    const orgRoles: Array<'admin' | 'manager'> = ['admin', 'manager']
    expect(routeAllowed('staff', orgRoles)).toBe(false)
    expect(routeAllowed('admin', orgRoles)).toBe(true)
    expect(routeAllowed('manager', orgRoles)).toBe(true)
  })
  it('routeAllowed：roles 未声明/空数组一律放行', () => {
    expect(routeAllowed('staff', undefined)).toBe(true)
    expect(routeAllowed('staff', [])).toBe(true)
  })
})

describe('邀请列表展示辅助', () => {
  it('inviteStatusLabel 覆盖四态，未知值原样透出', () => {
    expect(inviteStatusLabel('pending')).toBe('待使用')
    expect(inviteStatusLabel('consumed')).toBe('已使用')
    expect(inviteStatusLabel('revoked')).toBe('已吊销')
    expect(inviteStatusLabel('expired')).toBe('已过期')
    expect(inviteStatusLabel('weird')).toBe('weird')
  })
  it('inviteRoleLabel 角色文案', () => {
    expect(inviteRoleLabel('manager')).toBe('部门负责人')
    expect(inviteRoleLabel('staff')).toBe('员工')
  })
  it('formatInviteRemaining：剩余有效期分级', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    expect(formatInviteRemaining('2026-01-04T00:00:00Z', now)).toBe('剩余 3 天')
    expect(formatInviteRemaining('2026-01-01T05:00:00Z', now)).toBe('剩余 5 小时')
    expect(formatInviteRemaining('2026-01-01T00:30:00Z', now)).toBe('剩余 30 分钟')
  })
  it('formatInviteRemaining：过期/非法输入', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    expect(formatInviteRemaining('2025-12-31T23:00:00Z', now)).toBe('已过期')
    expect(formatInviteRemaining('not-a-date', now)).toBe('—')
  })
})
