/**
 * EvoBoard（/admin/evo-board）—— 进化看板（迭代 35，adminAnalytics.evoBoard）。
 * 四组指标卡：提案通过率 / 平均熟练度 / 反馈采纳率 / LLM 兜底率
 * + 北极星「系统自进化速率」公式展示。
 * 数字全部来自 API（fallbackRate 可能为 null——无日志表）；字段双兼容。
 */
import { Bot, CheckCircle2, MessageSquareHeart, Sparkles, Star } from 'lucide-react'
import { useWbSession, useWbQuery, callWb } from '@/lib/wbSession'
import { useState } from 'react'
import { WbError, WbLoading, WbPageHeader, WbPanel } from '@/components/wb/ui'
import { cn } from '@/lib/utils'

interface EvoResp {
  proposals?: { total?: number; applied?: number; passRate?: number | null; pass_rate?: number | null }
  proficiency?: { avg?: number | null; deltaWeek?: number | null; delta_week?: number | null }
  feedback?: { total?: number; adoptRate?: number | null; adopt_rate?: number | null }
  llm?: { total?: number; fallbackRate?: number | null; fallback_rate?: number | null }
}

function num(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function pctText(v: unknown): string {
  const n = num(v)
  if (n == null) return '—'
  return `${(n <= 1 ? n * 100 : n).toFixed(1)}%`
}
/** 归一化为 0-1（比率），供自进化速率合成；null 不计入 */
function ratio(v: unknown): number | null {
  const n = num(v)
  if (n == null) return null
  return n <= 1 ? n : n / 100
}

function MetricCard({
  icon: Icon,
  toneCls,
  title,
  main,
  sub,
}: {
  icon: typeof Bot
  toneCls: string
  title: string
  main: string
  sub: string
}) {
  return (
    <div className="rounded-xl border border-line-subtle bg-void/40 p-5">
      <p className="flex items-center gap-1.5 text-xs text-ink-faint">
        <Icon className={cn('h-3.5 w-3.5', toneCls)} />
        {title}
      </p>
      <p className={cn('mt-2 font-grotesk text-3xl font-bold', toneCls)}>{main}</p>
      <p className="mt-1 text-xs text-ink-secondary">{sub}</p>
    </div>
  )
}

export default function AdminEvoBoard() {
  const { session } = useWbSession()
  const query = useWbQuery<EvoResp>('adminAnalytics.evoBoard', session, {}, { enabled: !!session?.token })

  const p = query.data?.proposals
  const prof = query.data?.proficiency
  const fb = query.data?.feedback
  const llm = query.data?.llm

  const passRate = p?.passRate ?? p?.pass_rate
  const adoptRate = fb?.adoptRate ?? fb?.adopt_rate
  const fallbackRate = llm?.fallbackRate ?? llm?.fallback_rate
  const deltaWeek = prof?.deltaWeek ?? prof?.delta_week

  // 北极星：系统自进化速率 = 提案通过率 × 反馈采纳率 × (1 − LLM 兜底率)
  // 任一因子为 null（口径缺失）时该因子不计入并标注。
  const factors: { label: string; value: number | null; fmt: string }[] = [
    { label: '提案通过率', value: ratio(passRate), fmt: pctText(passRate) },
    { label: '反馈采纳率', value: ratio(adoptRate), fmt: pctText(adoptRate) },
    {
      label: '(1 − LLM 兜底率)',
      value: fallbackRate == null ? null : 1 - (ratio(fallbackRate) ?? 0),
      fmt: fallbackRate == null ? '—' : pctText(1 - (ratio(fallbackRate) ?? 0)),
    },
  ]
  const available = factors.filter((f) => f.value != null)
  const northStar = available.length === 0 ? null : available.reduce((acc, f) => acc * (f.value ?? 0), 1)

  return (
    <div>
      <WbPageHeader
        hud="EVOLUTION BOARD"
        title="进化看板"
        desc="自进化引擎四组核心指标 + 北极星「系统自进化速率」——全部数字实时来自 adminAnalytics.evoBoard。"
      />
      {query.loading && !query.data ? (
        <WbLoading text="进化指标加载中…" />
      ) : query.error ? (
        <WbError message={query.error} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              icon={Sparkles}
              toneCls="text-forge-amber"
              title="提案通过率"
              main={pctText(passRate)}
              sub={`已采纳 ${p?.applied ?? 0} / 提案总数 ${p?.total ?? 0}`}
            />
            <MetricCard
              icon={CheckCircle2}
              toneCls="text-jade-green"
              title="平均熟练度"
              main={num(prof?.avg) != null ? String(num(prof?.avg)) : '—'}
              sub={`周环比 ${num(deltaWeek) != null ? `${(num(deltaWeek) as number) >= 0 ? '+' : ''}${num(deltaWeek)}` : '—'}`}
            />
            <MetricCard
              icon={MessageSquareHeart}
              toneCls="text-pulse-cyan"
              title="反馈采纳率"
              main={pctText(adoptRate)}
              sub={`反馈总数 ${fb?.total ?? 0}`}
            />
            <MetricCard
              icon={Bot}
              toneCls="text-ember-red"
              title="LLM 兜底率"
              main={fallbackRate == null ? '口径待补' : pctText(fallbackRate)}
              sub={fallbackRate == null ? '进化调用日志表未建立' : `调用总数 ${llm?.total ?? 0}`}
            />
          </div>

          <WbPanel hud="NORTH STAR" title="北极星：系统自进化速率" className="mt-6">
            <div className="flex flex-wrap items-center gap-4 rounded-xl border border-forge-amber/30 bg-forge-amber/[0.05] px-5 py-5">
              <Star className="h-8 w-8 shrink-0 text-forge-amber" />
              <div>
                <p className="font-display text-4xl font-bold text-forge-amber">
                  {northStar == null ? '—' : `${(northStar * 100).toFixed(1)}%`}
                </p>
                <p className="mt-1 text-xs text-ink-secondary">
                  系统自进化速率 = 提案通过率 × 反馈采纳率 × (1 − LLM 兜底率)
                </p>
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {factors.map((f) => (
                <div key={f.label} className="rounded-xl border border-line-subtle bg-void/40 px-4 py-3">
                  <p className="text-[11px] text-ink-faint">{f.label}</p>
                  <p className={cn('mt-1 font-grotesk text-xl font-bold', f.value == null ? 'text-ink-faint' : 'text-ink-primary')}>
                    {f.fmt}
                    {f.value == null && <span className="ml-2 text-[11px] font-normal text-forge-amber">口径待补</span>}
                  </p>
                </div>
              ))}
            </div>
            {available.length < factors.length && (
              <p className="mt-3 text-[11px] text-ink-faint">注：标注「口径待补」的因子未计入合成，待对应数据表建立后自动纳入。</p>
            )}
          </WbPanel>

          <WeeklyReportSection session={session} />
          <CockpitSection session={session} />
        </>
      )}
    </div>
  )
}

// ─── 迭代 62：进化驾驶舱（闭环四段 + 记忆规模）─────────────────────────────

interface CockpitResp {
  feedbackTrend: { date: string; adopted: number; rejected: number }[]
  pendingProposals: { count: number; latest: { id: number; title: string; targetKey: string }[] }
  impactVerdicts: Record<string, number> & { total: number }
  skillHealth: {
    top: { skillKey: string; adoptRate: number | null; adopted: number; rejected: number }[]
    bottom: { skillKey: string; adoptRate: number | null; adopted: number; rejected: number }[]
  }
  memory: { total: number; agents: number; actors: number }
  llmHealth: {
    total: number; fallbacks: number; fallbackRate: number | null
    byContext: { context: string; total: number; fallbacks: number; avgLatencyMs: number }[]
  }
}

const VERDICT_ORDER = ['改善', '持平', '恶化', '观察期', '暂无反馈'] as const

function CockpitSection({ session }: { session: { token: string } | null }) {
  const { data, error, loading } = useWbQuery<CockpitResp>('evo.cockpit', session, {}, { enabled: !!session?.token })
  if (loading && !data) return <WbLoading text="驾驶舱聚合中…" />
  if (error) return <WbError message={error} />
  if (!data) return null
  const maxDay = Math.max(1, ...data.feedbackTrend.map((d) => d.adopted + d.rejected))
  return (
    <WbPanel hud="EVO COCKPIT" title="进化驾驶舱 · 闭环四段" className="mt-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {/* ① 反馈趋势 */}
        <div className="rounded-xl border border-line-subtle bg-void/40 px-4 py-3">
          <p className="text-xs font-medium text-ink-primary">① 反馈趋势（近 14 天）</p>
          <div className="mt-3 space-y-1">
            {data.feedbackTrend.length === 0 && <p className="text-[11px] text-ink-faint">暂无反馈</p>}
            {data.feedbackTrend.map((d) => (
              <div key={d.date} className="flex items-center gap-2 text-[10px] text-ink-faint">
                <span className="w-16 font-mono">{d.date.slice(5)}</span>
                <span className="h-2 rounded-sm bg-jade-green" style={{ width: `${(d.adopted / maxDay) * 60}px` }} />
                <span className="h-2 rounded-sm bg-ember-red" style={{ width: `${(d.rejected / maxDay) * 60}px` }} />
                <span className="font-mono">{d.adopted}采/{d.rejected}驳</span>
              </div>
            ))}
          </div>
        </div>
        {/* ② 在途提案 */}
        <div className="rounded-xl border border-line-subtle bg-void/40 px-4 py-3">
          <p className="text-xs font-medium text-ink-primary">② 在途提案（{data.pendingProposals.count}）</p>
          <div className="mt-3 space-y-1.5">
            {data.pendingProposals.latest.length === 0 && <p className="text-[11px] text-ink-faint">无待审批提案</p>}
            {data.pendingProposals.latest.map((p) => (
              <p key={p.id} className="truncate text-[11px] text-ink-secondary">
                <span className="font-mono text-forge-amber">#{p.id}</span> {p.title}
              </p>
            ))}
          </div>
        </div>
        {/* ③ 应用效果 */}
        <div className="rounded-xl border border-line-subtle bg-void/40 px-4 py-3">
          <p className="text-xs font-medium text-ink-primary">③ 应用效果（{data.impactVerdicts.total} 个已生效）</p>
          <div className="mt-3 space-y-1">
            {VERDICT_ORDER.map((v) => (
              <p key={v} className="flex justify-between text-[11px] text-ink-secondary">
                <span>{v}</span>
                <span className="font-mono text-ink-primary">{data.impactVerdicts[v] ?? 0}</span>
              </p>
            ))}
          </div>
        </div>
        {/* ④ 技能健康榜 */}
        <div className="rounded-xl border border-line-subtle bg-void/40 px-4 py-3">
          <p className="text-xs font-medium text-ink-primary">④ 技能健康榜</p>
          <div className="mt-3 space-y-1">
            {data.skillHealth.top.map((s) => (
              <p key={s.skillKey} className="flex justify-between text-[11px] text-ink-secondary">
                <span className="font-mono">{s.skillKey}</span>
                <span className="font-mono text-jade-green">{s.adoptRate}%</span>
              </p>
            ))}
            {data.skillHealth.bottom.map((s) => (
              <p key={s.skillKey} className="flex justify-between text-[11px] text-ink-secondary">
                <span className="font-mono">{s.skillKey}</span>
                <span className="font-mono text-ember-red">{s.adoptRate}%</span>
              </p>
            ))}
            {data.skillHealth.top.length === 0 && <p className="text-[11px] text-ink-faint">暂无采纳样本</p>}
          </div>
        </div>
        {/* ⑤ 记忆规模 */}
        <div className="rounded-xl border border-line-subtle bg-void/40 px-4 py-3">
          <p className="text-xs font-medium text-ink-primary">⑤ 个体记忆规模</p>
          <p className="mt-3 font-mono text-2xl text-ink-primary">{data.memory.total}</p>
          <p className="mt-1 text-[11px] text-ink-faint">
            覆盖 {data.memory.agents} 位员工 / {data.memory.actors} 位对话对象
          </p>
        </div>
        {/* ⑥ LLM 兜底率（迭代64） */}
        <div className="rounded-xl border border-line-subtle bg-void/40 px-4 py-3">
          <p className="text-xs font-medium text-ink-primary">⑥ 进化链 LLM 兜底率（近 14 天）</p>
          {data.llmHealth.total === 0 ? (
            <p className="mt-3 text-[11px] text-ink-faint">暂无调用记录</p>
          ) : (
            <>
              <p className="mt-3 font-mono text-2xl text-ink-primary">
                {data.llmHealth.fallbackRate === null ? '—' : `${data.llmHealth.fallbackRate}%`}
              </p>
              <p className="mt-1 text-[11px] text-ink-faint">
                调用 {data.llmHealth.total} 次 / 兜底 {data.llmHealth.fallbacks} 次
              </p>
              <div className="mt-2 space-y-1">
                {data.llmHealth.byContext.map((c) => (
                  <p key={c.context} className="text-[10px] text-ink-faint">
                    {c.context === 'weekly_report' ? '周报' : c.context === 'auto_draft' ? '差评提案' : c.context}
                    ：{c.total} 次 / 兜底 {c.fallbacks} / 均延 {c.avgLatencyMs}ms
                  </p>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </WbPanel>
  )
}

// ─── 迭代 67：进化周报上墙（最新一期 + 重新生成）────────────────────────────

interface EvoReportItem {
  id: number
  week: string
  content: string
  stats: {
    feedback?: { useful?: number; useless?: number; rework?: number }
    orders7d?: number
    apiCalls7d?: number
    alertsOpen?: number
    llm?: { total: number; fallbacks: number } | null
  } | null
  createdAt: unknown
  updatedAt?: unknown
}

function WeeklyReportSection({ session }: { session: { token: string } | null }) {
  const { data, error, loading, refetch } = useWbQuery<EvoReportItem[]>('evo.reports', session, {}, { enabled: !!session?.token })
  const [regenBusy, setRegenBusy] = useState(false)
  const [note, setNote] = useState('')
  const latest = data?.[0] ?? null
  if (loading && !data) return <WbLoading text="进化周报加载中…" />
  if (error) return <WbError message={error} />
  const regenerate = async () => {
    if (!session?.token || regenBusy) return
    setRegenBusy(true)
    setNote('')
    try {
      const r = await callWb<{ week: string }>('mutation', 'evo.generateReport', session, {})
      await refetch()
      setNote(`已重新生成 ${r.week} 周报`)
    } catch (e) {
      setNote(`生成失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRegenBusy(false)
    }
  }
  return (
    <WbPanel hud="EVO WEEKLY" title="进化周报（最新一期）" className="mt-6"
      actions={
        <button
          onClick={regenerate}
          disabled={regenBusy}
          className="rounded-lg border border-pulse-cyan/40 bg-pulse-cyan/10 px-3 py-1 text-xs text-pulse-cyan transition-colors hover:bg-pulse-cyan/20 disabled:opacity-50"
        >
          {regenBusy ? '生成中…' : '重新生成本周'}
        </button>
      }
    >
      {!latest ? (
        <p className="text-[11px] text-ink-faint">暂无周报：每周一 08:00 自动生成，或点击右上「重新生成本周」。</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-faint">
            <span className="font-mono text-pulse-cyan">{latest.week}</span>
            <span>生成于 {latest.createdAt ? new Date(String(latest.createdAt)).toLocaleString('zh-CN') : '—'}</span>
            {!!latest.updatedAt && String(latest.updatedAt) !== String(latest.createdAt) && (
              <span>更新于 {new Date(String(latest.updatedAt)).toLocaleString('zh-CN')}</span>
            )}
            {latest.stats?.feedback && (
              <span>
                反馈 有用 {latest.stats.feedback.useful ?? 0} / 没用 {latest.stats.feedback.useless ?? 0} / 返工 {latest.stats.feedback.rework ?? 0}
                {typeof latest.stats.orders7d === 'number' && ` · 近7天订单 ${latest.stats.orders7d}`}
                {typeof latest.stats.apiCalls7d === 'number' && ` · API ${latest.stats.apiCalls7d}`}
                {typeof latest.stats.alertsOpen === 'number' && ` · 未关闭预警 ${latest.stats.alertsOpen}`}
                {latest.stats.llm && ` · LLM 调用 ${latest.stats.llm.total} 次/兜底 ${latest.stats.llm.fallbacks} 次`}
              </span>
            )}
          </div>
          <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-ink-primary">{latest.content}</p>
        </>
      )}
      {note && <p className="mt-2 text-[11px] text-forge-amber">{note}</p>}
    </WbPanel>
  )
}
