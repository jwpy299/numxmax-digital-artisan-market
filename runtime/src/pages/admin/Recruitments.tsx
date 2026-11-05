/**
 * Recruitments（/admin/recruitments）—— 招聘与应征：两个 tab。
 * tab1 招募单：上下架（open ↔ closed）；tab2 应征审核：通过 / 拒绝（回填决定时间）。
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
} from '@/components/wb/ui'
import { cn } from '@/lib/utils'
import { adminConfirm, AdminPager, AdminTable, adminTdCls, fmtTime } from './shared'

interface RecruitmentRow {
  id: number
  title: string
  industry: string
  budgetMonthly: number
  periodMonths: number
  urgent: boolean
  status: 'open' | 'filled' | 'closed'
  createdAt: string
  enterpriseName: string | null
}

interface ApplicationRow {
  id: number
  recruitmentId: number
  message: string
  status: 'pending' | 'accepted' | 'rejected'
  decidedAt: string | null
  createdAt: string
  recruitmentTitle: string | null
  agentName: string | null
  agentCode: string | null
}

interface ListResp<T> {
  total: number
  page: number
  pageSize: number
  items: T[]
}

const REC_STATUS_LABELS: Record<string, string> = { open: '招聘中', filled: '已招满', closed: '已下架' }
const APP_STATUS_LABELS: Record<string, string> = { pending: '待审核', accepted: '已通过', rejected: '已拒绝' }

export default function AdminRecruitments() {
  const { session } = useWbSession()
  const [tab, setTab] = useState<'recruitments' | 'applications'>('recruitments')
  const [page, setPage] = useState(1)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const recs = useWbQuery<ListResp<RecruitmentRow>>('admin.recruitmentsList', session, {
    page,
    pageSize: 20,
  }, { enabled: tab === 'recruitments' })
  const apps = useWbQuery<ListResp<ApplicationRow>>('admin.applicationsList', session, {
    page,
    pageSize: 20,
  }, { enabled: tab === 'applications' })

  function switchTab(next: typeof tab) {
    setTab(next)
    setPage(1)
    setNotice(null)
    setActionError(null)
  }

  function run(action: string, fn: () => Promise<unknown>, refresh: () => void) {
    if (!adminConfirm(action)) return
    setNotice(null)
    setActionError(null)
    setPending(true)
    fn()
      .then(() => {
        setNotice(`已提交「${action}」，由系统执行，页面刷新后生效。`)
        refresh()
      })
      .catch((err) => setActionError(wbErrorMessage(err)))
      .finally(() => setPending(false))
  }

  return (
    <div>
      <WbPageHeader hud="RECRUIT" title="招聘与应征" desc="企业招募单上下架，数字员工应征审核。" />

      <div className="mb-5 inline-flex gap-1 rounded-[10px] border border-line-subtle bg-void/60 p-1">
        {([
          ['recruitments', '招募单'],
          ['applications', '应征审核'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => switchTab(key)}
            className={cn(
              'rounded-[8px] px-4 py-2 text-sm font-medium transition-colors duration-300',
              tab === key ? 'bg-forge-amber/[0.12] text-forge-amber' : 'text-ink-secondary hover:text-ink-primary',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <WbNotice message={notice} className="mb-3" />
      <WbError message={actionError} className="mb-3" />

      {tab === 'recruitments' && (
        <WbPanel title="招募单列表" hud="RECRUITMENT LIST">
          <WbError message={recs.error} className="mb-3" />
          {recs.loading && <WbLoading />}
          {!recs.loading && recs.data && recs.data.items.length === 0 && <WbEmpty text="暂无招募单" />}
          {!recs.loading && recs.data && recs.data.items.length > 0 && (
            <>
              <AdminTable head={['ID', '标题', '企业', '行业', '预算（月计量）', '周期', '状态', '发布时间', '操作']}>
                {recs.data.items.map((r) => (
                  <tr key={r.id}>
                    <td className={adminTdCls + ' font-mono'}>{r.id}</td>
                    <td className={adminTdCls}>
                      <p className="text-ink-primary">{r.title}</p>
                      {r.urgent && <p className="text-xs text-forge-amber">急聘</p>}
                    </td>
                    <td className={adminTdCls}>{r.enterpriseName ?? '—'}</td>
                    <td className={adminTdCls}>{r.industry}</td>
                    <td className={adminTdCls + ' font-mono'}>{r.budgetMonthly}</td>
                    <td className={adminTdCls}>{r.periodMonths} 个月</td>
                    <td className={adminTdCls}>
                      <WbBadge
                        status={r.status === 'open' ? 'active' : r.status === 'closed' ? 'expired' : 'listed'}
                        label={REC_STATUS_LABELS[r.status]}
                      />
                    </td>
                    <td className={adminTdCls + ' text-xs'}>{fmtTime(r.createdAt)}</td>
                    <td className={adminTdCls}>
                      {r.status === 'open' ? (
                        <WbButton
                          variant="danger"
                          disabled={pending}
                          onClick={() =>
                            run(`下架招募单「${r.title}」`, () =>
                              wbMutation('admin.recruitmentSetStatus', {
                                token: session!.token,
                                recruitmentId: r.id,
                                status: 'closed',
                              }), recs.refetch)
                          }
                        >
                          下架
                        </WbButton>
                      ) : (
                        <WbButton
                          variant="secondary"
                          disabled={pending}
                          onClick={() =>
                            run(`重新上架招募单「${r.title}」`, () =>
                              wbMutation('admin.recruitmentSetStatus', {
                                token: session!.token,
                                recruitmentId: r.id,
                                status: 'open',
                              }), recs.refetch)
                          }
                        >
                          重新上架
                        </WbButton>
                      )}
                    </td>
                  </tr>
                ))}
              </AdminTable>
              <AdminPager page={page} pageSize={recs.data.pageSize} total={recs.data.total} onPage={setPage} />
            </>
          )}
        </WbPanel>
      )}

      {tab === 'applications' && (
        <WbPanel title="应征审核" hud="APPLICATION REVIEW">
          <WbError message={apps.error} className="mb-3" />
          {apps.loading && <WbLoading />}
          {!apps.loading && apps.data && apps.data.items.length === 0 && <WbEmpty text="暂无应征记录" />}
          {!apps.loading && apps.data && apps.data.items.length > 0 && (
            <>
              <AdminTable head={['ID', '应征数字员工', '招募单', '留言', '状态', '提交时间', '操作']}>
                {apps.data.items.map((a) => (
                  <tr key={a.id}>
                    <td className={adminTdCls + ' font-mono'}>{a.id}</td>
                    <td className={adminTdCls}>
                      <p className="text-ink-primary">{a.agentName ?? '—'}</p>
                      {a.agentCode && <p className="text-xs text-ink-faint">{a.agentCode}</p>}
                    </td>
                    <td className={adminTdCls}>{a.recruitmentTitle ?? `#${a.recruitmentId}`}</td>
                    <td className={adminTdCls}>
                      <p className="max-w-64 truncate text-xs" title={a.message}>{a.message}</p>
                    </td>
                    <td className={adminTdCls}>
                      <WbBadge
                        status={a.status === 'accepted' ? 'listed' : a.status === 'rejected' ? 'rejected' : 'pending'}
                        label={APP_STATUS_LABELS[a.status]}
                      />
                    </td>
                    <td className={adminTdCls + ' text-xs'}>{fmtTime(a.createdAt)}</td>
                    <td className={adminTdCls}>
                      {a.status === 'pending' ? (
                        <div className="flex gap-2">
                          <WbButton
                            variant="secondary"
                            disabled={pending}
                            onClick={() =>
                              run(`通过应征 #${a.id}`, () =>
                                wbMutation('admin.applicationSetStatus', {
                                  token: session!.token,
                                  applicationId: a.id,
                                  status: 'accepted',
                                }), apps.refetch)
                            }
                          >
                            通过
                          </WbButton>
                          <WbButton
                            variant="danger"
                            disabled={pending}
                            onClick={() =>
                              run(`拒绝应征 #${a.id}`, () =>
                                wbMutation('admin.applicationSetStatus', {
                                  token: session!.token,
                                  applicationId: a.id,
                                  status: 'rejected',
                                }), apps.refetch)
                            }
                          >
                            拒绝
                          </WbButton>
                        </div>
                      ) : (
                        <span className="text-xs text-ink-faint">已处理 {fmtTime(a.decidedAt)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </AdminTable>
              <AdminPager page={page} pageSize={apps.data.pageSize} total={apps.data.total} onPage={setPage} />
            </>
          )}
        </WbPanel>
      )}
    </div>
  )
}
