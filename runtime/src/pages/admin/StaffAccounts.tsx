/**
 * StaffAccounts（/admin/staff-accounts）—— 灵智枢智能运营 · 部门账号分发（管理员侧）。
 *
 * 分区一「分发负责人」：选部门 + 账号名 + 初始密码 + 姓名 → staff.createHead；
 * 分区二「全量账号表」：staff.listAll（部门/角色/状态/创建时间）+ 操作（重置密码弹窗、停用/启用）。
 * 文案口径：「分发账号」「初始密码请线下告知，首次登录后建议修改」。
 * 数据：staff.createHead / staff.listAll / staff.resetPassword / staff.setDisabled（token 仅在请求体）。
 */
import { useState } from 'react'
import { KeyRound, UserPlus } from 'lucide-react'
import { useWbSession, useWbQuery, wbMutation, wbErrorMessage } from '@/lib/wbSession'
import {
  WbButton,
  WbEmpty,
  WbError,
  WbLoading,
  WbNotice,
  WbPageHeader,
  WbPanel,
  wbInputCls,
  wbLabelCls,
} from '@/components/wb/ui'
import { AdminTable, adminTdCls, adminConfirm, fmtTime } from './shared'
import { cn } from '@/lib/utils'

interface DeptItem {
  id: number
  code: string
  name: string
  duty: string
}

interface AccountItem {
  id: number
  username: string
  displayName: string
  deptKey: string
  deptName: string
  role: string
  disabled: boolean
  createdBy: string
  createdAt: unknown
}

const ROLE_LABEL: Record<string, string> = { head: '负责人', staff: '员工' }

/** 部门静态兜底（与 db/sync-terminal.mts 种子一致），departments 查询失败时仍可分发 */
const FALLBACK_DEPTS: DeptItem[] = [
  { id: 1, code: 'gm', name: '总经理室', duty: '' },
  { id: 2, code: 'ops', name: '运营部', duty: '' },
  { id: 3, code: 'tech', name: '技术部', duty: '' },
  { id: 4, code: 'legal', name: '法务部', duty: '' },
  { id: 5, code: 'finance', name: '财务部', duty: '' },
]

export default function AdminStaffAccounts() {
  const { session } = useWbSession()
  const deptsQuery = useWbQuery<{ items: DeptItem[] }>('terminal.departments', session)
  const accountsQuery = useWbQuery<{ items: AccountItem[] }>('staff.listAll', session)

  const [form, setForm] = useState({ deptKey: 'ops', username: '', displayName: '', password: '' })
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [resetTarget, setResetTarget] = useState<AccountItem | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [resetError, setResetError] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)

  const depts = deptsQuery.data?.items?.length ? deptsQuery.data.items : FALLBACK_DEPTS

  async function handleCreate() {
    if (!session?.token) return
    setCreateError(null)
    setNotice(null)
    setCreating(true)
    try {
      await wbMutation('staff.createHead', {
        token: session.token,
        deptKey: form.deptKey,
        username: form.username.trim(),
        password: form.password,
        displayName: form.displayName.trim(),
      })
      const deptName = depts.find((d) => d.code === form.deptKey)?.name ?? form.deptKey
      setNotice(
        `已为${deptName}分发负责人账号「${form.username.trim()}」。初始密码请线下告知，首次登录后建议修改。`,
      )
      setForm({ ...form, username: '', displayName: '', password: '' })
      accountsQuery.refetch()
    } catch (err) {
      setCreateError(wbErrorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  async function handleReset() {
    if (!session?.token || !resetTarget) return
    setResetError(null)
    setResetting(true)
    try {
      await wbMutation('staff.resetPassword', {
        token: session.token,
        accountId: resetTarget.id,
        newPassword: resetPassword,
      })
      setNotice(`已重置「${resetTarget.displayName}」的密码。新密码请线下告知，首次登录后建议修改。`)
      setResetTarget(null)
      setResetPassword('')
    } catch (err) {
      setResetError(wbErrorMessage(err))
    } finally {
      setResetting(false)
    }
  }

  async function handleToggleDisabled(a: AccountItem) {
    if (!session?.token) return
    const action = a.disabled ? '启用' : '停用'
    if (!adminConfirm(`${action}账号「${a.displayName}（${a.username}）」`)) return
    setNotice(null)
    try {
      await wbMutation('staff.setDisabled', {
        token: session.token,
        accountId: a.id,
        disabled: !a.disabled,
      })
      setNotice(`已${action}账号「${a.displayName}」。`)
      accountsQuery.refetch()
    } catch (err) {
      window.alert(wbErrorMessage(err))
    }
  }

  return (
    <div>
      <WbPageHeader
        hud="LINGZHISHU OPS · STAFF ACCOUNTS"
        title="部门账号分发"
        desc="为五大部门分发负责人账号；负责人登录部门工作台后可自行分发员工账号。初始密码请线下告知，首次登录后建议修改。"
      />

      {/* 分区一：分发负责人 */}
      <WbPanel title="分发负责人账号" hud="CREATE HEAD ACCOUNT">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_1fr_1fr_auto]">
          <div>
            <label className={wbLabelCls}>部门</label>
            <select
              className={wbInputCls}
              value={form.deptKey}
              onChange={(e) => setForm({ ...form, deptKey: e.target.value })}
            >
              {depts.map((d) => (
                <option key={d.code} value={d.code}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={wbLabelCls}>账号名</label>
            <input
              className={wbInputCls}
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="手机号 / 账号名"
              maxLength={64}
            />
          </div>
          <div>
            <label className={wbLabelCls}>姓名</label>
            <input
              className={wbInputCls}
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              placeholder="负责人姓名"
              maxLength={64}
            />
          </div>
          <div>
            <label className={wbLabelCls}>初始密码</label>
            <input
              className={wbInputCls}
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="至少 6 位"
              maxLength={64}
              autoComplete="new-password"
            />
          </div>
          <div className="flex items-end">
            <WbButton
              onClick={() => void handleCreate()}
              loading={creating}
              disabled={!form.username.trim() || !form.displayName.trim() || form.password.length < 6}
            >
              <UserPlus className="h-4 w-4" />
              分发账号
            </WbButton>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-ink-faint">
          同一用户名全公司唯一；分发后负责人由 /staff/login 统一入口登录部门工作台。
        </p>
        <WbError message={createError} className="mt-3" />
        <WbNotice message={notice} className="mt-3" />
      </WbPanel>

      {/* 分区二：全量账号表 */}
      <WbPanel title="全量部门账号" hud="ALL STAFF ACCOUNTS" className="mt-6">
        {accountsQuery.loading && <WbLoading />}
        <WbError message={accountsQuery.error} />
        {accountsQuery.data && accountsQuery.data.items.length === 0 && (
          <WbEmpty text="尚未分发任何部门账号" hint="使用上方表单为部门分发负责人账号。" />
        )}
        {accountsQuery.data && accountsQuery.data.items.length > 0 && (
          <AdminTable head={['账号', '姓名', '部门', '角色', '状态', '创建人', '创建时间', '操作']}>
            {accountsQuery.data.items.map((a) => (
              <tr key={a.id}>
                <td className={adminTdCls + ' text-ink-primary'}>{a.username}</td>
                <td className={adminTdCls}>{a.displayName}</td>
                <td className={adminTdCls}>{a.deptName}</td>
                <td className={adminTdCls}>{ROLE_LABEL[a.role] ?? a.role}</td>
                <td className={adminTdCls}>
                  <span
                    className={cn(
                      'inline-flex rounded-full border px-2 py-0.5 text-[11px]',
                      a.disabled
                        ? 'border-ember-red/40 bg-ember-red/10 text-ember-red'
                        : 'border-pulse-cyan/40 bg-pulse-cyan/10 text-pulse-cyan',
                    )}
                  >
                    {a.disabled ? '已停用' : '正常'}
                  </span>
                </td>
                <td className={adminTdCls}>{a.createdBy === 'admin' ? '管理员' : `负责人#${a.createdBy}`}</td>
                <td className={adminTdCls}>{fmtTime(a.createdAt)}</td>
                <td className={adminTdCls}>
                  <div className="flex gap-2">
                    <WbButton variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => setResetTarget(a)}>
                      <KeyRound className="h-3.5 w-3.5" />
                      重置密码
                    </WbButton>
                    <WbButton
                      variant={a.disabled ? 'secondary' : 'danger'}
                      className="px-2.5 py-1 text-xs"
                      onClick={() => void handleToggleDisabled(a)}
                    >
                      {a.disabled ? '启用' : '停用'}
                    </WbButton>
                  </div>
                </td>
              </tr>
            ))}
          </AdminTable>
        )}
      </WbPanel>

      {/* 重置密码弹窗 */}
      {resetTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-void/70 px-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-line-subtle bg-panel p-6">
            <p className="text-sm font-medium text-ink-primary">
              重置密码 · {resetTarget.displayName}（{resetTarget.username}）
            </p>
            <p className="mt-1.5 text-xs text-ink-faint">
              重置后旧登录态立即失效。新密码请线下告知，首次登录后建议修改。
            </p>
            <div className="mt-4">
              <label className={wbLabelCls}>新密码</label>
              <input
                className={wbInputCls}
                type="password"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                placeholder="至少 6 位"
                maxLength={64}
                autoComplete="new-password"
              />
            </div>
            <WbError message={resetError} className="mt-3" />
            <div className="mt-4 flex justify-end gap-2">
              <WbButton variant="secondary" onClick={() => setResetTarget(null)}>
                取消
              </WbButton>
              <WbButton onClick={() => void handleReset()} loading={resetting} disabled={resetPassword.length < 6}>
                确认重置
              </WbButton>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
