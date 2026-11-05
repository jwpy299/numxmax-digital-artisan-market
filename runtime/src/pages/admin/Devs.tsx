/**
 * Devs（/admin/devs）—— 开发者生态：上架作品审核（pending_review → listed / rejected）。
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

interface DevListingRow {
  id: number
  kind: 'agent' | 'skill'
  name: string
  summary: string | null
  category: string | null
  priceToken: number
  status: 'pending_review' | 'listed' | 'rejected' | 'delisted'
  usageCount: number
  revenueToken: number
  createdAt: string
  devUsername: string | null
  devDisplayName: string | null
}

interface ListResp {
  total: number
  page: number
  pageSize: number
  items: DevListingRow[]
}

const STATUS_LABELS: Record<string, string> = {
  pending_review: '待审核',
  listed: '已上架',
  rejected: '已驳回',
  delisted: '已下架',
}

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
]

export default function AdminDevs() {
  const { session } = useWbSession()
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [keyword, setKeyword] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const { data, error, loading, refetch } = useWbQuery<ListResp>('admin.devListingsList', session, {
    page,
    pageSize: 20,
    status: status || undefined,
    search: keyword || undefined,
  })

  function setStatus_(row: DevListingRow, next: 'listed' | 'pending_review' | 'rejected') {
    const label = next === 'listed' ? '通过上架' : next === 'rejected' ? '驳回' : '退回待审核'
    if (!adminConfirm(`对作品「${row.name}」${label}`)) return
    setNotice(null)
    setActionError(null)
    setPending(true)
    wbMutation('admin.devListingSetStatus', { token: session!.token, listingId: row.id, status: next })
      .then(() => {
        setNotice(`已提交「${label}」，由系统执行，页面刷新后生效。`)
        refetch()
      })
      .catch((err) => setActionError(wbErrorMessage(err)))
      .finally(() => setPending(false))
  }

  return (
    <div>
      <WbPageHeader
        hud="DEV ECOSYSTEM"
        title="开发者生态"
        desc="第三方开发者上架作品审核（收益按调用计量结算；兑换能力未来开放）。"
      />
      <WbPanel
        title="上架作品列表"
        hud="DEV LISTING LIST"
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
                placeholder="搜索作品名"
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
        {!loading && data && data.items.length === 0 && <WbEmpty text="暂无匹配的作品" />}
        {!loading && data && data.items.length > 0 && (
          <>
            <AdminTable head={['ID', '作品', '开发者', '类型', '计量价', '调用量', '累计计量收益', '状态', '提交时间', '操作']}>
              {data.items.map((d) => (
                <tr key={d.id}>
                  <td className={adminTdCls + ' font-mono'}>{d.id}</td>
                  <td className={adminTdCls}>
                    <p className="text-ink-primary">{d.name}</p>
                    {d.summary && <p className="max-w-56 truncate text-xs text-ink-faint" title={d.summary}>{d.summary}</p>}
                  </td>
                  <td className={adminTdCls}>
                    <p>{d.devDisplayName ?? '—'}</p>
                    {d.devUsername && <p className="text-xs text-ink-faint">@{d.devUsername}</p>}
                  </td>
                  <td className={adminTdCls}><WbBadge status={d.kind} /></td>
                  <td className={adminTdCls + ' font-mono'}>{d.priceToken}</td>
                  <td className={adminTdCls + ' font-mono'}>{d.usageCount}</td>
                  <td className={adminTdCls + ' font-mono text-forge-amber'}>{d.revenueToken}</td>
                  <td className={adminTdCls}>
                    <WbBadge
                      status={d.status === 'pending_review' ? 'pending' : d.status === 'delisted' ? 'expired' : d.status}
                      label={STATUS_LABELS[d.status]}
                    />
                  </td>
                  <td className={adminTdCls + ' text-xs'}>{fmtTime(d.createdAt)}</td>
                  <td className={adminTdCls}>
                    <div className="flex flex-wrap gap-2">
                      {d.status !== 'listed' && (
                        <WbButton variant="secondary" disabled={pending} onClick={() => setStatus_(d, 'listed')}>
                          通过上架
                        </WbButton>
                      )}
                      {d.status === 'pending_review' && (
                        <WbButton variant="danger" disabled={pending} onClick={() => setStatus_(d, 'rejected')}>
                          驳回
                        </WbButton>
                      )}
                      {d.status === 'rejected' && (
                        <WbButton variant="secondary" disabled={pending} onClick={() => setStatus_(d, 'pending_review')}>
                          退回待审核
                        </WbButton>
                      )}
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
