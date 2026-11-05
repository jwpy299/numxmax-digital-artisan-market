/**
 * Alerts（/admin/alerts）—— 告警日志（iter92）。
 *
 * admin.alertLog {items}：近 100 条告警（level 徽标 / event / payload 截断 / sent_ok / 时间）。
 * 挂点：claw 执行失败、LLM 日用量 80%/100%、sandbox/corps 训练异常；
 * webhook 未配置时 sent_ok=0（仅落库，不 throw）。
 */
import { RefreshCw } from 'lucide-react'
import { useWbSession, useWbQuery } from '@/lib/wbSession'
import {
  WbBadge,
  WbButton,
  WbEmpty,
  WbError,
  WbLoading,
  WbPageHeader,
  WbPanel,
} from '@/components/wb/ui'
import { AdminTable, adminTdCls, fmtTime } from './shared'

interface AlertRow {
  id: number
  level: string
  event: string
  payload: string | null
  /** 后端可能返回 sent_ok（下划线）或 sentOk（驼峰） */
  sent_ok?: number | boolean
  sentOk?: number | boolean
  created_at?: unknown
  createdAt?: unknown
}

const LEVEL_BADGE: Record<string, { status: string; label: string }> = {
  info: { status: 'learning', label: 'info' },
  warn: { status: 'pending', label: 'warn' },
  warning: { status: 'pending', label: 'warn' },
  error: { status: 'rejected', label: 'error' },
  critical: { status: 'rejected', label: 'critical' },
}

const PAYLOAD_MAX = 120

function truncate(text: string): string {
  return text.length > PAYLOAD_MAX ? `${text.slice(0, PAYLOAD_MAX)}…` : text
}

export default function AdminAlerts() {
  const { session } = useWbSession()
  const { data, error, loading, refetch } = useWbQuery<{ items: AlertRow[] }>('admin.alertLog', session)

  const items = data?.items ?? []

  return (
    <div>
      <WbPageHeader
        hud="ALERT LOG"
        title="告警日志"
        desc="平台告警流水（近 100 条）：claw 执行失败、LLM 日用量 80%/100% 预警、训练异常；webhook 未配置时仅落库（sent_ok=0）。"
      />
      <WbPanel
        title={`告警记录（${items.length}）`}
        hud="RECENT ALERTS"
        actions={
          <WbButton variant="secondary" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </WbButton>
        }
      >
        <WbError message={error} className="mb-3" />
        {loading && <WbLoading />}
        {!loading && data && items.length === 0 && <WbEmpty text="暂无告警记录" hint="触发告警挂点后将在此留痕。" />}
        {!loading && items.length > 0 && (
          <AdminTable head={['ID', '级别', '事件', '内容', '推送', '时间']}>
            {items.map((a) => {
              const badge = LEVEL_BADGE[a.level] ?? { status: 'expired', label: a.level }
              const sentOk = a.sent_ok ?? a.sentOk ?? 0
              return (
                <tr key={a.id}>
                  <td className={adminTdCls + ' font-mono'}>{a.id}</td>
                  <td className={adminTdCls}>
                    <WbBadge status={badge.status} label={badge.label} />
                  </td>
                  <td className={adminTdCls + ' font-mono text-xs text-ink-primary'}>{a.event}</td>
                  <td className={adminTdCls + ' max-w-[360px] text-xs'}>
                    <span className="break-all">{a.payload ? truncate(a.payload) : '—'}</span>
                  </td>
                  <td className={adminTdCls}>
                    {sentOk ? (
                      <WbBadge status="active" label="已推送" />
                    ) : (
                      <WbBadge status="expired" label="仅落库" />
                    )}
                  </td>
                  <td className={adminTdCls + ' text-xs'}>{fmtTime(a.created_at ?? a.createdAt)}</td>
                </tr>
              )
            })}
          </AdminTable>
        )}
      </WbPanel>
    </div>
  )
}
