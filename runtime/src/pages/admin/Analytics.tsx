/**
 * Analytics（/admin/analytics）—— 经营分析（迭代 35，adminAnalytics.* 契约）。
 * 1. 经营漏斗（funnel）：6 层横条图（纯 CSS），count=null 显示「口径待补」
 * 2. 收入趋势（revenueTrend，默认 30 天）：纯 div sparkline + 合计
 * 3. 供给侧（supplySide）：员工/技能包两卡 + TOP 技能包榜
 * 数字全部来自 API；字段做 camelCase/snake_case 双兼容。
 */
import { BarChart3, Coins, Cpu, Package, TrendingUp, Trophy } from 'lucide-react'
import { useWbSession, useWbQuery } from '@/lib/wbSession'
import { WbEmpty, WbError, WbLoading, WbPageHeader, WbPanel } from '@/components/wb/ui'
import { cn } from '@/lib/utils'

// ─── 类型（兼容 snake_case / camelCase）──────────────────────────────────────

interface FunnelStage {
  key?: string
  label?: string
  count?: number | null
  note?: string | null
}
interface FunnelResp {
  stages?: FunnelStage[]
  generatedAt?: string
  generated_at?: string
}

interface TrendPoint {
  date?: string
  tokenFlow?: number
  token_flow?: number
  shopGmv?: number
  shop_gmv?: number
  platformShare?: number
  platform_share?: number
}
interface TrendResp {
  series?: TrendPoint[]
  totals?: Partial<Record<'tokenFlow' | 'token_flow' | 'shopGmv' | 'shop_gmv' | 'platformShare' | 'platform_share', number>>
}

interface TopPack {
  packKey?: string
  pack_key?: string
  title?: string
  sales?: number
}
interface SupplyResp {
  agents?: { total?: number; hired?: number; hireRate?: number | null; hire_rate?: number | null }
  packs?: { total?: number; withSales?: number; with_sales?: number; sellThroughRate?: number | null; sell_through_rate?: number | null }
  topPacks?: TopPack[]
  top_packs?: TopPack[]
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
function pct(v: unknown): string {
  if (v == null) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return `${(n <= 1 ? n * 100 : n).toFixed(1)}%`
}

// ─── 漏斗 ────────────────────────────────────────────────────────────────────

function FunnelPanel() {
  const { session } = useWbSession()
  const query = useWbQuery<FunnelResp>('adminAnalytics.funnel', session, {}, { enabled: !!session?.token })
  const stages = query.data?.stages ?? []
  const max = Math.max(1, ...stages.map((s) => num(s.count)))

  return (
    <WbPanel hud="BUSINESS FUNNEL" title="经营漏斗" className="mb-6">
      {query.loading && !query.data ? (
        <WbLoading text="漏斗数据加载中…" />
      ) : query.error ? (
        <WbError message={query.error} />
      ) : stages.length === 0 ? (
        <WbEmpty text="暂无数据" />
      ) : (
        <div className="space-y-3">
          {stages.map((s, i) => {
            const pending = s.count == null
            const w = pending ? 0 : Math.max(2, (num(s.count) / max) * 100)
            return (
              <div key={s.key ?? i}>
                <div className="mb-1 flex items-baseline justify-between gap-3">
                  <p className="text-xs text-ink-secondary">
                    <span className="mr-2 font-mono text-[10px] text-ink-faint">{String(i + 1).padStart(2, '0')}</span>
                    {s.label ?? s.key ?? '—'}
                  </p>
                  <p className="shrink-0 font-mono text-xs">
                    {pending ? (
                      <span className="text-forge-amber">口径待补</span>
                    ) : (
                      <span className="text-ink-primary">{num(s.count)}</span>
                    )}
                  </p>
                </div>
                <div className="h-5 overflow-hidden rounded-md border border-line-subtle bg-void/60">
                  <div
                    className={cn('h-full rounded-sm transition-all duration-500', pending ? 'bg-line-subtle/40' : 'bg-forge-amber/60')}
                    style={{ width: pending ? '100%' : `${w}%`, opacity: pending ? 0.25 : Math.max(0.35, 1 - i * 0.12) }}
                  />
                </div>
                {s.note && <p className="mt-0.5 text-[11px] text-ink-faint">{s.note}</p>}
              </div>
            )
          })}
          <p className="pt-1 text-right font-mono text-[10px] text-ink-faint">
            生成时间：{(() => { const g = query.data?.generatedAt ?? query.data?.generated_at; return g ? new Date(String(g)).toLocaleString('zh-CN', { hour12: false }) : '—' })()}
          </p>
        </div>
      )}
    </WbPanel>
  )
}

// ─── 收入趋势 sparkline（纯 div 柱状）────────────────────────────────────────

function RevenuePanel() {
  const { session } = useWbSession()
  const query = useWbQuery<TrendResp>('adminAnalytics.revenueTrend', session, { days: 30 }, { enabled: !!session?.token })
  const series = query.data?.series ?? []
  const totals = query.data?.totals
  const gmvOf = (p: TrendPoint) => num(p.shopGmv ?? p.shop_gmv)
  const flowOf = (p: TrendPoint) => num(p.tokenFlow ?? p.token_flow)
  const max = Math.max(1, ...series.map((p) => Math.max(gmvOf(p), flowOf(p))))

  return (
    <WbPanel hud="REVENUE TREND · 30D" title="收入趋势（近 30 天）" className="mb-6">
      {query.loading && !query.data ? (
        <WbLoading text="趋势数据加载中…" />
      ) : query.error ? (
        <WbError message={query.error} />
      ) : series.length === 0 ? (
        <WbEmpty text="暂无数据" />
      ) : (
        <>
          <div className="flex h-28 items-end gap-[3px]">
            {series.map((p, i) => (
              <div key={p.date ?? i} className="group flex h-full flex-1 flex-col justify-end gap-[2px]" title={`${p.date ?? ''}\n商城 GMV：${gmvOf(p)}\nToken 流水：${flowOf(p)}`}>
                <div className="w-full rounded-t-sm bg-pulse-cyan/50 transition-opacity group-hover:opacity-100" style={{ height: `${(flowOf(p) / max) * 100}%`, minHeight: flowOf(p) > 0 ? 2 : 0, opacity: 0.8 }} />
                <div className="w-full rounded-t-sm bg-forge-amber/70 transition-opacity group-hover:opacity-100" style={{ height: `${(gmvOf(p) / max) * 100}%`, minHeight: gmvOf(p) > 0 ? 2 : 0, opacity: 0.85 }} />
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-ink-faint">
            <span className="font-mono">{series[0]?.date ?? ''}</span>
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm bg-forge-amber/70" />商城 GMV</span>
              <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm bg-pulse-cyan/50" />Token 流水</span>
            </span>
            <span className="font-mono">{series[series.length - 1]?.date ?? ''}</span>
          </div>
          {totals && (
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-line-subtle bg-void/40 px-4 py-3">
                <p className="flex items-center gap-1.5 text-[11px] text-ink-faint"><Coins className="h-3 w-3 text-forge-amber" />商城 GMV 合计</p>
                <p className="mt-1 font-grotesk text-xl font-bold text-forge-amber">{num(totals.shopGmv ?? totals.shop_gmv)}</p>
              </div>
              <div className="rounded-xl border border-line-subtle bg-void/40 px-4 py-3">
                <p className="flex items-center gap-1.5 text-[11px] text-ink-faint"><TrendingUp className="h-3 w-3 text-pulse-cyan" />Token 流水合计</p>
                <p className="mt-1 font-grotesk text-xl font-bold text-pulse-cyan">{num(totals.tokenFlow ?? totals.token_flow)}</p>
              </div>
              <div className="rounded-xl border border-line-subtle bg-void/40 px-4 py-3">
                <p className="flex items-center gap-1.5 text-[11px] text-ink-faint"><Coins className="h-3 w-3 text-jade-green" />平台分账合计</p>
                <p className="mt-1 font-grotesk text-xl font-bold text-jade-green">{num(totals.platformShare ?? totals.platform_share)}</p>
              </div>
            </div>
          )}
        </>
      )}
    </WbPanel>
  )
}

// ─── 供给侧 ──────────────────────────────────────────────────────────────────

function SupplyPanel() {
  const { session } = useWbSession()
  const query = useWbQuery<SupplyResp>('adminAnalytics.supplySide', session, {}, { enabled: !!session?.token })
  const agents = query.data?.agents
  const packs = query.data?.packs
  const topPacks = query.data?.topPacks ?? query.data?.top_packs ?? []

  return (
    <WbPanel hud="SUPPLY SIDE" title="供给侧">
      {query.loading && !query.data ? (
        <WbLoading text="供给侧数据加载中…" />
      ) : query.error ? (
        <WbError message={query.error} />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-line-subtle bg-void/40 p-5">
              <p className="flex items-center gap-1.5 text-xs text-ink-faint"><Cpu className="h-3.5 w-3.5 text-pulse-cyan" />数字员工供给</p>
              <p className="mt-2 font-grotesk text-3xl font-bold text-ink-primary">{num(agents?.total)}</p>
              <p className="mt-1 text-xs text-ink-secondary">
                已被雇佣 <span className="font-mono text-ink-primary">{num(agents?.hired)}</span>
                <span className="mx-2 text-ink-faint">·</span>
                雇佣率 <span className="font-mono text-pulse-cyan">{pct(agents?.hireRate ?? agents?.hire_rate)}</span>
              </p>
            </div>
            <div className="rounded-xl border border-line-subtle bg-void/40 p-5">
              <p className="flex items-center gap-1.5 text-xs text-ink-faint"><Package className="h-3.5 w-3.5 text-forge-amber" />技能包供给</p>
              <p className="mt-2 font-grotesk text-3xl font-bold text-ink-primary">{num(packs?.total)}</p>
              <p className="mt-1 text-xs text-ink-secondary">
                有销量 <span className="font-mono text-ink-primary">{num(packs?.withSales ?? packs?.with_sales)}</span>
                <span className="mx-2 text-ink-faint">·</span>
                动销率 <span className="font-mono text-forge-amber">{pct(packs?.sellThroughRate ?? packs?.sell_through_rate)}</span>
              </p>
            </div>
          </div>

          <p className="mb-2 mt-5 flex items-center gap-1.5 text-xs font-medium text-ink-secondary">
            <Trophy className="h-3.5 w-3.5 text-forge-amber" />TOP 技能包销量榜
          </p>
          {topPacks.length === 0 ? (
            <WbEmpty text="暂无数据" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-left text-sm">
                <thead>
                  <tr className="border-b border-line-subtle text-xs text-ink-faint">
                    <th className="pb-2 pr-3 font-medium">#</th>
                    <th className="pb-2 pr-3 font-medium">技能包</th>
                    <th className="pb-2 font-medium">销量</th>
                  </tr>
                </thead>
                <tbody>
                  {topPacks.map((p, i) => (
                    <tr key={p.packKey ?? p.pack_key ?? i} className="border-b border-line-subtle/60 last:border-0">
                      <td className="py-2.5 pr-3 font-mono text-ink-faint">{i + 1}</td>
                      <td className="py-2.5 pr-3">
                        <p className="text-ink-primary">{p.title ?? p.packKey ?? p.pack_key ?? '—'}</p>
                        <p className="font-mono text-[11px] text-ink-faint">{p.packKey ?? p.pack_key ?? ''}</p>
                      </td>
                      <td className="py-2.5 font-mono text-forge-amber">{num(p.sales)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </WbPanel>
  )
}

export default function AdminAnalytics() {
  return (
    <div>
      <WbPageHeader
        hud="ANALYTICS"
        title="经营分析"
        desc="经营漏斗 · 收入趋势 · 供给侧——全部数字实时来自 adminAnalytics.* 聚合接口。"
      />
      <div className="mb-4 flex items-center gap-1.5 text-[11px] text-ink-faint">
        <BarChart3 className="h-3.5 w-3.5 text-forge-amber" />
        漏斗中「口径待补」表示对应数据表尚未建立，后端以 count=null 返回，不影响其他层级。
      </div>
      <FunnelPanel />
      <RevenuePanel />
      <SupplyPanel />
    </div>
  )
}
