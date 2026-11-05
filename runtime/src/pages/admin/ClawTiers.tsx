/**
 * ClawTiers（/admin/claw-tiers）—— 企业龙虾分级管理（iter91）。
 * 数据：admin.clawTierList（企业名/当前 tier/开通人/时间）+
 *       admin.clawTierSet { factoryId, tier }（l0/l1/l2/l3 下拉调整，adminConfirm 二次确认）。
 */
import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
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
} from '@/components/wb/ui'
import { adminConfirm, AdminTable, adminTdCls, fmtTime } from './shared'
import { cn } from '@/lib/utils'

interface TierRow {
  factoryId: number
  enterpriseName: string | null
  industryGroup: string | null
  tier: 'l0' | 'l1' | 'l2' | 'l3'
  note: string | null
  openedBy: string | null
  openedAt: unknown
  updatedAt: unknown
}

const TIER_LABEL: Record<string, string> = {
  l0: 'L0 · 未开通',
  l1: 'L1 · 只读',
  l2: 'L2 · 全量+企业自审',
  l3: 'L3 · 平台托管',
}

const TIER_CLS: Record<string, string> = {
  l0: 'border-ink-faint/40 bg-ink-faint/10 text-ink-secondary',
  l1: 'border-pulse-cyan/40 bg-pulse-cyan/10 text-pulse-cyan',
  l2: 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber',
  l3: 'border-nebula-violet/50 bg-nebula-violet/10 text-nebula-violet',
}

export default function AdminClawTiers() {
  const { session } = useWbSession()
  const { data, error, loading, refetch } = useWbQuery<{ items: TierRow[] }>('admin.clawTierList', session)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  // 每行选中的目标 tier（未改动时 = 当前 tier）
  const [selected, setSelected] = useState<Record<number, TierRow['tier']>>({})

  function handleSet(row: TierRow) {
    const next = selected[row.factoryId] ?? row.tier
    if (next === row.tier) return
    if (
      !adminConfirm(
        `将企业「${row.enterpriseName ?? `#${row.factoryId}`}」龙虾级别由 ${TIER_LABEL[row.tier]} 调整为 ${TIER_LABEL[next]}`,
      )
    )
      return
    setNotice(null)
    setActionError(null)
    setPending(true)
    wbMutation('admin.clawTierSet', { token: session!.token, factoryId: row.factoryId, tier: next })
      .then(() => {
        setNotice(`已提交「${row.enterpriseName ?? `#${row.factoryId}`}」级别调整为 ${TIER_LABEL[next]}。`)
        refetch()
      })
      .catch((err) => setActionError(wbErrorMessage(err)))
      .finally(() => setPending(false))
  }

  const items = data?.items ?? []

  return (
    <div>
      <WbPageHeader
        hud="CLAW TIERS"
        title="龙虾分级管理"
        desc="企业龙虾能力分级：L0 未开通（拒绝派单）/ L1 仅只读技能 / L2 全量（高风险企业自审）/ L3 平台托管。"
      />
      <WbPanel
        title={`企业分级（${items.length}）`}
        hud="TIER LIST"
        actions={
          <WbButton variant="secondary" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </WbButton>
        }
      >
        <WbNotice message={notice} className="mb-3" />
        <WbError message={actionError ?? error} className="mb-3" />
        {loading && <WbLoading />}
        {!loading && data && items.length === 0 && <WbEmpty text="暂无企业分级记录" />}
        {!loading && items.length > 0 && (
          <AdminTable head={['企业', '行业大类', '当前级别', '调整为', '开通人', '更新时间', '操作']}>
            {items.map((row) => {
              const next = selected[row.factoryId] ?? row.tier
              return (
                <tr key={row.factoryId}>
                  <td className={adminTdCls}>
                    <p className="text-ink-primary">{row.enterpriseName ?? `FACTORY #${row.factoryId}`}</p>
                    <p className="font-mono text-[10px] text-ink-faint">#{row.factoryId}</p>
                  </td>
                  <td className={adminTdCls}>{row.industryGroup ?? '—'}</td>
                  <td className={adminTdCls}>
                    <span className={cn('inline-flex rounded-full border px-2.5 py-0.5 font-mono text-[11px]', TIER_CLS[row.tier])}>
                      {TIER_LABEL[row.tier]}
                    </span>
                    {row.note && <p className="mt-1 max-w-48 truncate text-[10px] text-ink-faint">{row.note}</p>}
                  </td>
                  <td className={adminTdCls}>
                    <select
                      className={cn(wbInputCls, 'w-44 px-2.5 py-1.5 text-xs')}
                      value={next}
                      onChange={(e) =>
                        setSelected((s) => ({ ...s, [row.factoryId]: e.target.value as TierRow['tier'] }))
                      }
                    >
                      {(['l0', 'l1', 'l2', 'l3'] as const).map((t) => (
                        <option key={t} value={t}>{TIER_LABEL[t]}</option>
                      ))}
                    </select>
                  </td>
                  <td className={adminTdCls}>{row.openedBy ?? '—'}</td>
                  <td className={adminTdCls + ' text-xs'}>{fmtTime(row.updatedAt ?? row.openedAt)}</td>
                  <td className={adminTdCls}>
                    <WbButton
                      variant="secondary"
                      disabled={pending || next === row.tier}
                      onClick={() => handleSet(row)}
                    >
                      确认调整
                    </WbButton>
                  </td>
                </tr>
              )
            })}
          </AdminTable>
        )}
      </WbPanel>
    </div>
  )
}
