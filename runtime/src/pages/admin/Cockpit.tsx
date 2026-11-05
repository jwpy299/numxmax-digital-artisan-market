/**
 * Cockpit（/admin/cockpit）—— 广东灵智枢生态科技有限公司「灵智枢智能运营」总经理驾驶舱。
 * terminal.cockpit 聚合统一库两系统 KPI + 系统健康 + 部门/Agent 阵列；
 * 「生成智能简报」走 terminal.briefing（LLM，失败自动规则降级并标注）；
 * iter89「AI 参谋 · 枢总」面板走 terminal.gmChat（问数/派活，技能产出物可下载）。
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Send, Sparkles } from 'lucide-react'
import { useWbSession, useWbQuery, wbMutation, wbErrorMessage } from '@/lib/wbSession'
import { STATION_TAB_EVOL, stationQueueUrl, ROUTE_ADMIN_APPROVALS, ROUTE_ADMIN_PROTOCOLS, ROUTE_ADMIN_AGENT_REVIEW_QUEUE } from '@/lib/adminStations'
import { WbButton, WbError, WbLoading, WbPageHeader, WbPanel, WbStat, wbInputCls } from '@/components/wb/ui'
import { adminConfirm, ProviderTag, SendingIndicator } from './shared'
import AdminDutyPanel from '@/components/admin/AdminDutyPanel'
import DshRuntimePanel from '@/components/admin/DshRuntimePanel'
import DshGovernancePanel from '@/components/dsh/DshGovernancePanel'
import { ArtifactChips, type ChatArtifact } from '@/components/ArtifactChips'
import { cn } from '@/lib/utils'

/** P2-6：意图信号面数据 */
interface IntentSignalsData {
  agg: { kind: string; action: string; cnt: number; fails: number; avgMs: number | null }[]
  feed: { id: number; actor: string; kind: string; action: string; ok: number; latencyMs: number | null; detail: string; createdAt: string }[]
  total24h: number
}

interface CockpitData {
  kpis: {
    userTotal: number
    enterpriseUserTotal: number
    factoryTotal: number
    agentTotal: number
    activeAgentTotal: number
    hireOrderTotal: number
    openRecruitmentTotal: number
    tokenFlowTotal: number
    tokenPlatformFeeTotal: number
  }
  pendingBoard?: { approvals: number; proposals: number; reviews: number; alertsToday: number } // R5 票③：可选——滚动部署旧 API 无字段不崩页
  health: {
    portal: { url: string; httpCode: number; latencyMs: number; ok: boolean }
    workbench: { url: string; httpCode: number; latencyMs: number; ok: boolean }
    database: { ok: boolean; latencyMs: number }
  }
  departments: { id: number; code: string; name: string; duty: string; agentCount?: number }[]
  agents: {
    id: number
    deptCode: string
    code: string
    name: string
    title: string
    avatarEmoji: string
    status: string
  }[]
  /** v147 北极星（B主C校验A辅助）：字典+周验收交付数事实值 */
  northStar?: {
    key: string
    layer: 'north_star' | 'verify' | 'auxiliary' | 'guard' | 'input'
    name: string
    direction: string
    currentValue: number | null
    ownerDept: string | null
  }[]
  weeklyVerifiedDeliveries?: number
  digest: string
}

interface BriefingResult {
  content: string
  provider: string | null
  model: string | null
  degraded: boolean
  generatedAt: string
}

// ─── iter89：AI 参谋「枢总」聊天面板 ─────────────────────────────────────────
const GM_GREETING = '总经理好，我是枢总参谋，数据已就位，您可以直接问数或派活。'

interface GmMessage {
  role: 'user' | 'agent'
  content: string
  provider?: string | null
  model?: string | null
  degraded?: boolean
  artifact?: ChatArtifact | null
  usedSkills?: string[]
}

interface GmChatResult {
  reply: string
  threadId: number
  provider: string | null
  model: string | null
  degraded: boolean
  artifact?: ChatArtifact | null
  usedSkills?: string[]
}

function GmAdvisorPanel() {
  const { session } = useWbSession()
  const [messages, setMessages] = useState<GmMessage[]>([{ role: 'agent', content: GM_GREETING }])
  const [threadId, setThreadId] = useState<number | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, sending])

  async function handleSend() {
    const content = input.trim()
    if (!content || !session?.token || sending) return
    if (!adminConfirm('发送给枢总参谋（将结合驾驶舱实时数据调用大模型）')) return
    setInput('')
    setError(null)
    setMessages((prev) => [...prev, { role: 'user', content }])
    setSending(true)
    try {
      const res = await wbMutation<GmChatResult>('terminal.gmChat', {
        token: session.token,
        message: content,
        ...(threadId ? { threadId } : {}),
      })
      setThreadId(res.threadId)
      setMessages((prev) => [
        ...prev,
        {
          role: 'agent',
          content: res.reply,
          provider: res.provider,
          model: res.model,
          degraded: res.degraded,
          artifact: res.artifact ?? null,
          usedSkills: res.usedSkills ?? [],
        },
      ])
    } catch (err) {
      setError(wbErrorMessage(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex min-h-[360px] flex-col">
      <div className="max-h-[420px] flex-1 space-y-3 overflow-y-auto rounded-xl border border-line-subtle bg-void/40 p-4">
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={`u-${i}`} className="flex justify-end">
              <div className="max-w-[75%] rounded-xl rounded-br-sm border border-forge-amber/30 bg-forge-amber/[0.12] px-3.5 py-2.5">
                <p className="whitespace-pre-line text-sm leading-relaxed text-ink-primary">{m.content}</p>
              </div>
            </div>
          ) : (
            <div key={`a-${i}`} className="flex justify-start">
              <div className="max-w-[80%] rounded-xl rounded-bl-sm border border-line-subtle bg-panel/70 px-3.5 py-2.5">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-sm">🧭</span>
                  <span className="text-xs font-medium text-ink-secondary">枢总 · 总经理参谋</span>
                  <ProviderTag provider={m.provider} model={m.model} degraded={m.degraded} />
                </div>
                <p className="whitespace-pre-line text-sm leading-relaxed text-ink-primary">{m.content}</p>
                {m.usedSkills && m.usedSkills.length > 0 && (
                  <p className="mt-1.5 text-[10px] text-pulse-cyan">使用技能：{m.usedSkills.join('、')}</p>
                )}
                {m.artifact && session?.token && (
                  <ArtifactChips
                    token={session.token}
                    artifacts={[m.artifact]}
                    onRevise={(a) => setInput(`请修改刚才生成的《${a.title}》：`)}
                  />
                )}
              </div>
            </div>
          ),
        )}
        {sending && <SendingIndicator avatar="🧭" name="枢总" />}
        <div ref={bottomRef} />
      </div>
      <WbError message={error} className="mt-3" />
      <div className="mt-3 flex gap-2">
        <input
          className={wbInputCls}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleSend()
          }}
          placeholder="问数：本周经营重点？/ 派活：生成一份总经理周报"
          disabled={sending}
          maxLength={2000}
        />
        <WbButton onClick={handleSend} loading={sending} disabled={sending || !input.trim()}>
          <Send className="h-4 w-4" />
          发送
        </WbButton>
      </div>
    </div>
  )
}

function HealthChip({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs',
        ok
          ? 'border-jade-green/40 bg-jade-green/[0.08] text-jade-green'
          : 'border-ember-red/40 bg-ember-red/[0.08] text-ember-red',
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', ok ? 'bg-jade-green' : 'bg-ember-red')} />
      {label}
      <span className="text-ink-faint">{detail}</span>
    </span>
  )
}

/** 三态符号（R29 票④：boardTone/alertTone 共享——>0=1、0=0、<0=-1） */
function triStateSign(n: number): 1 | 0 | -1 {
  if (n > 0) return 1
  if (n === 0) return 0
  return -1
}

/** boardTone：BoardLink 条目计数三态色（>0 琥珀/0 绿/−1 灰——禁嵌套三元仓规） */
function boardTone(count: number): string {
  const sign = triStateSign(count)
  if (sign === 1) return 'text-forge-amber'
  if (sign === 0) return 'text-jade-green'
  return 'text-ink-faint'
}

// 拍板三条：审批/评审路由走 adminStations 单源常量，提案队列链接本地组装（R30 票②注释钉）

const ROUTE_PROPOSAL_QUEUE = stationQueueUrl(STATION_TAB_EVOL) // R24 票⑥：命名纠偏——这是更新舱待认领提案队列，非 /admin/evo-board 看板页


/** BoardLink：「等你拍板」条目组件（三条同构单点——异常计数在下方 WbStat 卡，不入此列；
 *  计数可选链+括号纪律（?? -1 不外裸奔，优先级雷不犯两次） */
function BoardLink({ to, count, label }: { to: string; count: number; label: string }) {
  const tone = boardTone(count)
  // R21 票⑤：计数为全量，目标队列页 LIMIT 15/50——>99 截断「99+」防虚胖（口径差钉：点开看前 N 条）
  let text: string | number = count
  if (count < 0) text = '—'
  else if (count > 99) text = '99+'
  return (
    <Link to={to} className="group flex items-baseline gap-2">
      <span className={`text-2xl font-bold ${tone}`}>{text}</span>
      <span className="text-xs text-ink-secondary group-hover:text-pulse-cyan">{label} →</span>
    </Link>
  )
}

/** 今日异常色调（门禁 R3 票②：禁嵌套三元——降级 -1 红（系统读数失败）、>0 琥珀、0 绿） */
function alertTone(n: number): 'red' | 'amber' | 'green' {
  const sign = triStateSign(n)
  if (sign === -1) return 'red' // R11 票②：降级=系统读数失败（比业务异常更重）
  if (sign === 1) return 'amber'
  return 'green'
}

export default function AdminCockpit() {
  const { session } = useWbSession()
  const { data, error, loading } = useWbQuery<CockpitData>('terminal.cockpit', session)
  // P2-6：意图信号面（递归自优化内环 sense——只读卡；表未建/无数据回落空面不显假）
  const { data: signals, loading: signalsLoading, error: signalsError } = useWbQuery<IntentSignalsData>('admin.intentSignals', session)
  // P2-4（台账 W3）：第 5 组待办「待审员工」角标 —— 独立查询（不改 terminal.cockpit 的既有
  //   四组口径，避免动到既有 pendingBoard 契约）；失败显「—」，不拖垮首屏。
  const agentQueue = useWbQuery<{ pending: number }>('agentReviewQueue.stats', session, {}, { enabled: !!session?.token })
  const alertsToday = data?.pendingBoard?.alertsToday ?? -1 // R7 票③：一次求值（滚动部署旧 API 无字段=-1 显「—」）
  const [briefing, setBriefing] = useState<BriefingResult | null>(null)
  const [briefingLoading, setBriefingLoading] = useState(false)
  const [briefingError, setBriefingError] = useState<string | null>(null)

  async function handleBriefing() {
    if (!session?.token) return
    if (!adminConfirm('生成总经理智能简报（将基于两系统实时数据调用大模型）')) return
    setBriefingLoading(true)
    setBriefingError(null)
    try {
      const res = await wbMutation<BriefingResult>('terminal.briefing', { token: session.token })
      setBriefing(res)
    } catch (err) {
      setBriefingError(wbErrorMessage(err))
    } finally {
      setBriefingLoading(false)
    }
  }

  const deptAgentMap = new Map<string, CockpitData['agents']>()
  for (const a of data?.agents ?? []) {
    const list = deptAgentMap.get(a.deptCode) ?? []
    list.push(a)
    deptAgentMap.set(a.deptCode, list)
  }

  return (
    <div>
      <WbPageHeader
        hud="LINGZHISHU OPS · COCKPIT"
        title="总经理驾驶舱"
        desc="广东灵智枢生态科技有限公司 · 灵智枢智能运营：统一库两系统实时 KPI、系统健康与驻部智能体阵列一览。"
      />
      {loading && <WbLoading />}
      <WbError message={error} />
      {/* 波 1·P1-1：拍板台化首屏——「等你拍板」三条置顶（点开即办办完即走，先于值守晨报——拍板第一）
          P2-4：第 5 组「待审员工」入列（pending=77，卡在状态迁移上的成形记录卡；点开=审核队列） */}
      {data && (
        <WbPanel hud="ACTION REQUIRED" title="🛡 等你拍板" className="mb-4 border-forge-amber/40">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <BoardLink to={ROUTE_ADMIN_APPROVALS} count={data.pendingBoard?.approvals ?? -1} label="审批（任务/充值）" />
            <BoardLink to={ROUTE_PROPOSAL_QUEUE} count={data.pendingBoard?.proposals ?? -1} label="进化提案" />
            <BoardLink to={ROUTE_ADMIN_PROTOCOLS} count={data.pendingBoard?.reviews ?? -1} label="协议评审" />
            <BoardLink to={ROUTE_ADMIN_AGENT_REVIEW_QUEUE} count={agentQueue.data?.pending ?? -1} label="待审员工" />
          </div>
        </WbPanel>
      )}
      {/* M7-e：灵枢值守台（晨报/追问/规划器监管，真实平台数据） */}
      <div className="mb-4">
        <AdminDutyPanel />
      </div>
      {data && (
        <>
          {/* v147 北极星第一屏：组织最高目标+护栏红黄绿（B主C校验A辅助） */}
          <WbPanel className="mb-4 border-jade-green/30">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold tracking-wide text-jade-green">北极星 · 周验收交付数</h2>
              <span className="text-[11px] text-ink-faint">校验=续费率 · 辅助=有效雇佣时长 · 用户确权口径</span>
            </div>
            <div className="mb-3 flex items-end gap-2">
              <span className="text-4xl font-bold text-jade-green">{data.weeklyVerifiedDeliveries ?? 0}</span>
              <span className="pb-1 text-xs text-ink-faint">本周用户验收通过的交付</span>
            </div>
            {data.northStar && data.northStar.length > 0 && (
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                {data.northStar.filter((m) => m.layer !== 'north_star').map((m) => (
                  <div key={m.key} className="rounded-lg border border-line-subtle px-3 py-2">
                    <div className="text-[11px] text-ink-faint">
                      {m.layer === 'guard' ? '🛡 ' : ''}{m.name}
                      {m.ownerDept ? <span className="ml-1 opacity-60">@{m.ownerDept}</span> : null}
                    </div>
                    <div className="text-base font-medium">
                      {m.currentValue == null ? '—' : m.currentValue}
                      <span className="ml-1 text-[10px] text-ink-faint">{m.direction === 'up' ? '↑好' : '↓好'}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </WbPanel>
          {/* 波 1·P1-1：北极星瘦身 4 真卡（彭总 2026-10-03 定口径：真实用户/真实企业/生效员工/今日异常；
              摘下的 6 卡指标在 collectKpis API 层保留，经营分析页按需接入） */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <WbStat label="注册账号" value={data.kpis.userTotal} tone="cyan"
              sub={`企业账号 ${data.kpis.enterpriseUserTotal} · 排除测试残留`} />
            <WbStat label="入驻企业（工作台）" value={data.kpis.factoryTotal} tone="cyan"
              sub="真实企业口径" />
            <WbStat label="数字员工" value={data.kpis.activeAgentTotal} tone="amber"
              sub={`生效中 · 共 ${data.kpis.agentTotal}（未生效 ${Math.max(0, data.kpis.agentTotal - data.kpis.activeAgentTotal)}）`} />
            {/* R11 票②：降级「—」红（系统读数失败） */}
            <WbStat label="今日异常" value={alertsToday < 0 ? '—' : alertsToday}
              tone={alertTone(alertsToday)}
              sub="今日告警日志 error/warn" />

          </div>

          <WbPanel title="两系统健康" hud="SYSTEM HEALTH" className="mt-6">
            <div className="flex flex-wrap gap-3">
              <HealthChip label="门户" ok={data.health.portal.ok}
                detail={`HTTP ${data.health.portal.httpCode} · ${data.health.portal.latencyMs}ms`} />
              <HealthChip label="智能工作台" ok={data.health.workbench.ok}
                detail={`HTTP ${data.health.workbench.httpCode} · ${data.health.workbench.latencyMs}ms`} />
              <HealthChip label="统一数据库" ok={data.health.database.ok}
                detail={`${data.health.database.latencyMs}ms`} />
            </div>
          </WbPanel>

          {/* P2-6：意图信号卡（递归自优化内环 sense——精灵每次干活落一条；空面=尚未接通/无流量，不显假） */}
          <WbPanel title="意图信号" hud="INTENT SIGNALS" className="mt-6">
            {signalsLoading ? (
              <WbLoading text="信号加载中…" />
            ) : signalsError ? (
              <WbError message={`信号查询失败：${signalsError}`} />
            ) : !signals || signals.total24h === 0 ? (
              <p className="text-xs text-ink-faint">近 24h 无意图信号——精灵对话接通后即见流（内环 sense 段数据源）。</p>
            ) : (
              <>
                <div className="mb-3 flex flex-wrap gap-3">
                  <WbStat label="近 24h 信号" value={signals.total24h} sub="st_evo_signals 落表条数" />
                </div>
                <div className="mb-3 flex flex-wrap gap-2">
                  {signals.agg.slice(0, 6).map((a) => (
                    <span key={`${a.kind}/${a.action}`} className="rounded-lg border border-line-subtle bg-void/40 px-2.5 py-1 text-xs text-ink-secondary">
                      {a.kind}/{a.action} × {a.cnt}
                      {Number(a.fails) > 0 ? <span className="text-forge-amber">（败 {a.fails}）</span> : null}
                      {a.avgMs != null ? <span className="text-ink-faint"> · {Math.round(Number(a.avgMs))}ms</span> : null}
                    </span>
                  ))}
                </div>
                <div className="space-y-1">
                  {signals.feed.slice(0, 8).map((f) => (
                    <div key={f.id} className="flex items-center gap-2 text-xs text-ink-faint">
                      <span className={f.ok ? 'text-jade-green' : 'text-forge-amber'}>{f.ok ? '✓' : '✗'}</span>
                      <span className="text-ink-secondary">{f.actor || '匿名'}</span>
                      <span>{f.kind}/{f.action}</span>
                      {f.detail ? <span className="text-ink-faint">· {f.detail}</span> : null}
                      {f.latencyMs != null ? <span>{f.latencyMs}ms</span> : null}
                      <span className="ml-auto">{new Date(f.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </WbPanel>

          <WbPanel
            title="总经理智能简报"
            hud="AI BRIEFING"
            className="mt-6"
            actions={
              <WbButton onClick={handleBriefing} loading={briefingLoading}>
                <Sparkles className="h-4 w-4" />
                生成智能简报
              </WbButton>
            }
          >
            <p className="mb-3 whitespace-pre-line text-xs leading-relaxed text-ink-faint">{data.digest}</p>
            <WbError message={briefingError} className="mb-3" />
            {briefing ? (
              <div className="rounded-xl border border-line-subtle bg-void/40 p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="hud-label">智能简报 · {new Date(briefing.generatedAt).toLocaleString('zh-CN')}</p>
                  <ProviderTag provider={briefing.provider} model={briefing.model} degraded={briefing.degraded} />
                </div>
                <p className="whitespace-pre-line text-sm leading-relaxed text-ink-primary">{briefing.content}</p>
              </div>
            ) : (
              <p className="text-xs text-ink-faint">
                点击「生成智能简报」后，系统将基于上方实时数据摘要调用大模型生成 5 条要点简报；大模型不可用时自动降级为规则模板并标注。
              </p>
            )}
          </WbPanel>

          <WbPanel title="AI 参谋 · 枢总" hud="GM ADVISOR" className="mt-6">
            <GmAdvisorPanel />
          </WbPanel>

          {/* M47：DeepSeek Harness 运行时全景（模型网关/三部门引擎/DSH 直达交办） */}
          <WbPanel title="DSH 运行时全景" hud="DEEPSEEK HARNESS" className="mt-6">
            <DshRuntimePanel />
          </WbPanel>

          {/* DSH 服务端治理闭环（合同/双签票据/审计）——S3 超级终端治理直达 */}
          <WbPanel title="DSH 服务端治理" hud="GOVERNANCE" className="mt-6">
            <DshGovernancePanel />
          </WbPanel>

          <WbPanel title="部门与驻部智能体阵列" hud="DEPTS & AGENTS" className="mt-6">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {data.departments.map((d) => (
                <div key={d.code} className="rounded-xl border border-line-subtle bg-void/40 p-4">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-ink-primary">{d.name}</p>
                    <span className="font-mono text-[10px] text-ink-faint">{d.code}</span>
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-secondary">{d.duty}</p>
                  <div className="mt-3 space-y-2">
                    {(deptAgentMap.get(d.code) ?? []).length === 0 && (
                      <p className="text-xs text-ink-faint">暂无驻部智能体</p>
                    )}
                    {(deptAgentMap.get(d.code) ?? []).map((a) => (
                      <div key={a.code} className="flex items-center gap-2.5 rounded-[10px] border border-line-subtle/70 bg-panel/50 px-3 py-2">
                        <span className="text-lg">{a.avatarEmoji}</span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-ink-primary">{a.name}</p>
                          <p className="text-[11px] text-ink-faint">{a.title}</p>
                        </div>
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-jade-green/40 bg-jade-green/[0.08] px-2 py-0.5 font-mono text-[10px] text-jade-green">
                          <span className="h-1 w-1 rounded-full bg-jade-green" />
                          在岗
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </WbPanel>
        </>
      )}
    </div>
  )
}


