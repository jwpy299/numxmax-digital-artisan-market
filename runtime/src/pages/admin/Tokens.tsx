/**
 * Tokens（/admin/tokens）—— Token 流水（只读）：分页列表 + 汇总。
 * 文案口径：Token 仅用于「结算 / 兑换 / 计量」。
 */
import { useState } from 'react'
import { useWbSession, useWbQuery } from '@/lib/wbSession'
import { WbEmpty, WbError, WbLoading, WbPageHeader, WbPanel, WbStat } from '@/components/wb/ui'
import { AdminPager, AdminTable, adminTdCls, fmtTime } from './shared'

interface FlowRow {
  id: number
  type: string
  amount: number
  platformFee: number
  masterShare: number
  note: string | null
  createdAt: string
  agentName: string | null
  enterpriseName: string | null
}

interface ListResp {
  total: number
  page: number
  pageSize: number
  items: FlowRow[]
  summary: { amountTotal: number; platformFeeTotal: number }
}

const TYPE_LABELS: Record<string, string> = {
  hire_commission: '雇佣结算佣金',
  skill_call: '技能调用计量',
  trial_skill_call: '试用期调用计量',
  trial_reward: '试用激励结算',
  price_adjustment: '调价差额结算',
}

const TYPE_OPTIONS = [
  { value: '', label: '全部类型' },
  ...Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label })),
]

export default function AdminTokens() {
  const { session } = useWbSession()
  const [page, setPage] = useState(1)
  const [type, setType] = useState('')
  const { data, error, loading } = useWbQuery<ListResp>('admin.tokenFlowsList', session, {
    page,
    pageSize: 20,
    type: type || undefined,
  })

  return (
    <div>
      <WbPageHeader
        hud="TOKEN FLOWS"
        title="Token 流水"
        desc="平台 Token 仅用于服务计量与结算，以下为只读流水视图。兑换相关能力未来开放。"
      />
      {data && (
        <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-3">
          <WbStat label="流水总额（计量）" value={data.summary.amountTotal} tone="amber" />
          <WbStat label="平台结算佣金" value={data.summary.platformFeeTotal} tone="amber" />
          <WbStat label="流水笔数" value={data.total} tone="cyan" />
        </div>
      )}
      <WbPanel
        title="流水列表"
        hud="FLOW LIST"
        actions={
          <select
            className="rounded-[10px] border border-line-subtle bg-void/60 px-3 py-2 text-sm text-ink-primary outline-none"
            value={type}
            onChange={(e) => {
              setPage(1)
              setType(e.target.value)
            }}
          >
            {TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        }
      >
        <WbError message={error} className="mb-3" />
        {loading && <WbLoading />}
        {!loading && data && data.items.length === 0 && <WbEmpty text="暂无流水记录" />}
        {!loading && data && data.items.length > 0 && (
          <>
            <AdminTable head={['ID', '类型', '数字员工', '企业', '计量额', '平台结算', '老师傅结算', '备注', '时间']}>
              {data.items.map((f) => (
                <tr key={f.id}>
                  <td className={adminTdCls + ' font-mono'}>{f.id}</td>
                  <td className={adminTdCls}>{TYPE_LABELS[f.type] ?? f.type}</td>
                  <td className={adminTdCls}>{f.agentName ?? '—'}</td>
                  <td className={adminTdCls}>{f.enterpriseName ?? '—'}</td>
                  <td className={adminTdCls + ' font-mono text-forge-amber'}>{f.amount}</td>
                  <td className={adminTdCls + ' font-mono'}>{f.platformFee}</td>
                  <td className={adminTdCls + ' font-mono'}>{f.masterShare}</td>
                  <td className={adminTdCls}>
                    <p className="max-w-48 truncate text-xs" title={f.note ?? ''}>{f.note ?? '—'}</p>
                  </td>
                  <td className={adminTdCls + ' text-xs'}>{fmtTime(f.createdAt)}</td>
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
