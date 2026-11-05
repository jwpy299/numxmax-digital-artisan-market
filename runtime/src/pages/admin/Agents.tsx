/**
 * Agents（/admin/agents）—— 数字员工管理：列表（状态 / 行业大类过滤）+ 状态流转
 *（active / suspended / rejected 三态，两段式确认）。
 */
import { Fragment, useState } from 'react'
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
import { adminConfirm, AdminPager, AdminTable, adminTdCls } from './shared'

interface AgentRow {
  id: number
  code: string
  name: string
  slug: string
  industry: string
  industryGroup: string
  status: 'pending' | 'active' | 'suspended' | 'rejected'
  masterId: number
  monthlyPrice: number
  createdAt: string
}

interface ListResp {
  total: number
  page: number
  pageSize: number
  items: AgentRow[]
}

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'active', label: '生效中' },
  { value: 'pending', label: '待审核' },
  { value: 'suspended', label: '已暂停' },
  { value: 'rejected', label: '已驳回' },
]

const SET_STATUS_LABELS: Record<string, string> = {
  active: '恢复生效',
  suspended: '暂停',
  rejected: '驳回',
}

// ─── 迭代 40：坐席匠市技能面板（只读，skills.marketSkillsByAgent）───────────

interface MarketSkill {
  id: number
  name: string
  type: string
  complexity: number
  pricePerCall: number
  callCount: number
  successRate: number
  description: string
}

function AgentSkillPanel({ token, agentId }: { token: string; agentId: number }) {
  const { data, error, loading } = useWbQuery<MarketSkill[]>(
    'skills.marketSkillsByAgent',
    { token },
    { agentId },
  )
  const rows: MarketSkill[] = Array.isArray(data) ? data : []
  if (loading && !data) return <p className="px-2 py-3 text-xs text-ink-faint">技能加载中…</p>
  if (error) return <p className="px-2 py-3 text-xs text-ember-red">{error}</p>
  if (rows.length === 0) return <p className="px-2 py-3 text-xs text-ink-faint">该数字员工暂无匠市技能。</p>
  return (
    <div className="flex flex-wrap gap-2 px-2 py-3">
      {rows.map((s) => (
        <div
          key={s.id}
          className="rounded-lg border border-line-subtle bg-void/40 px-3 py-2 text-xs"
          title={s.description || undefined}
        >
          <p className="flex items-center gap-1.5 text-ink-primary">
            <span
              className={
                s.type === 'V'
                  ? 'rounded-full border border-pulse-cyan/40 px-1.5 font-mono text-[10px] text-pulse-cyan'
                  : 'rounded-full border border-forge-amber/40 px-1.5 font-mono text-[10px] text-forge-amber'
              }
            >
              {s.type}
            </span>
            {s.name}
          </p>
          <p className="mt-1 font-mono text-[10px] text-ink-faint">
            复杂度{s.complexity} · 单价{s.pricePerCall} · 调用{s.callCount} · 成功率{s.successRate}%
          </p>
        </div>
      ))}
    </div>
  )
}

export default function AdminAgents() {
  const { session } = useWbSession()
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [keyword, setKeyword] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [expandId, setExpandId] = useState<number | null>(null)

  const { data, error, loading, refetch } = useWbQuery<ListResp>('admin.agentsList', session, {
    page,
    pageSize: 20,
    status: status || undefined,
    search: keyword || undefined,
  })

  function setAgentStatus(a: AgentRow, next: 'active' | 'suspended' | 'rejected') {
    if (a.status === next) return
    if (!adminConfirm(`将数字员工「${a.name}（${a.code}）」${SET_STATUS_LABELS[next]}`)) return
    setNotice(null)
    setActionError(null)
    setPending(true)
    wbMutation('admin.agentSetStatus', { token: session!.token, agentId: a.id, status: next })
      .then(() => {
        setNotice(`已提交「${SET_STATUS_LABELS[next]}」，由系统执行，页面刷新后生效。`)
        refetch()
      })
      .catch((err) => setActionError(wbErrorMessage(err)))
      .finally(() => setPending(false))
  }

  return (
    <div>
      <WbPageHeader hud="AGENTS" title="数字员工管理" desc="门户数字匠市的员工上下架与状态治理。" />
      <WbPanel
        title="数字员工列表"
        hud="AGENT LIST"
        actions={
          <div className="flex flex-wrap gap-2">
            <select
              className="rounded-[10px] border border-line-subtle bg-void/60 px-3 py-2 text-sm text-ink-primary outline-none"
              value={status}
              onChange={(e) => {
                setPage(1)
                setStatus(e.target.value)
              }}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                setPage(1)
                setKeyword(search.trim())
              }}
            >
              <input
                className={wbInputCls + ' w-52'}
                placeholder="搜索名称 / 编号 / slug"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <WbButton variant="secondary" type="submit">搜索</WbButton>
            </form>
          </div>
        }
      >
        <WbNotice message={notice} className="mb-3" />
        <WbError message={actionError ?? error} className="mb-3" />
        {loading && <WbLoading />}
        {!loading && data && data.items.length === 0 && <WbEmpty text="暂无匹配的数字员工" />}
        {!loading && data && data.items.length > 0 && (
          <>
            <AdminTable head={['编号', '名称', '行业大类', '行业', '月薪（计量）', '老师傅ID', '状态', '操作']}>
              {data.items.map((a) => (
                <Fragment key={a.id}>
                <tr>
                  <td className={adminTdCls + ' font-mono'}>{a.code}</td>
                  <td className={adminTdCls}>
                    <p className="text-ink-primary">{a.name}</p>
                    <p className="text-xs text-ink-faint">{a.slug}</p>
                  </td>
                  <td className={adminTdCls}>{a.industryGroup}</td>
                  <td className={adminTdCls}>{a.industry}</td>
                  <td className={adminTdCls + ' font-mono'}>{a.monthlyPrice}</td>
                  <td className={adminTdCls + ' font-mono'}>{a.masterId}</td>
                  <td className={adminTdCls}><WbBadge status={a.status} /></td>
                  <td className={adminTdCls}>
                    <div className="flex flex-col gap-1.5">
                      <select
                        className="rounded-[8px] border border-line-subtle bg-void/60 px-2 py-1 text-xs text-ink-primary outline-none"
                        value=""
                        disabled={pending}
                        onChange={(e) => {
                          const v = e.target.value as 'active' | 'suspended' | 'rejected'
                          if (v) setAgentStatus(a, v)
                          e.target.value = ''
                        }}
                      >
                        <option value="">状态流转…</option>
                        {a.status !== 'active' && <option value="active">恢复生效</option>}
                        {a.status !== 'suspended' && <option value="suspended">暂停</option>}
                        {a.status !== 'rejected' && <option value="rejected">驳回</option>}
                      </select>
                      <button
                        type="button"
                        className="rounded-[8px] border border-line-subtle px-2 py-1 text-xs text-ink-secondary transition-colors hover:border-pulse-cyan/50 hover:text-ink-primary"
                        onClick={() => setExpandId(expandId === a.id ? null : a.id)}
                      >
                        {expandId === a.id ? '收起技能' : '查看技能'}
                      </button>
                    </div>
                  </td>
                </tr>
                {expandId === a.id && session && (
                  <tr>
                    <td colSpan={8} className="border-b border-line-subtle/60 bg-void/20">
                      <AgentSkillPanel token={session.token} agentId={a.id} />
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </AdminTable>
            <AdminPager page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </WbPanel>
    </div>
  )
}
