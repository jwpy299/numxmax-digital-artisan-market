/**
 * CorpsList（/admin/corps）—— 全平台熊猫军团总览（iter91）。
 * 数据：admin.corpsList（企业名/行业/状态/成员数/通过率/驻场时间）。
 */
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
import { RefreshCw } from 'lucide-react'

interface CorpsRow {
  id: number
  factoryId: number
  enterpriseName: string | null
  name: string
  industry: string | null
  status: 'forming' | 'training' | 'graduated' | 'deployed' | 'suspended'
  memberCount: number
  trainPassRate: number | null
  createdAt: unknown
  graduatedAt: unknown
  deployedAt: unknown
}

const STATUS_BADGE: Record<string, { status: string; label: string }> = {
  forming: { status: 'pending', label: '组建中' },
  training: { status: 'learning', label: '训练中' },
  graduated: { status: 'active', label: '已毕业' },
  deployed: { status: 'listed', label: '已驻场' },
  suspended: { status: 'rejected', label: '已暂停' },
}

export default function AdminCorpsList() {
  const { session } = useWbSession()
  const { data, error, loading, refetch } = useWbQuery<{ items: CorpsRow[] }>('admin.corpsList', session)

  const items = data?.items ?? []

  return (
    <div>
      <WbPageHeader
        hud="CORPS OVERVIEW"
        title="熊猫军团总览"
        desc="全平台企业熊猫军团：组建 → 沙箱训练 → 毕业考核（通过率 ≥95%）→ 驻场。"
      />
      <WbPanel
        title={`军团列表（${items.length}）`}
        hud="CORPS LIST"
        actions={
          <WbButton variant="secondary" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </WbButton>
        }
      >
        <WbError message={error} className="mb-3" />
        {loading && <WbLoading />}
        {!loading && data && items.length === 0 && <WbEmpty text="暂无军团" />}
        {!loading && items.length > 0 && (
          <AdminTable head={['ID', '企业', '军团名', '行业', '状态', '成员数', '通过率', '毕业时间', '驻场时间', '创建时间']}>
            {items.map((c) => {
              const badge = STATUS_BADGE[c.status] ?? { status: 'expired', label: c.status }
              return (
                <tr key={c.id}>
                  <td className={adminTdCls + ' font-mono'}>{c.id}</td>
                  <td className={adminTdCls}>
                    <p className="text-ink-primary">{c.enterpriseName ?? `FACTORY #${c.factoryId}`}</p>
                    <p className="font-mono text-[10px] text-ink-faint">#{c.factoryId}</p>
                  </td>
                  <td className={adminTdCls + ' text-ink-primary'}>{c.name}</td>
                  <td className={adminTdCls}>{c.industry ?? '—'}</td>
                  <td className={adminTdCls}>
                    <WbBadge status={badge.status} label={badge.label} />
                  </td>
                  <td className={adminTdCls + ' font-mono'}>{c.memberCount}</td>
                  <td className={adminTdCls + ' font-mono'}>
                    {c.trainPassRate != null ? `${c.trainPassRate}%` : '—'}
                  </td>
                  <td className={adminTdCls + ' text-xs'}>{fmtTime(c.graduatedAt)}</td>
                  <td className={adminTdCls + ' text-xs'}>{fmtTime(c.deployedAt)}</td>
                  <td className={adminTdCls + ' text-xs'}>{fmtTime(c.createdAt)}</td>
                </tr>
              )
            })}
          </AdminTable>
        )}
      </WbPanel>
    </div>
  )
}
