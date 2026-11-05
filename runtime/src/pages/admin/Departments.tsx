/**
 * Departments（/admin/departments）—— 灵智枢智能运营 · 部门智能管理。
 * 5 部门卡片（名称/职责/驻部 Agent）；点进部门展开详情：部门 KPI 占位卡 +
 * Agent 对话窗（左侧 Agent 列表，右侧聊天气泡，标注 provider 或「规则降级」）。
 * 数据：terminal.departments / terminal.agentChatStart / terminal.agentChatSend。
 */
import { useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, ChevronUp, Send } from 'lucide-react'
import { useWbSession, useWbQuery, wbMutation, wbErrorMessage } from '@/lib/wbSession'
import {
  WbButton,
  WbEmpty,
  WbError,
  WbLoading,
  WbPageHeader,
  WbPanel,
  wbInputCls,
} from '@/components/wb/ui'
import { adminConfirm, fmtTime, ProviderTag, SendingIndicator } from './shared'
import { ArtifactChips, type ChatArtifact } from '@/components/ArtifactChips'
import { cn } from '@/lib/utils'

interface DeptAgent {
  id: number
  code: string
  name: string
  title: string
  avatarEmoji: string
  status: string
}

interface DeptItem {
  id: number
  code: string
  name: string
  duty: string
  agentCount?: number
  todoPlaceholder: string
  agents: DeptAgent[]
}

interface ChatMessage {
  id?: number
  role: 'user' | 'agent'
  content: string
  provider?: string | null
  degraded?: boolean
  createdAt?: unknown
  artifacts?: ChatArtifact[]
  usedSkills?: string[]
  memoryCount?: number
}

interface ChatStartResult {
  threadId: number
  agent: { code: string; name: string; title: string; avatarEmoji: string; deptCode: string }
  history: Array<{
    id: number
    role: string
    content: string
    provider: string | null
    degraded: boolean
    createdAt: unknown
  }>
}

interface ChatSendResult {
  content: string
  provider: string | null
  model: string | null
  degraded: boolean
  artifacts?: ChatArtifact[]
  usedSkills?: string[]
  memoryCount?: number
}

function ChatWindow({ agent }: { agent: DeptAgent }) {
  const { session } = useWbSession()
  const [threadId, setThreadId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [starting, setStarting] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // 选中 Agent 变化时开/复用线程并加载历史
  useEffect(() => {
    let cancelled = false
    setStarting(true)
    setError(null)
    setMessages([])
    setThreadId(null)
    if (!session?.token) return
    wbMutation<ChatStartResult>('terminal.agentChatStart', { token: session.token, agentCode: agent.code })
      .then((res) => {
        if (cancelled) return
        setThreadId(res.threadId)
        setMessages(
          res.history.map((m) => ({
            id: m.id,
            role: m.role === 'agent' ? 'agent' : 'user',
            content: m.content,
            provider: m.provider,
            degraded: m.degraded,
            createdAt: m.createdAt,
          })),
        )
      })
      .catch((err) => !cancelled && setError(wbErrorMessage(err)))
      .finally(() => !cancelled && setStarting(false))
    return () => {
      cancelled = true
    }
  }, [agent.code, session?.token])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, sending])

  async function handleSend() {
    const content = input.trim()
    if (!content || !session?.token || !threadId || sending) return
    if (!adminConfirm('发送给驻部智能体（将调用大模型生成回复）')) return
    setInput('')
    setError(null)
    setMessages((prev) => [...prev, { role: 'user', content }])
    setSending(true)
    try {
      const res = await wbMutation<ChatSendResult>('terminal.agentChatSend', {
        token: session.token,
        threadId,
        content,
      })
      setMessages((prev) => [
        ...prev,
        {
          role: 'agent',
          content: res.content,
          provider: res.provider,
          degraded: res.degraded,
          artifacts: res.artifacts ?? [],
          usedSkills: res.usedSkills ?? [],
          memoryCount: res.memoryCount ?? 0,
        },
      ])
    } catch (err) {
      setError(wbErrorMessage(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex min-h-[420px] flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto rounded-xl border border-line-subtle bg-void/40 p-4">
        {starting && <WbLoading text="对话加载中…" />}
        {!starting && messages.length === 0 && (
          <WbEmpty
            text={`与 ${agent.name}（${agent.title}）的对话尚未开始`}
            hint="发送第一条消息，智能体将结合两系统实时数据给出建议。"
          />
        )}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={m.id ?? `u-${i}`} className="flex justify-end">
              <div className="max-w-[75%] rounded-xl rounded-br-sm border border-forge-amber/30 bg-forge-amber/[0.12] px-3.5 py-2.5">
                <p className="whitespace-pre-line text-sm leading-relaxed text-ink-primary">{m.content}</p>
              </div>
            </div>
          ) : (
            <div key={m.id ?? `a-${i}`} className="flex justify-start">
              <div className="max-w-[80%] rounded-xl rounded-bl-sm border border-line-subtle bg-panel/70 px-3.5 py-2.5">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-sm">{agent.avatarEmoji}</span>
                  <span className="text-xs font-medium text-ink-secondary">
                    {agent.name} · {agent.title}
                  </span>
                  <ProviderTag provider={m.provider} degraded={m.degraded} />
                </div>
                <p className="whitespace-pre-line text-sm leading-relaxed text-ink-primary">{m.content}</p>
                {m.usedSkills && m.usedSkills.length > 0 && (
                  <p className="mt-1.5 text-[10px] text-pulse-cyan">使用技能：{m.usedSkills.join('、')}</p>
                )}
                {(m.memoryCount ?? 0) > 0 && (
                  <p className="mt-1 text-[10px] text-forge-amber">参考了 {m.memoryCount} 条记忆</p>
                )}
                {m.artifacts && m.artifacts.length > 0 && session?.token && (
                  <ArtifactChips token={session.token} artifacts={m.artifacts} onRevise={(a) => setInput(`请修改刚才生成的《${a.title}》：`)} />
                )}
                {m.createdAt != null && (
                  <p className="mt-1 text-[10px] text-ink-faint">{fmtTime(m.createdAt)}</p>
                )}
              </div>
            </div>
          ),
        )}
        {sending && <SendingIndicator avatar={agent.avatarEmoji} name={agent.name} />}
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
          placeholder={`向 ${agent.name}（${agent.title}）提问，如：本周运营重点建议？`}
          disabled={starting || sending || !threadId}
          maxLength={2000}
        />
        <WbButton onClick={handleSend} loading={sending} disabled={starting || !threadId || !input.trim()}>
          <Send className="h-4 w-4" />
          发送
        </WbButton>
      </div>
    </div>
  )
}

export default function AdminDepartments() {
  const { session } = useWbSession()
  const { data, error, loading } = useWbQuery<{ items: DeptItem[] }>('terminal.departments', session)
  const [openDept, setOpenDept] = useState<string | null>(null)
  const [activeAgent, setActiveAgent] = useState<DeptAgent | null>(null)

  function toggleDept(dept: DeptItem) {
    if (openDept === dept.code) {
      setOpenDept(null)
      setActiveAgent(null)
      return
    }
    setOpenDept(dept.code)
    setActiveAgent(dept.agents[0] ?? null)
  }

  const currentDept = data?.items.find((d) => d.code === openDept) ?? null

  return (
    <div>
      <WbPageHeader
        hud="LINGZHISHU OPS · DEPARTMENTS"
        title="部门智能管理"
        desc="五大部门各驻大模型驱动的智能体；点进部门可与驻部 Agent 对话，建议均基于统一库两系统实时数据。"
      />
      {loading && <WbLoading />}
      <WbError message={error} />
      {data && (
        <>
          {data.items.length === 0 ? (
            <WbEmpty text="尚未初始化部门数据" hint="请先在服务器执行 db/sync-terminal.mts 完成种子。" />
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {data.items.map((d) => (
                <button
                  key={d.code}
                  type="button"
                  onClick={() => toggleDept(d)}
                  className={cn(
                    'glass-panel relative rounded-xl p-5 text-left transition-colors duration-300',
                    openDept === d.code
                      ? 'border-forge-amber/40'
                      : 'hover:border-pulse-cyan/40',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-ink-primary">{d.name}</p>
                    {openDept === d.code ? (
                      <ChevronUp className="h-4 w-4 text-forge-amber" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-ink-faint" />
                    )}
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-ink-secondary">{d.duty}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {d.agents.map((a) => (
                      <span
                        key={a.code}
                        className="inline-flex items-center gap-1.5 rounded-full border border-line-subtle bg-void/50 px-2.5 py-1 text-[11px] text-ink-secondary"
                      >
                        <span>{a.avatarEmoji}</span>
                        {a.name} · {a.title}
                      </span>
                    ))}
                    {d.agents.length === 0 && (
                      <span className="text-[11px] text-ink-faint">暂无驻部智能体</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {currentDept && (
            <WbPanel
              title={`${currentDept.name} · 部门详情`}
              hud="DEPT DETAIL"
              className="mt-6"
            >
              {/* 部门真实 KPI（terminal.deptKpis，死端点处置 t8 填实） */}
              <DeptKpiCards deptCode={currentDept.code} />
              <p className="mt-2 text-[11px] text-ink-faint">{currentDept.todoPlaceholder}</p>

              {/* Agent 对话窗：左列表 + 右聊天 */}
              <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[220px_1fr]">
                <div className="space-y-2">
                  <p className="hud-label mb-1">驻部智能体</p>
                  {currentDept.agents.map((a) => (
                    <button
                      key={a.code}
                      type="button"
                      onClick={() => setActiveAgent(a)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition-colors duration-300',
                        activeAgent?.code === a.code
                          ? 'border-forge-amber/40 bg-forge-amber/[0.08]'
                          : 'border-line-subtle hover:border-pulse-cyan/40',
                      )}
                    >
                      <span className="text-lg">{a.avatarEmoji}</span>
                      <div className="min-w-0">
                        <p className="truncate text-sm text-ink-primary">{a.name}</p>
                        <p className="truncate text-[11px] text-ink-faint">{a.title}</p>
                      </div>
                    </button>
                  ))}
                  {currentDept.agents.length === 0 && (
                    <p className="text-xs text-ink-faint">该部门暂无驻部智能体</p>
                  )}
                </div>
                <div>
                  {activeAgent ? (
                    <ChatWindow key={activeAgent.code} agent={activeAgent} />
                  ) : (
                    <WbEmpty text="选择左侧驻部智能体开始对话" hint="对话上下文已注入两系统实时数据摘要。" />
                  )}
                </div>
              </div>
            </WbPanel>
          )}

          {!currentDept && data.items.length > 0 && (
            <div className="mt-6 flex items-center gap-2 text-xs text-ink-faint">
              <Bot className="h-4 w-4" />
              点击部门卡片展开详情与驻部智能体对话窗。
            </div>
          )}
        </>
      )}
    </div>
  )
}


// ─── 死端点处置 t8：部门真实 KPI 卡（terminal.deptKpis）───────────────────────
interface DeptKpi {
  activeAgents: number
  tasks90d: number
  artifacts90d: number
  adoptionRate: number | null
  note?: string
}

function DeptKpiCards({ deptCode }: { deptCode: string }) {
  const { session } = useWbSession()
  const q = useWbQuery<DeptKpi>('terminal.deptKpis', session, { deptCode })
  const d = q.data
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {[
        { label: '在役智能体', value: d?.activeAgents ?? '—' },
        { label: '近 90 天任务量', value: d?.tasks90d ?? '—' },
        { label: '近 90 天产出物', value: d?.artifacts90d ?? '—' },
        {
          label: '采纳率',
          value: d ? (d.adoptionRate == null ? '观察中' : `${Math.round(d.adoptionRate * 100)}%`) : '—',
          sub: d?.note,
        },
      ].map((c) => (
        <div key={c.label} className="rounded-xl border border-line-subtle bg-void/30 px-4 py-3">
          <p className="hud-label">{c.label}</p>
          <p className="mt-1.5 font-display text-lg font-bold text-ink-primary">{c.value}</p>
          {c.sub && <p className="mt-0.5 text-[10px] text-ink-faint">{c.sub}</p>}
        </div>
      ))}
    </div>
  )
}
