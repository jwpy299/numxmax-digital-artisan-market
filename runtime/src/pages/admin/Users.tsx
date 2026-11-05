/**
 * Users（/admin/users）—— 用户管理：分页列表 + 搜索 + 角色调整 / 禁用 / 重置密码。
 * 变更操作统一两段式：二次确认，提交后由系统执行，页面刷新后生效。
 */
import { useState } from 'react'
import { useWbSession, useWbQuery, wbMutation, wbErrorMessage } from '@/lib/wbSession'
import {
  WbBadge,
  WbButton,
  WbEmpty,
  WbError,
  WbLoading,
  WbNotice,
  WbPageHeader,
  WbPanel,
  wbInputCls,
} from '@/components/wb/ui'
import { adminConfirm, AdminPager, AdminTable, adminTdCls, fmtTime } from './shared'

interface UserRow {
  id: number
  username: string
  phone: string | null
  displayName: string
  kind: 'person' | 'enterprise'
  role: 'admin' | 'owner' | 'member'
  factoryId: number
  createdAt: string
  disabled: number
}

interface ListResp {
  total: number
  page: number
  pageSize: number
  items: UserRow[]
}

const KIND_LABELS: Record<string, string> = { person: '个人', enterprise: '企业' }
const ROLE_LABELS: Record<string, string> = { admin: '管理员', owner: '企业负责人', member: '成员' }

export default function AdminUsers() {
  const { session } = useWbSession()
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [keyword, setKeyword] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const { data, error, loading, refetch } = useWbQuery<ListResp>('admin.usersList', session, {
    page,
    pageSize: 20,
    search: keyword || undefined,
  })

  async function run(action: string, fn: () => Promise<unknown>) {
    if (!adminConfirm(action)) return
    setNotice(null)
    setActionError(null)
    setPending(true)
    try {
      await fn()
      setNotice(`已提交「${action}」，由系统执行，页面刷新后生效。`)
      refetch()
    } catch (err) {
      setActionError(wbErrorMessage(err))
    } finally {
      setPending(false)
    }
  }

  function setRole(u: UserRow, role: 'admin' | 'owner' | 'member') {
    if (u.role === role) return
    void run(`将用户「${u.displayName}」角色调整为${ROLE_LABELS[role]}`, () =>
      wbMutation('admin.userSetRole', { token: session!.token, userId: u.id, role }),
    )
  }

  function toggleDisabled(u: UserRow) {
    const next = u.disabled === 1
    void run(next ? `恢复用户「${u.displayName}」` : `禁用用户「${u.displayName}」（其现有会话将失效）`, () =>
      wbMutation('admin.userSetDisabled', { token: session!.token, userId: u.id, disabled: !next }),
    )
  }

  function resetPassword(u: UserRow) {
    const pwd = window.prompt(`为用户「${u.displayName}」设置新密码（至少 8 位）：`)
    if (!pwd) return
    void run(`重置用户「${u.displayName}」的密码（其现有会话将失效）`, () =>
      wbMutation('admin.userResetPassword', { token: session!.token, userId: u.id, newPassword: pwd }),
    )
  }

  return (
    <div>
      <WbPageHeader hud="USERS" title="用户管理" desc="门户与工作台共用的账号体系（wb_users），支持角色调整、禁用与密码重置。" />
      <WbPanel
        title="账号列表"
        hud="USER LIST"
        actions={
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              setPage(1)
              setKeyword(search.trim())
            }}
          >
            <input
              className={wbInputCls + ' w-56'}
              placeholder="搜索账号 / 手机号 / 姓名"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <WbButton variant="secondary" type="submit">搜索</WbButton>
          </form>
        }
      >
        <WbNotice message={notice} className="mb-3" />
        <WbError message={actionError ?? error} className="mb-3" />
        {loading && <WbLoading />}
        {!loading && data && data.items.length === 0 && <WbEmpty text="暂无匹配的账号" />}
        {!loading && data && data.items.length > 0 && (
          <>
            <AdminTable head={['ID', '账号 / 手机号', '姓名', '类型', '角色', '企业ID', '状态', '注册时间', '操作']}>
              {data.items.map((u) => (
                <tr key={u.id}>
                  <td className={adminTdCls + ' font-mono'}>{u.id}</td>
                  <td className={adminTdCls}>
                    <p className="text-ink-primary">{u.username}</p>
                    {u.phone && <p className="text-xs text-ink-faint">{u.phone}</p>}
                  </td>
                  <td className={adminTdCls}>{u.displayName}</td>
                  <td className={adminTdCls}>{KIND_LABELS[u.kind] ?? u.kind}</td>
                  <td className={adminTdCls}>
                    <select
                      className="rounded-[8px] border border-line-subtle bg-void/60 px-2 py-1 text-xs text-ink-primary outline-none"
                      value={u.role}
                      disabled={pending || u.username === session?.username}
                      onChange={(e) => setRole(u, e.target.value as UserRow['role'])}
                    >
                      <option value="admin">管理员</option>
                      <option value="owner">企业负责人</option>
                      <option value="member">成员</option>
                    </select>
                  </td>
                  <td className={adminTdCls + ' font-mono'}>{u.factoryId}</td>
                  <td className={adminTdCls}>
                    {u.disabled === 1 ? <WbBadge status="rejected" label="已禁用" /> : <WbBadge status="active" label="正常" />}
                  </td>
                  <td className={adminTdCls + ' text-xs'}>{fmtTime(u.createdAt)}</td>
                  <td className={adminTdCls}>
                    <div className="flex flex-wrap gap-2">
                      <WbButton variant="secondary" disabled={pending} onClick={() => resetPassword(u)}>
                        重置密码
                      </WbButton>
                      <WbButton
                        variant={u.disabled === 1 ? 'secondary' : 'danger'}
                        disabled={pending}
                        onClick={() => toggleDisabled(u)}
                      >
                        {u.disabled === 1 ? '恢复' : '禁用'}
                      </WbButton>
                    </div>
                  </td>
                </tr>
              ))}
            </AdminTable>
            <AdminPager page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </WbPanel>
    </div>
  )
}
