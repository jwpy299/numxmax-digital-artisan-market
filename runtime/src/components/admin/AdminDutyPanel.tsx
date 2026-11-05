/**
 * AdminDutyPanel —— 灵枢值守台（M7-e，/admin/cockpit 内嵌）。
 *
 * 三块：
 * 1. 晨报卡：adminAi.dutyBriefing（真实平台数据 + LLM 晨报，降级标注）；
 * 2. 追问：M8-c 优先 EventSource 打 /api/stream/duty-chat（facts 即时渲染为要点条，
 *    reply 打字机接续）；EventSource 不可用/网络失败时降级回原 tRPC dutyChat；
 * 3. 规划器监管看板：adminAi.plannerStats（计划量/状态分布/成功率/失败率 + 越权拒签按通道分布）。
 *
 * M9-a：实况 chips 区下方挂事件流（GET /api/stream/events 主动播报，灵枢/星云口吻），
 * SSE 断线时原 useWbQuery 手动刷新仍可用作降级。
 */
import { useEffect, useState } from 'react'
import { BrainCircuit, Loader2, Radio, RefreshCw, Send, ShieldCheck } from 'lucide-react'
import { callWb, useWbQuery, useWbSession, wbErrorMessage, wbStreamUrl } from '@/lib/wbSession'
import { WbEmpty, WbPanel } from '@/components/wb/ui'
import { cn } from '@/lib/utils'

interface DutyBriefingResp {
  briefing: string
  degraded: boolean
  brief: {
    pendingProtocols: { code: string; name: string; level: string; status: string }[]
    openSignals24h: { levelB: number; levelC: number; levelD: number }
    plans: { total: number; today: number; executed: number; pendingConfirm: number; failed: number }
    silentFactories7d: { id: number; name: string }[]
    frozenFactories: number
  }
  generatedAt: string
}

interface PlannerStatsResp {
  plans: { total: number; byStatus: Record<string, number>; successRate: number | null; failureRate: number | null }
  daily: { date: string; count: number }[]
  rejectedByChannel: { channel: string; count: number }[]
}

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  submitted: '待确认',
  executed: '已执行',
  pending_confirm: '子步骤待确认',
  failed: '失败',
  rejected: '已拒签',
  cancelled: '已撤销',
}

const CHANNEL_LABEL: Record<string, string> = {
  voice: '语音通道',
  'ai:planner': 'AI 规划器',
  human: '人工提交',
}

/** 追问条目（M8-c：facts 要点条先行，reply 打字机接续） */
interface ChatItem {
  q: string
  a: string
  facts?: string[]
  degraded?: boolean
  live?: boolean
}

/** M9-a 主动播报事件条 */
interface BroadcastItem {
  level: string
  persona: string
  title: string
  at: string
}

const PERSONA_LABEL: Record<string, string> = { lingshu: '灵枢', xingyun: '星云' }

export default function AdminDutyPanel() {
  const { session } = useWbSession()
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [chatErr, setChatErr] = useState<string | null>(null)
  const [chat, setChat] = useState<ChatItem[]>([])
  const [events, setEvents] = useState<BroadcastItem[]>([])

  const briefing = useWbQuery<DutyBriefingResp>('adminAi.dutyBriefing', session, {}, { enabled: !!session?.token })
  const stats = useWbQuery<PlannerStatsResp>('adminAi.plannerStats', session, {}, { enabled: !!session?.token })

  // M9-a：事件驱动主动播报（EventSource 订阅；断线 EventSource 自动重连，
  // 彻底失败时上方晨报/看板的 useWbQuery 手动刷新仍可用作降级）
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const url = wbStreamUrl('/api/stream/events', session)
    if (!url) return
    const es = new EventSource(url)
    es.addEventListener('broadcast', (e) => {
      try {
        const msg = JSON.parse((e as MessageEvent).data) as BroadcastItem
        setEvents((prev) => [msg, ...prev].slice(0, 5))
      } catch {
        /* 坏帧忽略 */
      }
    })
    es.addEventListener('error', () => {
      // 网络错误时 EventSource 自行重连；服务端明确关闭（CLOSED）则放弃，回落手动刷新
      if (es.readyState === EventSource.CLOSED) es.close()
    })
    return () => es.close()
  }, [session?.token]) // eslint-disable-line react-hooks/exhaustive-deps

  /** 追问兜底：原 tRPC dutyChat（patchLast=true 时覆盖流式占位条目） */
  const askViaTrpc = async (q: string, patchLast: boolean) => {
    const patch = (item: Partial<ChatItem>) =>
      setChat((prev) => prev.map((c, i) => (i === prev.length - 1 ? { ...c, ...item } : c)))
    try {
      const r = await callWb<{ reply: string; facts?: string[]; degraded?: boolean }>(
        'mutation',
        'adminAi.dutyChat',
        session,
        { message: q },
      )
      if (patchLast) patch({ a: r.reply, facts: r.facts ?? [], degraded: r.degraded, live: false })
      else setChat((prev) => [...prev, { q, a: r.reply, facts: r.facts ?? [], degraded: r.degraded }])
      setQuestion('')
    } catch (e) {
      setChatErr(wbErrorMessage(e))
      if (patchLast) patch({ live: false })
    } finally {
      setAsking(false)
    }
  }

  const ask = async () => {
    const q = question.trim()
    if (!q || asking || !session) return
    setAsking(true)
    setChatErr(null)
    // M8-c：优先 EventSource 流式（facts 即时渲染，reply 打字机接续）
    const url = typeof EventSource !== 'undefined' ? wbStreamUrl('/api/stream/duty-chat', session, { message: q }) : null
    if (!url) {
      await askViaTrpc(q, false) // 不支持 SSE → 原 tRPC 兜底
      return
    }
    setQuestion('')
    setChat((prev) => [...prev, { q, a: '', facts: [], live: true }])
    const patch = (item: Partial<ChatItem>) =>
      setChat((prev) => prev.map((c, i) => (i === prev.length - 1 ? { ...c, ...item } : c)))
    const es = new EventSource(url)
    let settled = false
    es.addEventListener('facts', (e) => {
      try {
        const { facts } = JSON.parse((e as MessageEvent).data) as { facts?: string[] }
        patch({ facts: facts ?? [] })
      } catch {
        /* 坏帧忽略 */
      }
    })
    es.addEventListener('delta', (e) => {
      try {
        const { text } = JSON.parse((e as MessageEvent).data) as { text?: string }
        if (text) setChat((prev) => prev.map((c, i) => (i === prev.length - 1 ? { ...c, a: c.a + text } : c)))
      } catch {
        /* 坏帧忽略 */
      }
    })
    es.addEventListener('done', (e) => {
      settled = true
      try {
        const { degraded } = JSON.parse((e as MessageEvent).data) as { degraded?: boolean }
        patch({ live: false, degraded: !!degraded })
      } catch {
        patch({ live: false })
      }
      es.close()
      setAsking(false)
    })
    es.addEventListener('error', (e) => {
      // 服务端 error 帧是带 data 的 MessageEvent；网络错误是无 data 的 Event（降级 tRPC）
      const data = (e as MessageEvent).data
      if (typeof data === 'string' && data) {
        settled = true
        patch({ live: false, degraded: true })
        es.close()
        setAsking(false)
        return
      }
      if (settled) return
      settled = true
      es.close()
      void askViaTrpc(q, true)
    })
  }

  const b = briefing.data?.brief

  return (
    <WbPanel hud="DUTY" title="灵枢值守台">
      {/* 晨报卡 */}
      <div className="rounded-xl border border-pulse-cyan/30 bg-pulse-cyan/5 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-pulse-cyan" />
            <span className="text-sm font-semibold text-ink-primary">值守晨报</span>
            {briefing.data?.degraded && (
              <span className="rounded-full border border-forge-amber/50 px-2 py-0.5 text-[10px] text-forge-amber">
                规则降级（LLM 不可用）
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => briefing.refetch()}
            className="rounded-lg p-1.5 text-ink-muted transition-colors hover:bg-[#322A21] hover:text-pulse-cyan"
            title="重新生成晨报"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', briefing.loading && 'animate-spin')} />
          </button>
        </div>
        {briefing.loading && !briefing.data && <p className="mt-3 text-xs text-ink-muted">灵枢正在汇总平台实况…</p>}
        {briefing.data && (
          <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-ink-primary">{briefing.data.briefing}</p>
        )}
        {b && (
          <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
            <span className="rounded-full border border-[#4A3F33] bg-[#1E1913] px-2 py-0.5 text-[#B8A98F]">
              待评审协议 {b.pendingProtocols.length}
            </span>
            <span
              className={cn(
                'rounded-full border px-2 py-0.5',
                b.openSignals24h.levelD > 0
                  ? 'border-ember-red/50 bg-ember-red/10 text-ember-red'
                  : 'border-[#4A3F33] bg-[#1E1913] text-[#B8A98F]',
              )}
            >
              D级信号 {b.openSignals24h.levelD}
            </span>
            <span
              className={cn(
                'rounded-full border px-2 py-0.5',
                b.openSignals24h.levelC > 0
                  ? 'border-forge-amber/50 bg-forge-amber/10 text-forge-amber'
                  : 'border-[#4A3F33] bg-[#1E1913] text-[#B8A98F]',
              )}
            >
              C级信号 {b.openSignals24h.levelC}
            </span>
            <span className="rounded-full border border-[#4A3F33] bg-[#1E1913] px-2 py-0.5 text-[#B8A98F]">
              沉默企业 {b.silentFactories7d.length}
            </span>
            <span className="rounded-full border border-[#4A3F33] bg-[#1E1913] px-2 py-0.5 text-[#B8A98F]">
              冻结中 {b.frozenFactories}
            </span>
          </div>
        )}
        {/* M9-a：事件流提示（主动播报；断线时上方数据仍可手动刷新） */}
        {events.length > 0 && (
          <div className="mt-2 space-y-1 border-t border-[#3A3026] pt-2">
            {events.map((ev, i) => (
              <div key={i} className="flex items-start gap-1.5 text-[11px] leading-snug">
                <Radio
                  className={cn(
                    'mt-0.5 h-3 w-3 shrink-0',
                    ev.persona === 'lingshu' ? 'text-pulse-cyan' : 'text-nebula-violet',
                  )}
                />
                <span className="text-ink-muted">
                  {PERSONA_LABEL[ev.persona] ?? '播报'} · {ev.level}级
                </span>
                <span className="min-w-0 flex-1 text-[#B8A98F]">{ev.title}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 追问 */}
      <div className="mt-3">
        {chat.map((c, i) => (
          <div key={i} className="mb-2 space-y-1">
            <p className="text-xs text-ink-muted">你：{c.q}</p>
            {c.facts && c.facts.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {c.facts.map((f, j) => (
                  <span
                    key={j}
                    className="rounded-full border border-[#4A3F33] bg-[#1E1913] px-2 py-0.5 text-[10px] text-[#B8A98F]"
                  >
                    {f}
                  </span>
                ))}
              </div>
            )}
            <p className="whitespace-pre-line rounded-xl rounded-bl-md border border-[#3A3026] bg-[#2A231C] px-3 py-2 text-sm text-[#E8DFD1]">
              {c.a}
              {c.live && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-pulse-cyan/70" />}
              {c.degraded && !c.live && (
                <span className="ml-2 rounded-full border border-forge-amber/50 px-1.5 py-0.5 text-[10px] text-forge-amber">
                  降级
                </span>
              )}
            </p>
          </div>
        ))}
        {chatErr && <p className="mb-2 text-xs text-ember-red">{chatErr}</p>}
        <div className="flex items-center gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') ask()
            }}
            placeholder="追问灵枢：今天最该先处理什么？"
            className="min-w-0 flex-1 rounded-xl border border-[#4A3F33] bg-[#1E1913] px-3 py-2 text-sm text-ink-primary placeholder:text-[#7A6C57] focus:border-pulse-cyan/50 focus:outline-none"
          />
          <button
            type="button"
            onClick={ask}
            disabled={asking || !question.trim()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-pulse-cyan/20 text-pulse-cyan transition-colors hover:bg-pulse-cyan/30 disabled:opacity-40"
          >
            {asking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* 规划器监管看板 */}
      <div className="mt-4 rounded-xl border border-[#3A3026] bg-[#241E18] p-4">
        <div className="flex items-center gap-2">
          <BrainCircuit className="h-4 w-4 text-nebula-violet" />
          <span className="text-sm font-semibold text-ink-primary">规划器监管</span>
          <span className="text-[11px] text-ink-muted">AI 信用治理入口</span>
        </div>
        {stats.loading && !stats.data && <p className="mt-3 text-xs text-ink-muted">加载中…</p>}
        {stats.data && (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-lg bg-[#1E1913] p-2 text-center">
                <p className="text-lg font-bold text-ink-primary">{stats.data.plans.total}</p>
                <p className="text-[10px] text-ink-muted">计划总量</p>
              </div>
              <div className="rounded-lg bg-[#1E1913] p-2 text-center">
                <p className="text-lg font-bold text-jade-green">{stats.data.plans.successRate ?? '—'}%</p>
                <p className="text-[10px] text-ink-muted">执行成功率</p>
              </div>
              <div className="rounded-lg bg-[#1E1913] p-2 text-center">
                <p className="text-lg font-bold text-ember-red">{stats.data.plans.failureRate ?? '—'}%</p>
                <p className="text-[10px] text-ink-muted">失败/拒签率</p>
              </div>
              <div className="rounded-lg bg-[#1E1913] p-2 text-center">
                <p className="text-lg font-bold text-forge-amber">{stats.data.plans.byStatus['pending_confirm'] ?? 0}</p>
                <p className="text-[10px] text-ink-muted">子步骤待确认</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
              {Object.entries(stats.data.plans.byStatus).map(([k, v]) => (
                <span key={k} className="rounded-full border border-[#4A3F33] bg-[#1E1913] px-2 py-0.5 text-[#B8A98F]">
                  {STATUS_LABEL[k] ?? k} {v}
                </span>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-ink-muted">
              近 30 天意图拒签（越权拦截）：
              {stats.data.rejectedByChannel.length === 0
                ? ' 无'
                : stats.data.rejectedByChannel
                    .map((r) => `${CHANNEL_LABEL[r.channel] ?? r.channel} ${r.count} 次`)
                    .join(' · ')}
            </p>
          </>
        )}
        {stats.error && <WbEmpty text="监管数据加载失败" hint={stats.error} />}
      </div>
    </WbPanel>
  )
}
