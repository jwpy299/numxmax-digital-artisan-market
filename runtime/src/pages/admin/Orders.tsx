/**
 * Orders（/admin/orders）—— 雇佣订单列表（只读）：关联数字员工与企业名称。
 */
import { useState } from 'react'
import { useWbSession, useWbQuery } from '@/lib/wbSession'
import { WbBadge, WbEmpty, WbError, WbLoading, WbPageHeader, WbPanel } from '@/components/wb/ui'
import { AdminPager, AdminTable, adminTdCls, fmtTime } from './shared'

interface OrderRow {
  id: number
  periodMonths: number
  monthlyPrice: number
  status: 'trial' | 'active' | 'expired' | 'cancelled'
  tasksCompleted: number
  startedAt: string
  endsAt: string
  createdAt: string
  agentName: string | null
  agentCode: string | null
  enterpriseName: string | null
}

interface ListResp {
  total: number
  page: number
  pageSize: number
  items: OrderRow[]
}

const STATUS_LABELS: Record<string, string> = {
  trial: '试用期',
  active: '生效中',
  expired: '已到期',
  cancelled: '已取消',
}

export default function AdminOrders() {
  const { session } = useWbSession()
  const [page, setPage] = useState(1)
  const { data, error, loading } = useWbQuery<ListResp>('admin.hireOrdersList', session, {
    page,
    pageSize: 20,
  })

  return (
    <div>
      <WbPageHeader hud="HIRE ORDERS" title="雇佣订单" desc="门户数字匠市的雇佣合约订单（只读视图）。" />
      <WbPanel title="订单列表" hud="ORDER LIST">
        <WbError message={error} className="mb-3" />
        {loading && <WbLoading />}
        {!loading && data && data.items.length === 0 && <WbEmpty text="暂无雇佣订单" />}
        {!loading && data && data.items.length > 0 && (
          <>
            <AdminTable head={['ID', '数字员工', '雇主企业', '周期', '月薪（计量）', '完成任务', '状态', '起止时间']}>
              {data.items.map((o) => (
                <tr key={o.id}>
                  <td className={adminTdCls + ' font-mono'}>{o.id}</td>
                  <td className={adminTdCls}>
                    <p className="text-ink-primary">{o.agentName ?? '—'}</p>
                    {o.agentCode && <p className="text-xs text-ink-faint">{o.agentCode}</p>}
                  </td>
                  <td className={adminTdCls}>{o.enterpriseName ?? '—'}</td>
                  <td className={adminTdCls}>{o.periodMonths} 个月</td>
                  <td className={adminTdCls + ' font-mono'}>{o.monthlyPrice}</td>
                  <td className={adminTdCls + ' font-mono'}>{o.tasksCompleted}</td>
                  <td className={adminTdCls}>
                    <WbBadge
                      status={o.status === 'cancelled' ? 'rejected' : o.status === 'expired' ? 'expired' : o.status}
                      label={STATUS_LABELS[o.status]}
                    />
                  </td>
                  <td className={adminTdCls + ' text-xs'}>
                    {fmtTime(o.startedAt)} ~ {fmtTime(o.endsAt)}
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
