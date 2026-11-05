/**
 * MarketReview（/admin/market-review）—— 技能市场审核（iter92）。
 *
 * admin.marketPending {items}：待审核的技能发布单（技能/标题/行业/描述/价格/来源企业）。
 * 每条「批准 / 驳回」→ admin.marketApprove {id, approve}（adminConfirm 二次确认）。
 */
import { useState } from 'react'
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react'
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
import { adminConfirm, fmtTime } from './shared'

interface PendingItem {
  id: number
  skillKey: string
  title: string
  industry: string | null
  description: string | null
  sourceFactoryId: number
  enterpriseName?: string | null
  priceTokens: number
  createdAt: unknown
}

export default function AdminMarketReview() {
  const { session } = useWbSession()
  const { data, error, loading, refetch } = useWbQuery<{ items: PendingItem[] }>('admin.marketPending', session)

  const [notice, setNotice] = useState<string | null>(null)
  const [opErr, setOpErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function handleApprove(item: PendingItem, approve: boolean) {
    if (!session?.token || busy) return
    const action = approve ? `批准上架技能「${item.title}」` : `驳回技能「${item.title}」的发布申请`
    if (!adminConfirm(action)) return
    const key = `${approve ? 'ap' : 'rj'}-${item.id}`
    setBusy(key)
    setOpErr(null)
    setNotice(null)
    try {
      await wbMutation('admin.marketApprove', { token: session.token, id: item.id, approve })
      setNotice(approve ? `技能「${item.title}」已批准上架。` : `技能「${item.title}」已驳回。`)
      refetch()
    } catch (e) {
      setOpErr(wbErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const items = data?.items ?? []

  return (
    <div>
      <WbPageHeader
        hud="MARKET REVIEW"
        title="技能审核"
        desc="企业训练场毕业技能的发布申请：批准后上架技能市场（listed），驳回后退回企业（rejected），操作留痕。"
      />
      <WbNotice message={notice} className="mb-4" />
      <WbError message={opErr} className="mb-4" />

      <WbPanel
        title={`待审核发布（${items.length}）`}
        hud="PENDING SUBMISSIONS"
        actions={
          <WbButton variant="secondary" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </WbButton>
        }
      >
        <WbError message={error} className="mb-3" />
        {loading && <WbLoading />}
        {!loading && data && items.length === 0 && (
          <WbEmpty text="暂无待审核的技能发布" hint="企业发布毕业技能后将在此排队等待审核。" />
        )}
        <div className="space-y-2">
          {items.map((it) => (
            <div key={it.id} className="rounded-[10px] border border-line-subtle bg-void/40 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <WbBadge status="pending" label="待审核" />
                <p className="text-sm font-bold text-ink-primary">{it.title}</p>
                <span className="font-mono text-[10px] text-ink-faint">{it.skillKey}</span>
                {it.industry && <WbBadge status="skill" label={it.industry} />}
                <span className="ml-auto text-[10px] text-ink-faint">{fmtTime(it.createdAt)}</span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-ink-secondary">{it.description || '暂无描述'}</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <span className="font-grotesk text-base font-bold text-forge-amber">
                  {it.priceTokens}
                  <span className="ml-1 text-[10px] font-normal text-ink-faint">tokens</span>
                </span>
                <span className="text-[11px] text-ink-faint">
                  来源：{it.enterpriseName ?? `FACTORY #${it.sourceFactoryId}`}
                  <span className="ml-1 font-mono text-[10px]">#{it.sourceFactoryId}</span>
                </span>
                <div className="ml-auto flex gap-2">
                  <WbButton onClick={() => void handleApprove(it, true)} loading={busy === `ap-${it.id}`}>
                    <CheckCircle2 className="h-4 w-4" />
                    批准
                  </WbButton>
                  <WbButton variant="danger" onClick={() => void handleApprove(it, false)} loading={busy === `rj-${it.id}`}>
                    <XCircle className="h-4 w-4" />
                    驳回
                  </WbButton>
                </div>
              </div>
            </div>
          ))}
        </div>
      </WbPanel>
    </div>
  )
}
