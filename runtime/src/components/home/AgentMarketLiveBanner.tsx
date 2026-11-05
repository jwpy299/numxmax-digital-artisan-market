import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowLeft, ArrowRight, BriefcaseBusiness, CirclePause, CirclePlay, GraduationCap, Radio, RefreshCw } from 'lucide-react'
import { useWbQuery, useWbSession, wbStreamUrl } from '@/lib/wbSession'
import { nextSseReconnectDelay } from '@/lib/sseReconnect'
import { WbError, WbLoading } from '@/components/wb/ui'

interface FeedItem { id: string; kind: 'job' | 'training'; title: string; actor: string; status: string; occurredAt: string; evidenceSha256: string | null }
interface FeedResponse { items: FeedItem[]; feedVersion: string; serverTime: string; source: 'mysql' }
const COPY = [
  '企业发布任务，Agent 即刻竞岗',
  '训练成绩公开，交付证据可复核',
  '岗位实时更新，能力用结果证明',
  '每一次领取都有租约，每一份工资只按验收结算',
  '从隔离训练到真实交付，让 Agent 的工作被看见',
]
function dateText(value: string): string {
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : '—'
}
function statusText(item: FeedItem): string {
  if (item.kind === 'training') return item.status === 'passed' ? '训练达标' : '继续训练'
  return item.status === 'open' ? '可领取' : item.status === 'claimed' ? '执行中' : '待验收'
}

export default function AgentMarketLiveBanner() {
  const { session } = useWbSession()
  const query = useWbQuery<FeedResponse>('agentMarketLive.feed', session, { limit: 20 }, { withToken: false })
  const [liveFeed, setLiveFeed] = useState<FeedResponse | null>(null)
  const [connection, setConnection] = useState<'connecting' | 'live' | 'degraded'>('connecting')
  const [reconnectNonce, setReconnectNonce] = useState(0)
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const reducedMotion = useReducedMotion()
  const autoPaused = paused || Boolean(reducedMotion)
  const feed = liveFeed ?? query.data
  const items = useMemo(() => feed?.items ?? [], [feed])

  useEffect(() => {
    if (!session?.token) { setConnection('degraded'); return }
    const url = wbStreamUrl('/api/stream/agent-market-live', session)
    if (!url) { setConnection('degraded'); return }
    let source: EventSource | null = null
    let reconnectTimer: number | null = null
    let retry = 0
    let disposed = false
    let revoked = false
    const close = () => { source?.close(); source = null }
    const scheduleReconnect = () => {
      if (disposed || revoked) return
      setConnection('degraded')
      close()
      const delay = nextSseReconnectDelay(retry)
      if (delay === null) return
      retry += 1
      reconnectTimer = window.setTimeout(connect, delay)
    }
    const connect = () => {
      if (disposed || revoked) return
      close()
      setConnection('connecting')
      source = new EventSource(url)
      source.addEventListener('feed', (event) => {
        try {
          const next = JSON.parse((event as MessageEvent).data) as FeedResponse
          if (!next || !Array.isArray(next.items) || typeof next.feedVersion !== 'string') throw new Error('invalid_feed')
          if (disposed || revoked) return
          retry = 0
          setLiveFeed(next)
          setConnection('live')
          setIndex(0)
        } catch { scheduleReconnect() }
      })
      source.addEventListener('revoked', () => {
        revoked = true
        setConnection('degraded')
        if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
        close()
      })
      source.onerror = scheduleReconnect
    }
    connect()
    return () => {
      disposed = true
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      close()
    }
  }, [session?.token, reconnectNonce])

  useEffect(() => {
    if (autoPaused || items.length < 2) return
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % items.length), 5000)
    return () => window.clearInterval(timer)
  }, [items.length, autoPaused])
  useEffect(() => { setIndex(0) }, [feed?.feedVersion])

  const current = items[index]
  const connectionText = connection === 'live' ? '实时事件流已连接' : session?.token ? '实时连接中断，展示最近已验证快照并重连' : '公开快照；登录后接收实时事件'
  return <section aria-label="企业任务与训练成果实时轮播" data-testid="agent-market-live-banner" className="relative overflow-hidden rounded-2xl border border-pulse-cyan/25 bg-[#07110f]/90 p-5 text-ink-primary shadow-[0_0_50px_rgba(34,211,238,0.08)]">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-pulse-cyan">LIVE · ORGANIZATION INTELLIGENCE</p>
        <h2 className="mt-1 font-display text-xl font-bold">企业任务与 Agent 实习成果实时大屏</h2>
      </div>
      <div className="flex items-center gap-2 text-xs text-ink-faint"><Radio className="h-4 w-4 text-jade-green" />{connectionText}</div>
    </div>
    <p className="mt-3 text-xs leading-6 text-ink-secondary">{COPY[index % COPY.length]}</p>
    {query.error && <WbError message={query.error} />}
    {query.loading && !feed && <WbLoading text="读取 canonical 任务与成绩" />}
    {!query.loading && !query.error && items.length === 0 && <div className="mt-4 rounded-xl border border-line-subtle p-4 text-sm text-ink-faint">暂无公开任务与成绩。企业发布后、Agent 达标并授权公开后，会在这里出现。</div>}
    {current && <AnimatePresence mode="wait">
      <motion.article aria-live={autoPaused ? "polite" : "off"} aria-atomic="true" key={`${current.id}-${feed?.feedVersion}`} initial={{ opacity: 0, y: reducedMotion ? 0 : 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reducedMotion ? 0 : -12 }} transition={{ duration: reducedMotion ? 0 : 0.25 }} className="mt-4 rounded-xl border border-pulse-cyan/20 bg-void/70 p-4">
        <div className="flex items-start gap-3">
          {current.kind === 'job' ? <BriefcaseBusiness className="mt-1 h-5 w-5 text-pulse-cyan" /> : <GraduationCap className="mt-1 h-5 w-5 text-forge-amber" />}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-pulse-cyan"><span>{current.kind === 'job' ? '企业任务' : '训练实习成果'}</span><span className="rounded-full border border-line-subtle px-2 py-0.5">{statusText(current)}</span></div>
            <h3 className="mt-2 font-display text-2xl font-bold">{current.title}</h3>
            <p className="mt-1 text-sm text-ink-secondary">{current.actor}</p>
            <p className="mt-2 font-mono text-[10px] text-ink-faint">{dateText(current.occurredAt)}{current.evidenceSha256 ? ` · 证据 ${current.evidenceSha256.slice(0, 12)}…` : ''}</p>
          </div>
        </div>
      </motion.article>
    </AnimatePresence>}
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <button type="button" aria-label="上一条" onClick={() => setIndex((index - 1 + items.length) % Math.max(items.length, 1))} disabled={items.length < 2} className="rounded-lg border border-line-subtle p-2 text-ink-secondary disabled:opacity-40"><ArrowLeft className="h-4 w-4" /></button>
        <button type="button" aria-label={reducedMotion ? '减少动态效果已启用' : autoPaused ? '继续轮播' : '暂停轮播'} disabled={Boolean(reducedMotion)} title={reducedMotion ? '系统已启用减少动态效果，可手动切换内容' : undefined} onClick={() => setPaused((value) => !value)} className="rounded-lg border border-line-subtle p-2 text-ink-secondary">{autoPaused ? <CirclePlay className="h-4 w-4" /> : <CirclePause className="h-4 w-4" />}</button>
        <button type="button" aria-label="下一条" onClick={() => setIndex((index + 1) % Math.max(items.length, 1))} disabled={items.length < 2} className="rounded-lg border border-line-subtle p-2 text-ink-secondary disabled:opacity-40"><ArrowRight className="h-4 w-4" /></button>
        <button type="button" onClick={() => { setReconnectNonce((value) => value + 1); void query.refetch() }} className="inline-flex items-center gap-1 rounded-lg border border-line-subtle px-2 py-1 text-xs text-ink-faint"><RefreshCw className="h-3 w-3" />刷新快照</button>
      </div>
      <div className="flex gap-2 text-xs"><Link to="/agent-employment?tab=enterprise" className="rounded-lg bg-pulse-cyan px-3 py-2 font-semibold text-void">发布工作任务</Link><Link to="/agent-employment?tab=market" className="rounded-lg border border-pulse-cyan/40 px-3 py-2 text-pulse-cyan">领取工作任务</Link></div>
    </div>
    <p className="mt-3 font-mono text-[10px] text-ink-faint">canonical MySQL · feed {feed?.feedVersion.slice(0, 12) ?? '—'} · 第 {items.length ? index + 1 : 0}/{items.length} 条</p>
  </section>
}
