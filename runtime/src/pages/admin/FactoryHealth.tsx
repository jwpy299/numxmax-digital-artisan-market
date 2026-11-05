/**
 * FactoryHealth（/admin/health）—— 企业健康度（迭代 35，adminAnalytics.factoryHealth）。
 * 汇总三卡（正常/黄/红）+ 企业表格（健康分色阶、按 silentLevel 筛选）。
 * score 0-100 由后端确定性公式计算；字段 camelCase/snake_case 双兼容。
 */
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Building2, Eye, HeartPulse } from 'lucide-react'
import { useWbSession, useWbQuery } from '@/lib/wbSession'
import { WbEmpty, WbError, WbLoading, WbPageHeader, WbPanel } from '@/components/wb/ui'
import { cn } from '@/lib/utils'

interface HealthItem {
  factoryId?: number
  factory_id?: number
  name?: string
  score?: number
  activeDays30?: number
  active_days_30?: number
  tasks?: number
  feedbacks?: number
  pkgExpiresAt?: string | null
  pkg_expires_at?: string | null
  silentLevel?: 'ok' | 'warn' | 'critical'
  silent_level?: 'ok' | 'warn' | 'critical'
  lastActiveAt?: string | null
  last_active_at?: string | null
}
interface HealthResp {
  items?: HealthItem[]
  summary?: { ok?: number; warn?: number; critical?: number }
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
function levelOf(it: HealthItem): 'ok' | 'warn' | 'critical' {
  const l = it.silentLevel ?? it.silent_level ?? 'ok'
  return l === 'warn' || l === 'critical' ? l : 'ok'
}

const LEVEL_META = {
  ok: { label: '正常', cls: 'border-jade-green/40 bg-jade-green/10 text-jade-green' },
  warn: { label: '沉默预警', cls: 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber' },
  critical: { label: '严重沉默', cls: 'border-ember-red/40 bg-ember-red/10 text-ember-red' },
} as const

function scoreCls(score: number): string {
  if (score >= 70) return 'text-jade-green'
  if (score >= 40) return 'text-forge-amber'
  return 'text-ember-red'
}
function scoreBarCls(score: number): string {
  if (score >= 70) return 'bg-jade-green/60'
  if (score >= 40) return 'bg-forge-amber/60'
  return 'bg-ember-red/60'
}

type FilterKey = 'all' | 'ok' | 'warn' | 'critical'

export default function AdminFactoryHealth() {
  const { session } = useWbSession()
  const navigate = useNavigate()
  const [filter, setFilter] = useState<FilterKey>('all')
  const query = useWbQuery<HealthResp>('adminAnalytics.factoryHealth', session, {}, { enabled: !!session?.token })
  const items = query.data?.items ?? []
  const summary = query.data?.summary
  const shown = filter === 'all' ? items : items.filter((it) => levelOf(it) === filter)

  const FILTERS: { key: FilterKey; label: string; count: number | undefined }[] = [
    { key: 'all', label: '全部', count: items.length },
    { key: 'ok', label: '正常', count: summary?.ok },
    { key: 'warn', label: '沉默预警', count: summary?.warn },
    { key: 'critical', label: '严重沉默', count: summary?.critical },
  ]

  return (
    <div>
      <WbPageHeader
        hud="FACTORY HEALTH"
        title="企业健康度"
        desc="健康分 0-100（活跃 40 + 任务 30 + 反馈 20 + 套餐有效性 10，后端确定性公式）；沉默分级：ok / warn / critical。"
      />
      {query.loading && !query.data ? (
        <WbLoading text="企业健康度加载中…" />
      ) : query.error ? (
        <WbError message={query.error} />
      ) : (
        <>
          <div className="mb-5 grid gap-4 sm:grid-cols-3">
            {(['ok', 'warn', 'critical'] as const).map((k) => (
              <div key={k} className={cn('rounded-xl border p-5', LEVEL_META[k].cls.split(' ').slice(0, 2).join(' '), 'border-line-subtle bg-void/40')}>
                <p className="flex items-center gap-1.5 text-xs text-ink-faint">
                  <HeartPulse className={cn('h-3.5 w-3.5', LEVEL_META[k].cls.split(' ').pop())} />
                  {LEVEL_META[k].label}
                </p>
                <p className={cn('mt-2 font-grotesk text-3xl font-bold', LEVEL_META[k].cls.split(' ').pop())}>
                  {num(summary?.[k])}
                </p>
                <p className="mt-1 text-[11px] text-ink-faint">家企业</p>
              </div>
            ))}
          </div>

          <WbPanel
            hud="FACTORY LIST"
            title="企业健康明细"
            actions={
              <div className="flex gap-1.5">
                {FILTERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setFilter(f.key)}
                    className={cn(
                      'rounded-lg border px-3 py-1 text-xs transition-colors duration-300',
                      filter === f.key
                        ? 'border-forge-amber/50 bg-forge-amber/10 text-forge-amber'
                        : 'border-line-subtle text-ink-secondary hover:border-pulse-cyan/50 hover:text-ink-primary',
                    )}
                  >
                    {f.label}{f.count != null ? ` ${f.count}` : ''}
                  </button>
                ))}
              </div>
            }
          >
            {shown.length === 0 ? (
              <WbEmpty text="暂无数据" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-line-subtle text-xs text-ink-faint">
                      <th className="pb-2 pr-3 font-medium">企业</th>
                      <th className="pb-2 pr-3 font-medium">健康分</th>
                      <th className="pb-2 pr-3 font-medium">近30天活跃</th>
                      <th className="pb-2 pr-3 font-medium">任务</th>
                      <th className="pb-2 pr-3 font-medium">反馈</th>
                      <th className="pb-2 pr-3 font-medium">套餐到期</th>
                      <th className="pb-2 pr-3 font-medium">最后活跃</th>
                      <th className="pb-2 pr-3 font-medium">沉默级别</th>
                      <th className="pb-2 font-medium">上帝视角</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((it) => {
                      const score = num(it.score)
                      const lv = levelOf(it)
                      const pkgExp = it.pkgExpiresAt ?? it.pkg_expires_at
                      const lastActive = it.lastActiveAt ?? it.last_active_at
                      return (
                        <tr key={it.factoryId ?? it.factory_id ?? it.name} className="border-b border-line-subtle/60 last:border-0">
                          <td className="py-2.5 pr-3">
                            <p className="flex items-center gap-1.5 text-ink-primary">
                              <Building2 className="h-3.5 w-3.5 shrink-0 text-pulse-cyan" />
                              {it.name ?? '—'}
                            </p>
                            <p className="font-mono text-[11px] text-ink-faint">#{it.factoryId ?? it.factory_id ?? '—'}</p>
                          </td>
                          <td className="py-2.5 pr-3">
                            <div className="flex items-center gap-2">
                              <span className={cn('font-mono text-sm font-bold', scoreCls(score))}>{score}</span>
                              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-void/80">
                                <div className={cn('h-full rounded-full', scoreBarCls(score))} style={{ width: `${Math.min(100, Math.max(0, score))}%` }} />
                              </div>
                            </div>
                          </td>
                          <td className="py-2.5 pr-3 font-mono text-ink-secondary">{num(it.activeDays30 ?? it.active_days_30)} 天</td>
                          <td className="py-2.5 pr-3 font-mono text-ink-secondary">{num(it.tasks)}</td>
                          <td className="py-2.5 pr-3 font-mono text-ink-secondary">{num(it.feedbacks)}</td>
                          <td className="py-2.5 pr-3 font-mono text-[11px] text-ink-faint">
                            {pkgExp ? new Date(String(pkgExp)).toLocaleDateString('zh-CN') : '—'}
                          </td>
                          <td className="py-2.5 pr-3 font-mono text-[11px] text-ink-faint">
                            {lastActive ? new Date(String(lastActive)).toLocaleString('zh-CN', { hour12: false }) : '—'}
                          </td>
                          <td className="py-2.5 pr-3">
                            <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px]', LEVEL_META[lv].cls)}>
                              {LEVEL_META[lv].label}
                            </span>
                          </td>
                          <td className="py-2.5">
                            <button
                              type="button"
                              onClick={() => navigate(`/admin/god/${it.factoryId ?? it.factory_id}`)}
                              disabled={!(it.factoryId ?? it.factory_id)}
                              className="inline-flex items-center gap-1 rounded-md border border-line-subtle px-2.5 py-1 text-[11px] text-ink-secondary transition-colors hover:border-forge-amber/50 hover:text-forge-amber disabled:opacity-40"
                            >
                              <Eye className="h-3 w-3" /> 上帝视角
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </WbPanel>
        </>
      )}
    </div>
  )
}
