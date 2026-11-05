/**
 * StaffWorkspace（/staff/workspace）—— 部门独立工作台。
 *
 * 守卫：无 staff token 一律跳 /staff/login；staff.me 校验失败自动清会话回登录页。
 * 构成：顶栏（部门名 + 姓名 + 角色 + 退出）/ 部门信息卡（职责简介、成员数、最近会议）/
 * 驻部 Agent 对话区（复用超级终端部门对话体验，staff.agentChatStart/Send）/
 * 负责人额外可见「员工账号分发」面板（createMember / memberList / 重置密码 / 停用）。
 * 数据严格限定本人部门（后端按 token 落 deptKey，前端不传 deptKey）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import {
  Bot,
  FileText,
  KeyRound,
  LogOut,
  MessageSquarePlus,
  Play,
  ScrollText,
  Send,
  Trash2,
  Upload,
  UserPlus,
  Users,
} from 'lucide-react'
import {
  useStaffSession,
  clearStaffSession,
  wbMutation,
  wbQuery,
  wbErrorMessage,
  isWbAuthError,
} from '@/lib/staffSession'
import {
  WbButton,
  WbEmpty,
  WbError,
  WbLoading,
  WbNotice,
  WbPanel,
  wbInputCls,
  wbLabelCls,
} from '@/components/wb/ui'
import { fmtTime, ProviderTag, SendingIndicator } from '@/pages/admin/shared'
import { ArtifactChips, type ChatArtifact } from '@/components/ArtifactChips'
import { cn } from '@/lib/utils'

// ─── 类型 ────────────────────────────────────────────────────────────────────
interface DeptAgent {
  id: number
  code: string
  name: string
  title: string
  avatarEmoji: string
  status: string
}

interface DeptHomeData {
  dept: { key: string; name: string; duty: string }
  agents: DeptAgent[]
  memberCount: number
  recentMeetings: Array<{ id: number; topic: string; status: string; createdAt: unknown }>
  me: { displayName: string; role: 'head' | 'staff'; deptKey: string }
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

interface MemberItem {
  id: number
  username: string
  displayName: string
  role: string
  disabled: boolean
  createdBy: string
  createdAt: unknown
}

const ROLE_LABEL: Record<string, string> = { head: '负责人', staff: '员工' }

// ─── 驻部 Agent 对话窗 ────────────────────────────────────────────────────────
function AgentChatWindow({ token, agent, onAuthFail }: { token: string; agent: DeptAgent; onAuthFail: () => void }) {
  const [threadId, setThreadId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [starting, setStarting] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setStarting(true)
    setError(null)
    setMessages([])
    setThreadId(null)
    wbMutation<ChatStartResult>('staff.agentChatStart', { token, agentKey: agent.code })
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
      .catch((err) => {
        if (cancelled) return
        if (isWbAuthError(err)) onAuthFail()
        setError(wbErrorMessage(err))
      })
      .finally(() => !cancelled && setStarting(false))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.code, token])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, sending])

  async function handleSend(preset?: string) {
    const content = (preset ?? input).trim()
    if (!content || !threadId || sending) return
    setInput('')
    setError(null)
    setMessages((prev) => [...prev, { role: 'user', content }])
    setSending(true)
    try {
      const res = await wbMutation<ChatSendResult>('staff.agentChatSend', { token, threadId, content })
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
      if (isWbAuthError(err)) onAuthFail()
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
          <div className="space-y-3">
            <WbEmpty
              text={`与 ${agent.name}（${agent.title}）的对话尚未开始`}
              hint="发送第一条消息，智能体将结合两系统实时数据给出建议。"
            />
            <div className="flex justify-center">
              <button
                type="button"
                disabled={!threadId || sending}
                onClick={() => void handleSend('请把本周部门办公用品采购清单整理成表，列：序号/物品/数量/预估单价，4行')}
                className="rounded-xl border border-pulse-cyan/40 bg-pulse-cyan/[0.08] px-4 py-2 text-xs text-pulse-cyan transition-colors hover:border-pulse-cyan/70 disabled:opacity-50"
              >
                ⚡ 60 秒体验：让 {agent.name} 给我做一张真 Excel
              </button>
            </div>
          </div>
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
                {m.artifacts && m.artifacts.length > 0 && (
                  <ArtifactChips token={token} artifacts={m.artifacts} onRevise={(a) => setInput(`请修改刚才生成的《${a.title}》：`)} />
                )}
                {m.createdAt != null && <p className="mt-1 text-[10px] text-ink-faint">{fmtTime(m.createdAt)}</p>}
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
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleSend()
          }}
          placeholder={`向 ${agent.name}（${agent.title}）提问`}
          disabled={starting || sending || !threadId}
          maxLength={2000}
        />
        <WbButton onClick={() => void handleSend()} loading={sending} disabled={starting || !threadId || !input.trim()}>
          <Send className="h-4 w-4" />
          发送
        </WbButton>
      </div>
    </div>
  )
}

// ─── 负责人专属：员工账号分发面板 ─────────────────────────────────────────────
function MemberPanel({ token, onAuthFail }: { token: string; onAuthFail: () => void }) {
  const [members, setMembers] = useState<MemberItem[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [form, setForm] = useState({ username: '', password: '', displayName: '' })
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [resetTarget, setResetTarget] = useState<MemberItem | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [resetError, setResetError] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)

  const loadMembers = useCallback(() => {
    wbQuery<{ items: MemberItem[] }>('staff.memberList', { token })
      .then((res) => {
        setMembers(res.items)
        setListError(null)
      })
      .catch((err) => {
        if (isWbAuthError(err)) onAuthFail()
        setListError(wbErrorMessage(err))
      })
  }, [token, onAuthFail])

  useEffect(() => loadMembers(), [loadMembers])

  async function handleCreate() {
    setCreateError(null)
    setNotice(null)
    setCreating(true)
    try {
      await wbMutation('staff.createMember', {
        token,
        username: form.username.trim(),
        password: form.password,
        displayName: form.displayName.trim(),
      })
      setNotice(`已分发员工账号「${form.username.trim()}」。初始密码请线下告知，首次登录后建议修改。`)
      setForm({ username: '', password: '', displayName: '' })
      loadMembers()
    } catch (err) {
      if (isWbAuthError(err)) onAuthFail()
      setCreateError(wbErrorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  async function handleReset() {
    if (!resetTarget) return
    setResetError(null)
    setResetting(true)
    try {
      await wbMutation('staff.resetMemberPassword', {
        token,
        accountId: resetTarget.id,
        newPassword: resetPassword,
      })
      setNotice(`已重置「${resetTarget.displayName}」的密码。新密码请线下告知，首次登录后建议修改。`)
      setResetTarget(null)
      setResetPassword('')
    } catch (err) {
      if (isWbAuthError(err)) onAuthFail()
      setResetError(wbErrorMessage(err))
    } finally {
      setResetting(false)
    }
  }

  async function handleToggleDisabled(m: MemberItem) {
    const action = m.disabled ? '启用' : '停用'
    if (!window.confirm(`确认${action}账号「${m.displayName}（${m.username}）」？`)) return
    setNotice(null)
    try {
      await wbMutation('staff.setMemberDisabled', { token, accountId: m.id, disabled: !m.disabled })
      setNotice(`已${action}账号「${m.displayName}」。`)
      loadMembers()
    } catch (err) {
      if (isWbAuthError(err)) onAuthFail()
      setListError(wbErrorMessage(err))
    }
  }

  return (
    <WbPanel title="员工账号分发" hud="MEMBER ACCOUNTS · HEAD ONLY" className="mt-6">
      <p className="mb-4 text-xs leading-relaxed text-ink-faint">
        仅部门负责人可见。员工账号仅可创建到本部门；初始密码请线下告知，首次登录后建议修改。
      </p>

      {/* 建员工账号 */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
        <div>
          <label className={wbLabelCls}>账号名</label>
          <input
            className={wbInputCls}
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            placeholder="手机号 / 账号名"
            maxLength={64}
          />
        </div>
        <div>
          <label className={wbLabelCls}>姓名</label>
          <input
            className={wbInputCls}
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            placeholder="员工姓名"
            maxLength={64}
          />
        </div>
        <div>
          <label className={wbLabelCls}>初始密码</label>
          <input
            className={wbInputCls}
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="至少 6 位"
            maxLength={64}
            autoComplete="new-password"
          />
        </div>
        <div className="flex items-end">
          <WbButton
            onClick={() => void handleCreate()}
            loading={creating}
            disabled={!form.username.trim() || !form.displayName.trim() || form.password.length < 6}
          >
            <UserPlus className="h-4 w-4" />
            分发账号
          </WbButton>
        </div>
      </div>
      <WbError message={createError} className="mt-3" />
      <WbNotice message={notice} className="mt-3" />

      {/* 成员列表 */}
      <div className="mt-5">
        {members === null && !listError && <WbLoading text="成员加载中…" />}
        <WbError message={listError} />
        {members && members.length === 0 && <WbEmpty text="本部门暂无成员账号" />}
        {members && members.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line-subtle text-left">
                  {['账号', '姓名', '角色', '状态', '创建时间', '操作'].map((h) => (
                    <th key={h} className="px-3 py-2.5 font-mono text-[11px] font-medium tracking-wider text-ink-faint">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line-subtle/60">
                {members.map((m) => (
                  <tr key={m.id}>
                    <td className="px-3 py-2.5 text-ink-primary">{m.username}</td>
                    <td className="px-3 py-2.5 text-ink-secondary">{m.displayName}</td>
                    <td className="px-3 py-2.5 text-ink-secondary">{ROLE_LABEL[m.role] ?? m.role}</td>
                    <td className="px-3 py-2.5">
                      <span
                        className={cn(
                          'inline-flex rounded-full border px-2 py-0.5 text-[11px]',
                          m.disabled
                            ? 'border-ember-red/40 bg-ember-red/10 text-ember-red'
                            : 'border-pulse-cyan/40 bg-pulse-cyan/10 text-pulse-cyan',
                        )}
                      >
                        {m.disabled ? '已停用' : '正常'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-ink-secondary">{fmtTime(m.createdAt)}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex gap-2">
                        <WbButton variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => setResetTarget(m)}>
                          <KeyRound className="h-3.5 w-3.5" />
                          重置密码
                        </WbButton>
                        <WbButton
                          variant={m.disabled ? 'secondary' : 'danger'}
                          className="px-2.5 py-1 text-xs"
                          onClick={() => void handleToggleDisabled(m)}
                        >
                          {m.disabled ? '启用' : '停用'}
                        </WbButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 重置密码弹窗 */}
      {resetTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-void/70 px-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-line-subtle bg-panel p-6">
            <p className="text-sm font-medium text-ink-primary">
              重置密码 · {resetTarget.displayName}（{resetTarget.username}）
            </p>
            <p className="mt-1.5 text-xs text-ink-faint">重置后旧登录态立即失效。新密码请线下告知，首次登录后建议修改。</p>
            <div className="mt-4">
              <label className={wbLabelCls}>新密码</label>
              <input
                className={wbInputCls}
                type="password"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                placeholder="至少 6 位"
                maxLength={64}
                autoComplete="new-password"
              />
            </div>
            <WbError message={resetError} className="mt-3" />
            <div className="mt-4 flex justify-end gap-2">
              <WbButton variant="secondary" onClick={() => setResetTarget(null)}>
                取消
              </WbButton>
              <WbButton onClick={() => void handleReset()} loading={resetting} disabled={resetPassword.length < 6}>
                确认重置
              </WbButton>
            </div>
          </div>
        </div>
      )}
    </WbPanel>
  )
}

// ─── 协同会议室（terminal.meeting* 双轨：staff token）──────────────────────────
interface MeetingItem {
  id: number
  topic: string
  status: string
  roomType?: string
  deptKey?: string | null
  hasSummary: boolean
  messageCount: number
  round: number
  createdAt: unknown
  updatedAt: unknown
}

// iter77：三类标准会议室（员工侧：部门/跨部门；企业会议室仅老板在管理端发起）
const STAFF_ROOM_LABELS: Record<string, string> = {
  enterprise: '企业会议室',
  dept: '部门会议室',
  cross: '跨部门会议室',
  legacy: '协同会议',
}

interface MeetingMessage {
  id: number
  participantType: string
  participantKey: string
  displayName: string
  content: string
  provider: string | null
  degraded: boolean
  round: number
  memoryCount?: number
  createdAt: unknown
}

interface MeetingDetailData {
  artifacts?: ChatArtifact[]
  meeting: {
    id: number
    topic: string
    status: string
    summary: string | null
    createdAt: unknown
    updatedAt: unknown
  }
  messages: MeetingMessage[]
}

const MEETING_STATUS_LABELS: Record<string, string> = {
  open: '进行中',
  summarized: '已生成纪要',
  closed: '已关闭',
}

function StaffMeetingRoom({
  token,
  meetingId,
  isHead,
  onAuthFail,
  onChanged,
}: {
  token: string
  meetingId: number
  isHead: boolean
  onAuthFail: () => void
  onChanged: () => void
}) {
  const [data, setData] = useState<MeetingDetailData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sayInput, setSayInput] = useState('')
  const [roundLoading, setRoundLoading] = useState(false)
  const [sayLoading, setSayLoading] = useState(false)
  const [sumLoading, setSumLoading] = useState(false)
  const [opError, setOpError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const loadDetail = useCallback(() => {
    wbQuery<MeetingDetailData>('terminal.meetingDetail', { token, meetingId })
      .then((res) => {
        setData(res)
        setError(null)
      })
      .catch((err) => {
        if (isWbAuthError(err)) onAuthFail()
        setError(wbErrorMessage(err))
      })
  }, [token, meetingId, onAuthFail])

  useEffect(() => loadDetail(), [loadDetail])

  const maxRound = (data?.messages ?? []).reduce((m, x) => Math.max(m, x.round), 0)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [data?.messages.length])

  async function runAction(action: () => Promise<unknown>) {
    setOpError(null)
    try {
      await action()
      loadDetail()
      onChanged()
    } catch (err) {
      if (isWbAuthError(err)) onAuthFail()
      setOpError(wbErrorMessage(err))
    }
  }

  async function handleRunRound() {
    if (roundLoading) return
    setRoundLoading(true)
    await runAction(() => wbMutation('terminal.meetingRunRound', { token, meetingId }))
    setRoundLoading(false)
  }

  async function handleHumanSay() {
    const content = sayInput.trim()
    if (!content || sayLoading) return
    setSayLoading(true)
    await runAction(async () => {
      await wbMutation('terminal.meetingHumanSay', { token, meetingId, content })
      setSayInput('')
    })
    setSayLoading(false)
  }

  async function handleSummarize() {
    if (sumLoading) return
    setSumLoading(true)
    await runAction(() => wbMutation('terminal.meetingSummarize', { token, meetingId }))
    setSumLoading(false)
  }

  if (error) return <WbError message={error} />
  if (!data) return <WbLoading text="会议室加载中…" />

  const { meeting, messages } = data

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="hud-label">议题 · 第 {maxRound} 轮</p>
          <h3 className="mt-1 text-lg font-bold text-ink-primary">{meeting.topic}</h3>
          <p className="mt-0.5 text-xs text-ink-faint">
            发起于 {fmtTime(meeting.createdAt)} · {MEETING_STATUS_LABELS[meeting.status] ?? meeting.status}
          </p>
        </div>
        {isHead && (
          <div className="flex gap-2">
            <WbButton onClick={() => void handleRunRound()} loading={roundLoading} disabled={meeting.status === 'closed'}>
              <Play className="h-4 w-4" />
              跑一轮圆桌
            </WbButton>
            <WbButton
              variant="secondary"
              onClick={() => void handleSummarize()}
              loading={sumLoading}
              disabled={messages.length === 0}
            >
              <ScrollText className="h-4 w-4" />
              生成纪要
            </WbButton>
          </div>
        )}
      </div>

      {meeting.summary && (
        <div className="rounded-xl border border-forge-amber/30 bg-forge-amber/[0.06] p-4">
          <p className="hud-label mb-2 text-forge-amber">会议纪要</p>
          <p className="whitespace-pre-line text-sm leading-relaxed text-ink-primary">{meeting.summary}</p>
        </div>
      )}

      <WbError message={opError} />

      {/* 迭代 41：会议产出物 */}
      {(data?.artifacts ?? []).length > 0 && (
        <div className="rounded-xl border border-pulse-cyan/30 bg-pulse-cyan/[0.05] p-3">
          <p className="mb-2 text-xs font-medium text-pulse-cyan">
            会议产出物 · {data!.artifacts!.length} 份（驻部智能体技能工具生成，点击下载）
          </p>
          <ArtifactChips token={token} artifacts={data!.artifacts!} />
        </div>
      )}

      <div className="max-h-[560px] space-y-3 overflow-y-auto rounded-xl border border-line-subtle bg-void/40 p-4">
        {messages.length === 0 && (
          <WbEmpty text="会议暂无发言" hint={isHead ? '点击「跑一轮圆桌」由驻部智能体依次发言。' : '等待负责人发起圆桌讨论。'} />
        )}
        {messages.map((m) =>
          m.participantType === 'human' ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[78%] rounded-xl rounded-br-sm border border-forge-amber/30 bg-forge-amber/[0.12] px-3.5 py-2.5">
                <div className="mb-1 flex items-center justify-end gap-2">
                  <span className="rounded-full border border-forge-amber/40 bg-forge-amber/10 px-2 py-0.5 font-mono text-[10px] text-forge-amber">
                    第{m.round}轮
                  </span>
                  <span className="text-xs font-medium text-forge-amber">{m.displayName} · 真人</span>
                </div>
                <p className="whitespace-pre-line text-sm leading-relaxed text-ink-primary">{m.content}</p>
                <p className="mt-1 text-right text-[10px] text-ink-faint">{fmtTime(m.createdAt)}</p>
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex justify-start">
              <div className="max-w-[80%] rounded-xl rounded-bl-sm border border-line-subtle bg-panel/70 px-3.5 py-2.5">
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <span className="text-base">🤖</span>
                  <span className="text-xs font-medium text-ink-secondary">{m.displayName} · 智能体</span>
                  <span className="rounded-full border border-line-subtle px-2 py-0.5 font-mono text-[10px] text-ink-faint">
                    第{m.round}轮
                  </span>
                  <ProviderTag provider={m.provider} degraded={m.degraded} />
                </div>
                <p className="whitespace-pre-line text-sm leading-relaxed text-ink-primary">{m.content}</p>
                {(m.memoryCount ?? 0) > 0 && (
                  <p className="mt-1 text-[10px] text-forge-amber">参考了 {m.memoryCount} 条记忆</p>
                )}
                <p className="mt-1 text-[10px] text-ink-faint">{fmtTime(m.createdAt)}</p>
              </div>
            </div>
          ),
        )}
        {roundLoading && (
          <div className="flex justify-start">
            <div className="rounded-xl border border-line-subtle bg-panel/70 px-3.5 py-2.5 text-xs text-ink-faint">
              🤖 5 位驻部智能体依次思考中…（大模型串行调用，耗时较长，请勿关闭页面）
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex gap-2">
        <input
          className={wbInputCls}
          value={sayInput}
          onChange={(e) => setSayInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleHumanSay()
          }}
          placeholder="以本人身份发言（将进入会议纪要上下文）…"
          disabled={sayLoading || meeting.status === 'closed'}
          maxLength={1000}
        />
        <WbButton
          variant="secondary"
          onClick={() => void handleHumanSay()}
          loading={sayLoading}
          disabled={!sayInput.trim() || meeting.status === 'closed'}
        >
          <Send className="h-4 w-4" />
          发言
        </WbButton>
      </div>
    </div>
  )
}

function MeetingPanel({ token, isHead, myDeptKey, onAuthFail }: { token: string; isHead: boolean; myDeptKey: string; onAuthFail: () => void }) {
  const [items, setItems] = useState<MeetingItem[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [topic, setTopic] = useState('')
  const [opening, setOpening] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  // iter77：部门会议室（默认，锁定本部门）/ 跨部门会议室（≥2部门，含本部门）
  const [roomType, setRoomType] = useState<'dept' | 'cross'>('dept')
  const [crossDepts, setCrossDepts] = useState<string[]>([])
  const [seats, setSeats] = useState<{ deptKey: string; agentName: string; enabled: boolean }[]>([])

  useEffect(() => {
    wbQuery<{ seats: { deptKey: string; agentName: string; enabled: boolean }[] }>('terminal.meetingGetConfig', { token })
      .then((res) => setSeats(res.seats.filter((s) => s.enabled)))
      .catch(() => setSeats([]))
  }, [token])

  const loadList = useCallback(() => {
    wbQuery<{ items: MeetingItem[] }>('terminal.meetingList', { token })
      .then((res) => {
        setItems(res.items)
        setListError(null)
      })
      .catch((err) => {
        if (isWbAuthError(err)) onAuthFail()
        setListError(wbErrorMessage(err))
      })
  }, [token, onAuthFail])

  useEffect(() => loadList(), [loadList])

  async function handleCreate() {
    const t = topic.trim()
    if (!t || creating) return
    if (roomType === 'cross') {
      const all = [...new Set([myDeptKey, ...crossDepts])]
      if (all.length < 2) {
        setCreateError('跨部门会议室需至少勾选 1 个协同部门（本部门自动加入）')
        return
      }
    }
    setCreating(true)
    setCreateError(null)
    try {
      const res = await wbMutation<{ meetingId: number }>('terminal.meetingCreate', {
        token,
        topic: t,
        meetingType: 'partial',
        roomType,
        participantDepts: roomType === 'cross' ? [...new Set([myDeptKey, ...crossDepts])] : undefined,
        ...(opening.trim() ? { opening: opening.trim() } : {}),
      })
      setTopic('')
      setOpening('')
      setCrossDepts([])
      loadList()
      setSelectedId(res.meetingId)
    } catch (err) {
      if (isWbAuthError(err)) onAuthFail()
      setCreateError(wbErrorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[320px_1fr]">
      <div className="space-y-4">
        <WbPanel title="发起协同会议" hud="NEW MEETING">
          {isHead ? (
            <>
              {/* iter77：会议室类型（员工侧仅部门/跨部门） */}
              <div className="mb-3 grid grid-cols-2 gap-2">
                {([
                  ['dept', '部门会议室', '本部门负责人 + 员工 + Agent'],
                  ['cross', '跨部门会议室', '多部门协同 + Agent'],
                ] as const).map(([value, label, hint]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => { setRoomType(value); setCrossDepts([]) }}
                    className={cn(
                      'rounded-[10px] border px-3 py-2 text-left transition-colors duration-300',
                      roomType === value
                        ? 'border-forge-amber/50 bg-forge-amber/10'
                        : 'border-line-subtle hover:border-pulse-cyan/40',
                    )}
                  >
                    <p className={cn('text-sm font-medium', roomType === value ? 'text-forge-amber' : 'text-ink-primary')}>{label}</p>
                    <p className="mt-0.5 text-[10px] text-ink-faint">{hint}</p>
                  </button>
                ))}
              </div>
              {roomType === 'cross' && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {seats.filter((s) => s.deptKey !== myDeptKey).map((s) => {
                    const checked = crossDepts.includes(s.deptKey)
                    return (
                      <button
                        key={s.deptKey}
                        type="button"
                        onClick={() =>
                          setCrossDepts((prev) =>
                            checked ? prev.filter((d) => d !== s.deptKey) : [...prev, s.deptKey],
                          )
                        }
                        className={cn(
                          'rounded-full border px-3 py-1 text-xs transition-colors duration-300',
                          checked
                            ? 'border-forge-amber/50 bg-forge-amber/15 text-forge-amber'
                            : 'border-line-subtle text-ink-secondary hover:border-pulse-cyan/40',
                        )}
                      >
                        {s.agentName}
                      </button>
                    )
                  })}
                </div>
              )}
              <div>
                <label className={wbLabelCls}>会议议题</label>
                <input
                  className={wbInputCls}
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="如：本部门 3 月协同重点"
                  maxLength={200}
                />
              </div>
              <div className="mt-3">
                <label className={wbLabelCls}>开场发言（可选）</label>
                <textarea
                  className={cn(wbInputCls, 'min-h-[72px] resize-y')}
                  value={opening}
                  onChange={(e) => setOpening(e.target.value)}
                  placeholder="作为会议第一条真人发言注入上下文"
                  maxLength={1000}
                />
              </div>
              <WbError message={createError} className="mt-2" />
              <WbButton
                className="mt-3 w-full"
                onClick={() => void handleCreate()}
                loading={creating}
                disabled={!topic.trim() || (roomType === 'cross' && crossDepts.length === 0)}
              >
                <MessageSquarePlus className="h-4 w-4" />
                发起{STAFF_ROOM_LABELS[roomType]}
              </WbButton>
            </>
          ) : (
            <WbEmpty text="仅部门负责人可发起会议" hint="如需发起新的协同会议，请联系本部门负责人。" />
          )}
        </WbPanel>

        <WbPanel title="会议列表" hud="MEETINGS">
          {items === null && !listError && <WbLoading />}
          <WbError message={listError} />
          {items && items.length === 0 && <WbEmpty text="暂无会议" hint="由负责人发起第一场协同会议。" />}
          <div className="space-y-2">
            {(items ?? []).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setSelectedId(m.id)}
                className={cn(
                  'w-full rounded-[10px] border px-3.5 py-3 text-left transition-colors duration-300',
                  selectedId === m.id
                    ? 'border-forge-amber/40 bg-forge-amber/[0.08]'
                    : 'border-line-subtle hover:border-pulse-cyan/40',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm text-ink-primary">{m.topic}</p>
                  <span className="shrink-0 rounded-full border border-line-subtle px-2 py-0.5 font-mono text-[10px] text-ink-faint">
                    {MEETING_STATUS_LABELS[m.status] ?? m.status}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-ink-faint">
                  {STAFF_ROOM_LABELS[m.roomType ?? 'legacy'] ?? m.roomType} · {fmtTime(m.createdAt)} · 第 {m.round} 轮 · {m.messageCount} 条发言
                  {m.hasSummary ? ' · 含纪要' : ''}
                </p>
              </button>
            ))}
          </div>
        </WbPanel>
      </div>

      <WbPanel title="会议室" hud="MEETING ROOM">
        {selectedId ? (
          <StaffMeetingRoom
            key={selectedId}
            token={token}
            meetingId={selectedId}
            isHead={isHead}
            onAuthFail={onAuthFail}
            onChanged={loadList}
          />
        ) : (
          <WbEmpty
            text="从左侧选择一场会议，或由负责人发起新的协同会议"
            hint="圆桌发言与纪要均基于统一库两系统实时数据生成。"
          />
        )}
      </WbPanel>
    </div>
  )
}

// ─── iter80 L2 租户审批中心（claw.pandaTenantApprovals / Approve / Reject）─────
interface TenantApprovalItem {
  opNo: string
  instanceKey?: string | null
  actor: string
  task: string
  domain?: string | null
  risk: string
  approvalLevel: 'l1_auto' | 'l2_tenant' | 'l3_platform'
  createdAt?: string
  status?: string
  approvedBy?: string | null
  approvedAt?: string | null
}

const TENANT_LEVEL_META: Record<string, { label: string; cls: string }> = {
  l1_auto: { label: 'L1 自动', cls: 'border-pulse-cyan/40 text-pulse-cyan' },
  l2_tenant: { label: 'L2 租户', cls: 'border-forge-amber/40 text-forge-amber' },
  l3_platform: { label: 'L3 平台', cls: 'border-red-400/40 text-red-300' },
}

function TenantApprovalPanel({ token, onAuthFail }: { token: string; onAuthFail: () => void }) {
  const [pending, setPending] = useState<TenantApprovalItem[] | null>(null)
  const [recent, setRecent] = useState<TenantApprovalItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    wbQuery<{ pending: TenantApprovalItem[]; recent: TenantApprovalItem[] }>('claw.pandaTenantApprovals', { token })
      .then((res) => {
        setPending(res.pending)
        setRecent(res.recent)
        setError(null)
      })
      .catch((err) => {
        if (isWbAuthError(err)) onAuthFail()
        setError(wbErrorMessage(err))
      })
  }, [token, onAuthFail])

  useEffect(() => load(), [load])

  async function act(opNo: string, kind: 'approve' | 'reject') {
    if (busy) return
    setBusy(opNo)
    setNotice(null)
    try {
      if (kind === 'approve') {
        await wbMutation('claw.pandaTenantApprove', { token, opNo })
        setNotice(`单 ${opNo} 已批准并下发执行。`)
      } else {
        const reason = window.prompt('驳回原因（将留痕）', '租户负责人驳回') ?? '租户负责人驳回'
        await wbMutation('claw.pandaTenantReject', { token, opNo, reason })
        setNotice(`单 ${opNo} 已驳回。`)
      }
      load()
    } catch (err) {
      if (isWbAuthError(err)) onAuthFail()
      setNotice(null)
      setError(wbErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <WbPanel title="待审批 · 龙虾操作单" hud="PENDING">
        <WbError message={error} />
        {notice && <p className="mb-3 rounded-lg border border-pulse-cyan/30 bg-pulse-cyan/[0.06] px-3 py-2 text-xs text-pulse-cyan">{notice}</p>}
        {pending === null && !error && <WbLoading />}
        {pending && pending.length === 0 && <WbEmpty text="暂无待审批操作" hint="L2 租户级龙虾任务会出现在这里，由部门负责人一键审批。" />}
        <div className="space-y-2">
          {(pending ?? []).map((op) => {
            const meta = TENANT_LEVEL_META[op.approvalLevel] ?? TENANT_LEVEL_META.l2_tenant
            const canAct = op.approvalLevel === 'l2_tenant'
            return (
              <div key={op.opNo} className="rounded-[10px] border border-line-subtle px-3.5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate font-mono text-xs text-ink-primary">{op.opNo}</p>
                  <span className={cn('shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px]', meta.cls)}>{meta.label}</span>
                </div>
                <p className="mt-1.5 line-clamp-2 text-sm text-ink-secondary">{op.task}</p>
                <p className="mt-1 text-[11px] text-ink-faint">
                  {op.actor} · 风险 {op.risk}{op.domain ? ` · ${op.domain}` : ''}{op.createdAt ? ` · ${fmtTime(op.createdAt)}` : ''}
                </p>
                <div className="mt-2.5 flex gap-2">
                  {canAct ? (
                    <>
                      <button
                        type="button"
                        disabled={busy === op.opNo}
                        onClick={() => act(op.opNo, 'approve')}
                        className="rounded-[8px] border border-forge-amber/40 bg-forge-amber/[0.12] px-3 py-1 text-xs text-forge-amber transition-colors hover:bg-forge-amber/20 disabled:opacity-50"
                      >
                        {busy === op.opNo ? '处理中…' : '批准执行'}
                      </button>
                      <button
                        type="button"
                        disabled={busy === op.opNo}
                        onClick={() => act(op.opNo, 'reject')}
                        className="rounded-[8px] border border-line-subtle px-3 py-1 text-xs text-ink-secondary transition-colors hover:border-red-400/40 hover:text-red-300 disabled:opacity-50"
                      >
                        驳回
                      </button>
                    </>
                  ) : (
                    <span className="text-[11px] text-ink-faint">需平台超管审批，本端只读</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </WbPanel>

      <WbPanel title="最近已办" hud="HISTORY">
        {recent === null && !error && <WbLoading />}
        {recent && recent.length === 0 && <WbEmpty text="暂无审批历史" />}
        <div className="space-y-2">
          {(recent ?? []).map((op) => (
            <div key={op.opNo} className="rounded-[10px] border border-line-subtle px-3.5 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate font-mono text-xs text-ink-primary">{op.opNo}</p>
                <span className={cn(
                  'shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px]',
                  op.status === 'done' ? 'border-pulse-cyan/40 text-pulse-cyan' : 'border-line-subtle text-ink-faint',
                )}>
                  {op.status === 'done' ? '已完成' : op.status === 'rejected' ? '已驳回' : op.status === 'failed' ? '失败' : op.status}
                </span>
              </div>
              <p className="mt-1 line-clamp-1 text-xs text-ink-secondary">{op.task}</p>
              <p className="mt-0.5 text-[11px] text-ink-faint">
                {op.approvedBy ? `审批人 ${op.approvedBy}` : ''}{op.approvedAt ? ` · ${fmtTime(op.approvedAt)}` : ''}
              </p>
            </div>
          ))}
        </div>
      </WbPanel>
    </div>
  )
}

// ─── 圆桌配置（terminal.meetingGetConfig / meetingSaveConfig）──────────────────
interface MeetingSeat {
  deptKey: string
  agentName: string
  personaHint: string
  enabled: boolean
  isDefault: boolean
}

function RoundConfigPanel({
  token,
  isHead,
  myDeptKey,
  onAuthFail,
}: {
  token: string
  isHead: boolean
  myDeptKey: string
  onAuthFail: () => void
}) {
  const [seats, setSeats] = useState<MeetingSeat[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [form, setForm] = useState({ agentName: '', personaHint: '', enabled: true })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const loadConfig = useCallback(() => {
    wbQuery<{ seats: MeetingSeat[] }>('terminal.meetingGetConfig', { token })
      .then((res) => {
        setSeats(res.seats)
        setError(null)
        const mine = res.seats.find((s) => s.deptKey === myDeptKey)
        if (mine) setForm({ agentName: mine.agentName, personaHint: mine.personaHint, enabled: mine.enabled })
      })
      .catch((err) => {
        if (isWbAuthError(err)) onAuthFail()
        setError(wbErrorMessage(err))
      })
  }, [token, myDeptKey, onAuthFail])

  useEffect(() => loadConfig(), [loadConfig])

  async function handleSave() {
    if (!isHead || saving) return
    setSaving(true)
    setSaveError(null)
    setNotice(null)
    try {
      await wbMutation('terminal.meetingSaveConfig', {
        token,
        deptKey: myDeptKey,
        agentName: form.agentName.trim(),
        personaHint: form.personaHint.trim(),
        enabled: form.enabled,
      })
      setNotice('圆桌席位配置已保存，下一轮圆桌讨论即时生效。')
      loadConfig()
    } catch (err) {
      if (isWbAuthError(err)) onAuthFail()
      setSaveError(wbErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const mySeat = seats?.find((s) => s.deptKey === myDeptKey)
  const otherSeats = (seats ?? []).filter((s) => s.deptKey !== myDeptKey)

  return (
    <div className="space-y-6">
      <WbPanel title="本部门圆桌席位" hud="MY DEPT SEAT">
        {seats === null && !error && <WbLoading text="席位配置加载中…" />}
        <WbError message={error} />
        {seats && (
          <>
            {!isHead && (
              <p className="mb-3 rounded-lg border border-line-subtle bg-void/40 px-3 py-2 text-xs text-ink-faint">
                仅部门负责人可编辑圆桌席位配置，以下为只读视图。
              </p>
            )}
            {mySeat?.isDefault && (
              <p className="mb-3 text-[11px] text-ink-faint">当前为系统默认驻部智能体配置，保存后将覆盖默认。</p>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto]">
              <div>
                <label className={wbLabelCls}>智能体名称</label>
                <input
                  className={wbInputCls}
                  value={form.agentName}
                  onChange={(e) => setForm({ ...form, agentName: e.target.value })}
                  placeholder="圆桌发言显示名"
                  maxLength={64}
                  disabled={!isHead}
                />
              </div>
              <div className="flex items-end pb-0.5">
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-ink-secondary">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                    disabled={!isHead}
                    className="h-4 w-4 accent-forge-amber"
                  />
                  参与圆桌讨论
                </label>
              </div>
            </div>
            <div className="mt-3">
              <label className={wbLabelCls}>人设提示（personaHint）</label>
              <textarea
                className={cn(wbInputCls, 'min-h-[96px] resize-y')}
                value={form.personaHint}
                onChange={(e) => setForm({ ...form, personaHint: e.target.value })}
                placeholder="追加到该席位发言 prompt 的人设与口径约束"
                maxLength={2000}
                disabled={!isHead}
              />
            </div>
            {isHead && (
              <div className="mt-3">
                <WbButton onClick={() => void handleSave()} loading={saving} disabled={!form.agentName.trim()}>
                  保存配置
                </WbButton>
              </div>
            )}
            <WbError message={saveError} className="mt-3" />
            <WbNotice message={notice} className="mt-3" />
          </>
        )}
      </WbPanel>

      <WbPanel title="其他部门席位（只读）" hud="OTHER SEATS">
        {seats === null && !error && <WbLoading />}
        {otherSeats.length === 0 && seats !== null && <WbEmpty text="暂无其他部门席位" />}
        {otherSeats.length > 0 && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {otherSeats.map((s) => (
              <div key={s.deptKey} className="rounded-xl border border-line-subtle bg-void/30 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm text-ink-primary">
                    {s.agentName}
                    <span className="ml-2 font-mono text-[11px] text-ink-faint">{s.deptKey}</span>
                  </p>
                  <span
                    className={cn(
                      'inline-flex rounded-full border px-2 py-0.5 text-[11px]',
                      s.enabled
                        ? 'border-pulse-cyan/40 bg-pulse-cyan/10 text-pulse-cyan'
                        : 'border-line-subtle text-ink-faint',
                    )}
                  >
                    {s.enabled ? '已启用' : '已停用'}
                  </span>
                </div>
                {s.personaHint && <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-ink-faint">{s.personaHint}</p>}
              </div>
            ))}
          </div>
        )}
      </WbPanel>
    </div>
  )
}

// ─── 部门知识库（kb.list / kb.upload / kb.remove 双轨：staff token）─────────────
interface StaffKbDocItem {
  id: number
  title: string
  fileName: string
  sizeBytes: number
  status: string
  failReason: string | null
  parsedChars: number
  excerpt: string
  uploadedBy: string
  deptKey: string | null
  visibility?: string
  usedCount?: number
  createdAt: unknown
}

interface DocRefItem {
  id: number
  usedBy: string
  refId: string
  actor: string
  createdAt: unknown
}

const KB_ACCEPT = '.txt,.md,.markdown,.pdf,.docx,.doc,.xlsx,.xls,.png,.jpg,.jpeg'
const KB_MAX_FILE_BYTES = 2 * 1024 * 1024

function kbFmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

const REF_USEDBY_LABEL: Record<string, string> = {
  swarm: '协同任务',
  chat: '对话',
  meeting: '会议',
  skill: '技能',
}

/** 迭代 38：资料确权卡——单份文档的引用流水 */
function DocRefsList({ token, docId, onAuthFail }: { token: string; docId: number; onAuthFail: () => void }) {
  const [refs, setRefs] = useState<DocRefItem[] | null>(null)
  useEffect(() => {
    wbQuery<{ items: DocRefItem[] }>('kb.docRefs', { token, docId })
      .then((res) => setRefs(res.items))
      .catch((err) => {
        if (isWbAuthError(err)) onAuthFail()
        setRefs([])
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, docId])
  if (refs === null) return <p className="mt-1 text-[11px] text-ink-faint">引用记录加载中…</p>
  if (refs.length === 0) return <p className="mt-1 text-[11px] text-ink-faint">尚未被任何任务引用。</p>
  return (
    <ul className="mt-1.5 space-y-0.5">
      {refs.slice(0, 8).map((r) => (
        <li key={r.id} className="text-[11px] text-ink-faint">
          {fmtTime(r.createdAt)} · {REF_USEDBY_LABEL[r.usedBy] ?? r.usedBy} #{r.refId} · {r.actor}
        </li>
      ))}
    </ul>
  )
}

function DeptKbPanel({
  token,
  isHead,
  myDeptKey,
  onAuthFail,
}: {
  token: string
  isHead: boolean
  myDeptKey: string
  onAuthFail: () => void
}) {
  const [items, setItems] = useState<StaffKbDocItem[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [refsDocId, setRefsDocId] = useState<number | null>(null)

  const loadList = useCallback(() => {
    wbQuery<{ items: StaffKbDocItem[] }>('kb.list', { token })
      .then((res) => {
        setItems(res.items)
        setListError(null)
      })
      .catch((err) => {
        if (isWbAuthError(err)) onAuthFail()
        setListError(wbErrorMessage(err))
      })
  }, [token, onAuthFail])

  useEffect(() => loadList(), [loadList])

  function handlePick(f: File | null) {
    setUploadError(null)
    if (f && f.size > KB_MAX_FILE_BYTES) {
      setFile(null)
      if (fileRef.current) fileRef.current.value = ''
      setUploadError('文件超过 2MB 上限，请压缩或拆分后再上传')
      return
    }
    setFile(f)
  }

  async function handleUpload() {
    if (!file) return
    setUploadError(null)
    setNotice(null)
    setUploading(true)
    try {
      const fileBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = String(reader.result ?? '')
          resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result)
        }
        reader.onerror = () => reject(new Error('文件读取失败，请重试'))
        reader.readAsDataURL(file)
      })
      const res = await wbMutation<{ archivedOnly: boolean; sensitiveHit?: boolean }>('kb.upload', {
        token,
        title: title.trim(),
        fileName: file.name,
        fileBase64,
      })
      setNotice(
        (res.archivedOnly
          ? `已上传「${file.name}」至本部门资料夹：该格式已存档，暂不参与智能问答解析。`
          : `已上传「${file.name}」至本部门资料夹，文本已解析可被协同任务引用。`) +
          (res.sensitiveHit ? ' 注意：检测到疑似证件号等敏感信息，展示层将自动掩码。' : ''),
      )
      setFile(null)
      setTitle('')
      if (fileRef.current) fileRef.current.value = ''
      loadList()
    } catch (err) {
      if (isWbAuthError(err)) onAuthFail()
      setUploadError(wbErrorMessage(err))
    } finally {
      setUploading(false)
    }
  }

  async function handleRemove(doc: StaffKbDocItem) {
    if (!window.confirm(`确认删除本部门知识库文档「${doc.title}」？删除后不可恢复。`)) return
    setNotice(null)
    try {
      await wbMutation('kb.remove', { token, id: doc.id })
      setNotice(`已删除文档「${doc.title}」。`)
      loadList()
    } catch (err) {
      if (isWbAuthError(err)) onAuthFail()
      window.alert(wbErrorMessage(err))
    }
  }

  return (
    <div className="space-y-6">
      <WbPanel title="上传部门文档" hud="UPLOAD DOCUMENT">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_auto]">
          <div>
            <label className={wbLabelCls}>选择文件</label>
            <input
              ref={fileRef}
              type="file"
              accept={KB_ACCEPT}
              className={cn(wbInputCls, 'cursor-pointer file:mr-3 file:rounded file:border-0 file:bg-forge-amber/15 file:px-3 file:py-1 file:text-xs file:text-forge-amber')}
              onChange={(e) => handlePick(e.target.files?.[0] ?? null)}
            />
            <p className="mt-1 text-[11px] text-ink-faint">支持 {KB_ACCEPT} · 单文件 ≤ 2MB · 上传后仅本部门可见</p>
          </div>
          <div>
            <label className={wbLabelCls}>标题（留空用文件名）</label>
            <input
              className={wbInputCls}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：本部门作业指引"
              maxLength={200}
            />
          </div>
          <div className="flex items-end">
            <WbButton onClick={() => void handleUpload()} loading={uploading} disabled={!file}>
              <Upload className="h-4 w-4" />
              上传
            </WbButton>
          </div>
        </div>
        <WbError message={uploadError} className="mt-3" />
        <WbNotice message={notice} className="mt-3" />
      </WbPanel>

      <WbPanel title="部门资料夹 · 文档" hud="KB DOCUMENTS">
        {items === null && !listError && <WbLoading />}
        <WbError message={listError} />
        {items && items.length === 0 && <WbEmpty text="暂无可见文档" hint="上传本部门资料，或等待管理员上传全局共享文档。" />}
        {items && items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line-subtle text-left">
                  {['标题', '范围', '大小', '状态', '上传人', '时间', '操作'].map((h) => (
                    <th key={h} className="px-3 py-2.5 font-mono text-[11px] font-medium tracking-wider text-ink-faint">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line-subtle/60">
                {items.map((d) => (
                  <tr key={d.id}>
                    <td className="px-3 py-2.5 text-ink-primary">
                      <span className="inline-flex items-center gap-1.5">
                        <FileText className="h-3.5 w-3.5 text-forge-amber/80" />
                        {d.title}
                      </span>
                      <p className="mt-0.5 text-[11px] text-ink-faint">{d.fileName}</p>
                    </td>
                    <td className="px-3 py-2.5">
                      {d.deptKey === null ? (
                        <span className="inline-flex rounded-full border border-pulse-cyan/40 bg-pulse-cyan/10 px-2 py-0.5 text-[11px] text-pulse-cyan">
                          共享
                        </span>
                      ) : (
                        <span className="inline-flex rounded-full border border-forge-amber/40 bg-forge-amber/10 px-2 py-0.5 text-[11px] text-forge-amber">
                          本部门
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-ink-secondary">{kbFmtSize(d.sizeBytes)}</td>
                    <td className="px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => setRefsDocId(refsDocId === d.id ? null : d.id)}
                        className={cn(
                          'inline-flex rounded-full border px-2 py-0.5 text-[11px]',
                          (d.usedCount ?? 0) > 0
                            ? 'border-pulse-cyan/40 bg-pulse-cyan/10 text-pulse-cyan'
                            : 'border-line-subtle text-ink-faint',
                        )}
                      >
                        {d.usedCount ?? 0} 次
                      </button>
                      {refsDocId === d.id && <DocRefsList token={token} docId={d.id} onAuthFail={onAuthFail} />}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={cn(
                          'inline-flex rounded-full border px-2 py-0.5 text-[11px]',
                          d.status === 'ready'
                            ? 'border-pulse-cyan/40 bg-pulse-cyan/10 text-pulse-cyan'
                            : 'border-ember-red/40 bg-ember-red/10 text-ember-red',
                        )}
                      >
                        {d.status === 'ready' ? '就绪' : '失败'}
                      </span>
                      {d.failReason && <p className="mt-1 max-w-[220px] text-[11px] text-ink-faint">{d.failReason}</p>}
                    </td>
                    <td className="px-3 py-2.5 text-ink-secondary">{d.uploadedBy}</td>
                    <td className="px-3 py-2.5 text-ink-secondary">{fmtTime(d.createdAt)}</td>
                    <td className="px-3 py-2.5">
                      {isHead && d.deptKey === myDeptKey ? (
                        <WbButton variant="danger" className="px-2.5 py-1 text-xs" onClick={() => void handleRemove(d)}>
                          <Trash2 className="h-3.5 w-3.5" />
                          删除
                        </WbButton>
                      ) : (
                        <span className="text-[11px] text-ink-faint">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-[11px] text-ink-faint">
          「共享」为管理员上传的全局文档，全员可见；仅部门负责人可删除本部门文档。
        </p>
      </WbPanel>
    </div>
  )
}

// ─── 页面主体 ────────────────────────────────────────────────────────────────
// ─── 迭代 36：会议抄送收件箱（terminal.ccInbox/ccRead/ccDispatch，staff 自动限定本部门）─
interface CcInboxItem {
  id: number
  meetingId: number
  deptKey: string
  topic: string
  meetingType: string
  projectTag: string | null
  summary: string | null
  read: boolean
  readAt: unknown
  dispatchedThreadId: number | null
  createdAt: unknown
}

function CcInboxPanel({
  token,
  isHead,
  onAuthFail,
  onGoChat,
}: {
  token: string
  isHead: boolean
  onAuthFail: () => void
  onGoChat: () => void
}) {
  const [data, setData] = useState<{ items: CcInboxItem[]; unread: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandId, setExpandId] = useState<number | null>(null)
  const [dispatchId, setDispatchId] = useState<number | null>(null)
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [opError, setOpError] = useState<string | null>(null)

  const load = useCallback(() => {
    wbQuery<{ items: CcInboxItem[]; unread: number }>('terminal.ccInbox', { token })
      .then((res) => {
        setData(res)
        setError(null)
      })
      .catch((err) => {
        if (isWbAuthError(err)) onAuthFail()
        setError(wbErrorMessage(err))
      })
  }, [token, onAuthFail])

  useEffect(() => load(), [load])

  async function runAction(action: () => Promise<unknown>) {
    setOpError(null)
    setBusy(true)
    try {
      await action()
      load()
    } catch (err) {
      if (isWbAuthError(err)) onAuthFail()
      setOpError(wbErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <WbPanel title="会议抄送" hud="CC INBOX" className="mt-6">
      {data && data.unread > 0 && (
        <p className="mb-3 rounded-lg border border-forge-amber/30 bg-forge-amber/[0.08] px-3 py-2 text-xs text-forge-amber">
          {data.unread} 条未读抄送：会议纪要已送达本部门，可转为部门任务。
        </p>
      )}
      {error && <WbError message={error} />}
      {!data && !error && <WbLoading />}
      {data && data.items.length === 0 && (
        <WbEmpty text="暂无抄送" hint="会议纪要抄送到本部门后会出现在这里。" />
      )}
      <div className="space-y-2">
        {(data?.items ?? []).map((it) => (
          <div
            key={it.id}
            className={cn(
              'rounded-[10px] border px-3.5 py-3',
              it.read ? 'border-line-subtle' : 'border-forge-amber/40 bg-forge-amber/[0.06]',
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setExpandId(expandId === it.id ? null : it.id)}
                className="min-w-0 text-left"
              >
                <p className="truncate text-sm text-ink-primary">
                  {!it.read && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-forge-amber align-middle" />}
                  {it.topic}
                </p>
                <p className="mt-0.5 text-[11px] text-ink-faint">
                  {it.meetingType === 'partial' ? '临时协同会' : '全员会'}
                  {it.projectTag ? ` · ${it.projectTag}` : ''}
                  {' · '}{fmtTime(it.createdAt)}
                  {it.dispatchedThreadId ? ' · 已转任务' : ''}
                </p>
              </button>
              <div className="flex shrink-0 gap-2">
                {!it.read && (
                  <WbButton variant="secondary" disabled={busy}
                    onClick={() => void runAction(() => wbMutation('terminal.ccRead', { token, id: it.id }))}>
                    标记已读
                  </WbButton>
                )}
                {isHead && !it.dispatchedThreadId && (
                  <WbButton variant="secondary" disabled={busy}
                    onClick={() => {
                      setDispatchId(dispatchId === it.id ? null : it.id)
                      setInstruction('')
                    }}>
                    转任务
                  </WbButton>
                )}
                {it.dispatchedThreadId && (
                  <WbButton variant="secondary" onClick={onGoChat}>
                    继续对话 →
                  </WbButton>
                )}
              </div>
            </div>
            {expandId === it.id && it.summary && (
              <p className="mt-3 whitespace-pre-line border-t border-line-subtle pt-3 text-xs leading-relaxed text-ink-secondary">
                {it.summary}
              </p>
            )}
            {dispatchId === it.id && (
              <div className="mt-3 border-t border-line-subtle pt-3">
                <input
                  className={wbInputCls}
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="交办指令，如：请按纪要第三条输出本周执行方案"
                  maxLength={500}
                />
                <WbError message={opError} className="mt-2" />
                <WbButton className="mt-2" disabled={busy || instruction.trim().length < 2}
                  loading={busy}
                  onClick={() =>
                    void runAction(async () => {
                      await wbMutation('terminal.ccDispatch', { token, id: it.id, instruction: instruction.trim() })
                      setDispatchId(null)
                    })
                  }>
                  确认转交本部门智能体
                </WbButton>
              </div>
            )}
          </div>
        ))}
      </div>
      <WbError message={opError} className="mt-2" />
    </WbPanel>
  )
}

// ─── 迭代 37：班组协同（多 Agent 同事 + 并行 swarm + 四权介入）─────────────────

interface SwarmSeat {
  seatType: 'lead' | 'mate'
  seatId: number
  agentName: string
  title: string
  preferredModel: string
  specialty: string | null
  budgetDaily: number | null
  tokensToday: number
  status: string
}

interface SwarmListItem {
  id: number
  deptKey: string
  title: string
  status: string
  budgetCap: number | null
  tokensUsed: number
  budgetBlocked: boolean
  subCount: number
  doneCount: number
  createdBy: string
  createdAt: string
}

interface SwarmSubtask {
  id: number
  seq: number
  seatType: 'lead' | 'mate'
  seatId: number
  seatName: string
  model: string
  specialty: string | null
  brief: string
  instructionExtra: string | null
  status: string
  output: string | null
  provider: string | null
  degraded: boolean
  tokensUsed: number
}

interface SwarmDetailData {
  swarm: {
    id: number
    title: string
    instruction: string
    status: string
    budgetCap: number | null
    tokensUsed: number
    budgetBlocked: boolean
    summary: string | null
    summaryDegraded: boolean
    createdBy: string
  }
  subtasks: SwarmSubtask[]
  interventions: { id: number; subtaskId: number | null; actor: string; action: string; payload: string | null; createdAt: string }[]
}

const SWARM_STATUS_LABEL: Record<string, string> = {
  draft: '草案待确认',
  running: '执行中',
  paused: '已暂停',
  await_review: '待拍板',
  done: '已完成',
  cancelled: '已叫停',
}
const SUB_STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  paused: '已暂停',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  reassigned: '已重派',
}
const MODEL_LABEL: Record<string, string> = {
  kimi: 'Kimi · 长文',
  deepseek: 'DeepSeek · 推理',
  glm: 'GLM · 对话',
  minimax: 'MiniMax · 创意',
  // 2026-08-19 海禛云 /v1/models 全量同步扩标签（厂商键与后端 SWARM_MODEL_SLOT 对齐）
  claude: 'Claude · 旗舰',
  gpt: 'GPT · 通用',
  qwen: '通义 Qwen · 开源',
  'gpt-oss': 'GPT OSS · 开源',
  gemma: 'Gemma · 轻量',
  idoictos: '海禛云自研',
}
const IV_ACTION_LABEL: Record<string, string> = {
  inject: '插话',
  pause_one: '单点暂停',
  resume: '恢复',
  reassign: '换人重派',
  abort_all: '全局叫停',
  approve: '拍板通过',
  reject: '拍板打回',
}

function SwarmPanel({
  token,
  isHead,
  onAuthFail,
}: {
  token: string
  isHead: boolean
  onAuthFail: () => void
}) {
  const [seats, setSeats] = useState<{ lead: SwarmSeat | null; mates: SwarmSeat[] } | null>(null)
  const [list, setList] = useState<SwarmListItem[] | null>(null)
  const [detail, setDetail] = useState<SwarmDetailData | null>(null)
  const [activeSwarmId, setActiveSwarmId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // 配同事表单
  const [mateName, setMateName] = useState('')
  const [mateModel, setMateModel] = useState<'kimi' | 'deepseek' | 'glm' | 'minimax'>('glm')
  const [mateSpecialty, setMateSpecialty] = useState('')
  const [mateBudget, setMateBudget] = useState('')
  // 发起任务表单
  const [swTitle, setSwTitle] = useState('')
  const [swInstruction, setSwInstruction] = useState('')
  const [swBudget, setSwBudget] = useState('')
  // 迭代 38：附带资料
  const [docOptions, setDocOptions] = useState<{ id: number; title: string; parsedChars: number }[]>([])
  const [swDocIds, setSwDocIds] = useState<number[]>([])
  // 介入
  const [injectText, setInjectText] = useState<Record<number, string>>({})
  const [addBudget, setAddBudget] = useState('')
  const [rejectNote, setRejectNote] = useState('')
  const steppingRef = useRef(false)

  const guard = useCallback(
    (err: unknown) => {
      if (isWbAuthError(err)) onAuthFail()
      setError(wbErrorMessage(err))
    },
    [onAuthFail],
  )

  const loadSeats = useCallback(() => {
    wbQuery<{ lead: SwarmSeat | null; mates: SwarmSeat[] }>('terminal.mateList', { token })
      .then(setSeats)
      .catch(guard)
  }, [token, guard])

  const loadList = useCallback(() => {
    wbQuery<SwarmListItem[]>('terminal.swarmList', { token })
      .then(setList)
      .catch(guard)
  }, [token, guard])

  const loadDetail = useCallback(
    (id: number) => {
      wbQuery<SwarmDetailData>('terminal.swarmDetail', { token, swarmId: id })
        .then((d) => {
          setDetail(d)
          // 执行中且有排队子任务 → 自动推进一轮（幂等；staff 非负责人会被后端拒绝并静默）
          if (d.swarm.status === 'running' && d.subtasks.some((s) => s.status === 'queued') && !steppingRef.current) {
            steppingRef.current = true
            wbMutation('terminal.swarmStep', { token, swarmId: id })
              .catch(() => undefined)
              .finally(() => {
                steppingRef.current = false
              })
          }
        })
        .catch(guard)
    },
    [token, guard],
  )

  useEffect(() => {
    loadSeats()
    loadList()
    wbQuery<{ items: { id: number; title: string; parsedChars: number }[] }>('kb.docSearch', { token })
      .then((res) => setDocOptions(res.items))
      .catch(() => undefined)
  }, [loadSeats, loadList, token])

  // 作战室轮询（≤3s）
  useEffect(() => {
    if (activeSwarmId == null) return
    loadDetail(activeSwarmId)
    const timer = setInterval(() => loadDetail(activeSwarmId), 3000)
    return () => clearInterval(timer)
  }, [activeSwarmId, loadDetail])

  async function run(action: () => Promise<unknown>) {
    setError(null)
    setBusy(true)
    try {
      await action()
      loadSeats()
      loadList()
      if (activeSwarmId != null) loadDetail(activeSwarmId)
    } catch (err) {
      guard(err)
    } finally {
      setBusy(false)
    }
  }

  const allSeats: SwarmSeat[] = [...(seats?.lead ? [seats.lead] : []), ...(seats?.mates ?? [])]

  return (
    <div className="space-y-6">
      {/* 班组配置 */}
      <WbPanel title="班组配置" hud="DEPT SQUAD">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {allSeats.map((s) => (
            <div key={`${s.seatType}-${s.seatId}`} className="rounded-xl border border-line-subtle bg-void/30 px-4 py-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-ink-primary">{s.agentName}</p>
                <span
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[10px]',
                    s.seatType === 'lead'
                      ? 'border-forge-amber/40 text-forge-amber'
                      : s.status === 'active'
                        ? 'border-pulse-cyan/40 text-pulse-cyan'
                        : 'border-line-subtle text-ink-faint',
                  )}
                >
                  {s.seatType === 'lead' ? '主理' : s.status === 'active' ? '同事' : '已暂停'}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-ink-faint">
                {MODEL_LABEL[s.preferredModel] ?? s.preferredModel}
                {s.specialty ? ` · ${s.specialty}` : ''}
              </p>
              <p className="mt-1 text-[11px] text-ink-faint">
                今日消耗 {s.tokensToday} Token{s.budgetDaily != null ? ` / 日帽 ${s.budgetDaily}` : ' · 无日帽'}
              </p>
              {isHead && s.seatType === 'mate' && (
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        wbMutation('terminal.mateUpdate', {
                          token,
                          mateId: s.seatId,
                          status: s.status === 'active' ? 'paused' : 'active',
                        }),
                      )
                    }
                    className="rounded-[6px] border border-line-subtle px-2 py-0.5 text-[10px] text-ink-secondary hover:border-pulse-cyan/40"
                  >
                    {s.status === 'active' ? '暂停' : '恢复'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`确认移除同事「${s.agentName}」？`)) return
                      void run(() => wbMutation('terminal.mateUpdate', { token, mateId: s.seatId, status: 'removed' }))
                    }}
                    className="rounded-[6px] border border-line-subtle px-2 py-0.5 text-[10px] text-ink-secondary hover:border-ember-red/40 hover:text-ember-red"
                  >
                    移除
                  </button>
                </div>
              )}
            </div>
          ))}
          {seats && seats.mates.length === 0 && (
            <div className="rounded-xl border border-dashed border-line-subtle px-4 py-6 text-center text-xs text-ink-faint">
              还没有班组同事{isHead ? '，在下方配置' : '（需负责人配置）'}
            </div>
          )}
        </div>
        {isHead && (
          <div className="mt-4 rounded-xl border border-line-subtle bg-void/20 p-4">
            <p className="hud-label mb-2">+ 配同事（上限 4 位，按模型能力匹配）</p>
            <div className="flex flex-wrap gap-2">
              <input
                value={mateName}
                onChange={(e) => setMateName(e.target.value)}
                placeholder="同事名（如：小枢）"
                className="w-36 rounded-[8px] border border-line-subtle bg-void/40 px-3 py-1.5 text-xs"
              />
              <select
                value={mateModel}
                onChange={(e) => setMateModel(e.target.value as typeof mateModel)}
                className="rounded-[8px] border border-line-subtle bg-void/40 px-2 py-1.5 text-xs"
              >
                {Object.entries(MODEL_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <input
                value={mateSpecialty}
                onChange={(e) => setMateSpecialty(e.target.value)}
                placeholder="专长（文案/数据/视觉…）"
                className="w-44 rounded-[8px] border border-line-subtle bg-void/40 px-3 py-1.5 text-xs"
              />
              <input
                value={mateBudget}
                onChange={(e) => setMateBudget(e.target.value.replace(/\D/g, ''))}
                placeholder="日 Token 帽（可空）"
                className="w-32 rounded-[8px] border border-line-subtle bg-void/40 px-3 py-1.5 text-xs"
              />
              <WbButton
                disabled={busy || !mateName.trim()}
                onClick={() =>
                  run(async () => {
                    await wbMutation('terminal.mateCreate', {
                      token,
                      agentName: mateName.trim(),
                      preferredModel: mateModel,
                      specialty: mateSpecialty.trim() || undefined,
                      budgetDaily: mateBudget ? Number(mateBudget) : undefined,
                    })
                    setMateName('')
                    setMateSpecialty('')
                    setMateBudget('')
                  })
                }
              >
                配置
              </WbButton>
            </div>
          </div>
        )}
      </WbPanel>

      {/* 任务作战室 */}
      <WbPanel title="任务作战室" hud="SWARM OPS">
        {isHead && (
          <div className="mb-4 rounded-xl border border-line-subtle bg-void/20 p-4">
            <p className="hud-label mb-2">一句话派活 → 拆解草案 → 你确认后并行执行</p>
            <div className="flex flex-wrap gap-2">
              <input
                value={swTitle}
                onChange={(e) => setSwTitle(e.target.value)}
                placeholder="任务标题"
                className="w-52 rounded-[8px] border border-line-subtle bg-void/40 px-3 py-1.5 text-xs"
              />
              <input
                value={swBudget}
                onChange={(e) => setSwBudget(e.target.value.replace(/\D/g, ''))}
                placeholder="预算帽 Token（可空）"
                className="w-36 rounded-[8px] border border-line-subtle bg-void/40 px-3 py-1.5 text-xs"
              />
            </div>
            <textarea
              value={swInstruction}
              onChange={(e) => setSwInstruction(e.target.value)}
              placeholder="任务指令（总目标，班组各同事将从各自专长角度分工产出）"
              rows={2}
              className="mt-2 w-full rounded-[8px] border border-line-subtle bg-void/40 px-3 py-2 text-xs"
            />
            {docOptions.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-ink-faint">附带资料：</span>
                {docOptions.slice(0, 10).map((d) => {
                  const on = swDocIds.includes(d.id)
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() =>
                        setSwDocIds((prev) => (on ? prev.filter((x) => x !== d.id) : prev.length >= 5 ? prev : [...prev, d.id]))
                      }
                      className={cn(
                        'rounded-full border px-2.5 py-0.5 text-[11px] transition-colors duration-300',
                        on ? 'border-forge-amber/50 bg-forge-amber/[0.12] text-forge-amber' : 'border-line-subtle text-ink-secondary hover:border-pulse-cyan/40',
                      )}
                    >
                      {d.title}
                      {d.parsedChars > 0 ? '' : '（存档）'}
                    </button>
                  )
                })}
              </div>
            )}
            <div className="mt-2">
              <WbButton
                disabled={busy || !swTitle.trim() || !swInstruction.trim() || !seats || seats.mates.length === 0}
                onClick={() =>
                  run(async () => {
                    const res = await wbMutation<{ swarmId: number }>('terminal.swarmCreate', {
                      token,
                      title: swTitle.trim(),
                      instruction: swInstruction.trim(),
                      budgetCap: swBudget ? Number(swBudget) : undefined,
                    })
                    setSwTitle('')
                    setSwInstruction('')
                    setSwBudget('')
                    setActiveSwarmId(res.swarmId)
                  })
                }
              >
                发起协同
              </WbButton>
              {seats && seats.mates.length === 0 && (
                <span className="ml-2 text-[11px] text-ink-faint">先在上方配置班组同事</span>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
          {/* 任务列表 */}
          <div className="space-y-2">
            <p className="hud-label">协同任务</p>
            {(list ?? []).length === 0 && <WbEmpty text="暂无协同任务" hint="负责人发起后会出现在这里。" />}
            {(list ?? []).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setActiveSwarmId(s.id)}
                className={cn(
                  'w-full rounded-[10px] border px-3 py-2.5 text-left transition-colors duration-300',
                  activeSwarmId === s.id ? 'border-forge-amber/50 bg-forge-amber/[0.08]' : 'border-line-subtle hover:border-pulse-cyan/30',
                )}
              >
                <p className="truncate text-xs font-semibold text-ink-primary">{s.title}</p>
                <p className="mt-1 flex items-center justify-between text-[10px] text-ink-faint">
                  <span>{SWARM_STATUS_LABEL[s.status] ?? s.status}</span>
                  <span>
                    {s.doneCount}/{s.subCount} · {s.tokensUsed}T
                  </span>
                </p>
              </button>
            ))}
          </div>

          {/* 实时面板 */}
          <div>
            {!detail && <WbEmpty text="选择左侧任务查看作战面板" hint="执行中每 3 秒自动刷新。" />}
            {detail && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-ink-primary">{detail.swarm.title}</p>
                    <p className="mt-0.5 text-[11px] text-ink-faint">
                      {SWARM_STATUS_LABEL[detail.swarm.status] ?? detail.swarm.status} · 消耗 {detail.swarm.tokensUsed} Token
                      {detail.swarm.budgetCap != null ? ` / 帽 ${detail.swarm.budgetCap}` : ''} · 发起人 {detail.swarm.createdBy}
                    </p>
                  </div>
                  {isHead && ['running', 'paused'].includes(detail.swarm.status) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm('确认全局叫停？全体子任务终止，产出保留。')) return
                        void run(() => wbMutation('terminal.swarmIntervene', { token, swarmId: detail.swarm.id, action: 'abort_all' }))
                      }}
                      className="rounded-[8px] border border-ember-red/40 px-3 py-1.5 text-xs text-ember-red"
                    >
                      全局叫停
                    </button>
                  )}
                </div>

                {detail.swarm.budgetBlocked && (
                  <div className="rounded-lg border border-ember-red/40 bg-ember-red/[0.08] px-3 py-2 text-xs text-ember-red">
                    预算帽触发，已自动暂停。
                    {isHead && (
                      <span className="ml-2 inline-flex items-center gap-1">
                        <input
                          value={addBudget}
                          onChange={(e) => setAddBudget(e.target.value.replace(/\D/g, ''))}
                          placeholder="追加 Token"
                          className="w-24 rounded-[6px] border border-line-subtle bg-void/40 px-2 py-1 text-[11px]"
                        />
                        <button
                          type="button"
                          disabled={busy || !addBudget}
                          onClick={() =>
                            run(() =>
                              wbMutation('terminal.swarmAddBudget', { token, swarmId: detail.swarm.id, addTokens: Number(addBudget) }),
                            )
                          }
                          className="rounded-[6px] border border-forge-amber/40 px-2 py-1 text-[11px] text-forge-amber"
                        >
                          追加并续跑
                        </button>
                      </span>
                    )}
                  </div>
                )}

                {detail.swarm.status === 'draft' && isHead && (
                  <div className="rounded-lg border border-forge-amber/40 bg-forge-amber/[0.08] px-3 py-2 text-xs text-forge-amber">
                    草案已拆解为 {detail.subtasks.length} 个子任务，确认后立即并行执行。
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => run(() => wbMutation('terminal.swarmConfirm', { token, swarmId: detail.swarm.id }))}
                      className="ml-2 rounded-[6px] border border-forge-amber/50 px-2 py-1 text-[11px]"
                    >
                      确认执行
                    </button>
                  </div>
                )}

                {/* 子任务进度 */}
                {detail.subtasks.map((st) => (
                  <div key={st.id} className="rounded-xl border border-line-subtle bg-void/30 px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-ink-primary">
                        #{st.seq} {st.seatName}
                        <span className="ml-2 rounded-full border border-pulse-cyan/40 px-1.5 py-0.5 text-[10px] font-normal text-pulse-cyan">
                          {MODEL_LABEL[st.model] ?? st.model}
                        </span>
                      </p>
                      <span className="text-[10px] text-ink-faint">
                        {SUB_STATUS_LABEL[st.status] ?? st.status}
                        {st.tokensUsed > 0 ? ` · ${st.tokensUsed}T` : ''}
                        {st.provider ? ` · ${st.provider}` : ''}
                        {st.degraded ? ' · 降级' : ''}
                      </span>
                    </div>
                    {st.instructionExtra && <p className="mt-1 text-[11px] text-forge-amber">插话：{st.instructionExtra}</p>}
                    {st.output && (
                      <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-void/40 p-2.5 text-[11px] leading-relaxed text-ink-secondary">
                        {st.output}
                      </pre>
                    )}
                    {isHead && ['running', 'paused'].includes(detail.swarm.status) && ['queued', 'running', 'paused', 'done'].includes(st.status) && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input
                          value={injectText[st.id] ?? ''}
                          onChange={(e) => setInjectText((p) => ({ ...p, [st.id]: e.target.value }))}
                          placeholder="插话追加指令…"
                          className="w-44 rounded-[6px] border border-line-subtle bg-void/40 px-2 py-1 text-[11px]"
                        />
                        <button
                          type="button"
                          disabled={busy || !(injectText[st.id] ?? '').trim()}
                          onClick={() =>
                            run(() =>
                              wbMutation('terminal.swarmIntervene', {
                                token,
                                swarmId: detail.swarm.id,
                                action: 'inject',
                                subtaskId: st.id,
                                text: (injectText[st.id] ?? '').trim(),
                              }),
                            )
                          }
                          className="rounded-[6px] border border-line-subtle px-2 py-1 text-[10px] text-ink-secondary hover:border-forge-amber/40"
                        >
                          插话
                        </button>
                        {['queued', 'running'].includes(st.status) && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              run(() =>
                                wbMutation('terminal.swarmIntervene', { token, swarmId: detail.swarm.id, action: 'pause_one', subtaskId: st.id }),
                              )
                            }
                            className="rounded-[6px] border border-line-subtle px-2 py-1 text-[10px] text-ink-secondary hover:border-ember-red/40"
                          >
                            暂停
                          </button>
                        )}
                        {st.status === 'paused' && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              run(() =>
                                wbMutation('terminal.swarmIntervene', { token, swarmId: detail.swarm.id, action: 'resume', subtaskId: st.id }),
                              )
                            }
                            className="rounded-[6px] border border-line-subtle px-2 py-1 text-[10px] text-pulse-cyan hover:border-pulse-cyan/40"
                          >
                            恢复
                          </button>
                        )}
                        <select
                          defaultValue=""
                          disabled={busy}
                          onChange={(e) => {
                            const v = e.target.value
                            e.target.value = ''
                            if (!v) return
                            const [t, id] = v.split(':')
                            void run(() =>
                              wbMutation('terminal.swarmIntervene', {
                                token,
                                swarmId: detail.swarm.id,
                                action: 'reassign',
                                subtaskId: st.id,
                                newSeatType: t as 'lead' | 'mate',
                                newSeatId: t === 'mate' ? Number(id) : undefined,
                              }),
                            )
                          }}
                          className="rounded-[6px] border border-line-subtle bg-void/40 px-2 py-1 text-[10px]"
                        >
                          <option value="">换人重派…</option>
                          {allSeats
                            .filter((s) => s.status === 'active' && !(s.seatType === st.seatType && s.seatId === st.seatId))
                            .map((s) => (
                              <option key={`${s.seatType}-${s.seatId}`} value={`${s.seatType}:${s.seatId}`}>
                                {s.agentName}（{MODEL_LABEL[s.preferredModel] ?? s.preferredModel}）
                              </option>
                            ))}
                        </select>
                      </div>
                    )}
                  </div>
                ))}

                {/* 汇总与拍板 */}
                {detail.swarm.summary && (
                  <div className="rounded-xl border border-forge-amber/30 bg-forge-amber/[0.05] px-4 py-3">
                    <p className="hud-label mb-1">主理汇总{detail.swarm.summaryDegraded ? '（降级）' : ''}</p>
                    <pre className="whitespace-pre-wrap text-xs leading-relaxed text-ink-secondary">{detail.swarm.summary}</pre>
                    {detail.swarm.status === 'await_review' && isHead && (
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <WbButton disabled={busy} onClick={() => run(() => wbMutation('terminal.swarmReview', { token, swarmId: detail.swarm.id, action: 'approve' }))}>
                          拍板通过
                        </WbButton>
                        <input
                          value={rejectNote}
                          onChange={(e) => setRejectNote(e.target.value)}
                          placeholder="打回意见…"
                          className="w-48 rounded-[8px] border border-line-subtle bg-void/40 px-3 py-1.5 text-xs"
                        />
                        <button
                          type="button"
                          disabled={busy || !rejectNote.trim()}
                          onClick={() =>
                            run(() => wbMutation('terminal.swarmReview', { token, swarmId: detail.swarm.id, action: 'reject', note: rejectNote.trim() }))
                          }
                          className="rounded-[8px] border border-ember-red/40 px-3 py-1.5 text-xs text-ember-red"
                        >
                          拍板打回
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* 介入留痕 */}
                {detail.interventions.length > 0 && (
                  <div>
                    <p className="hud-label mb-1.5">介入留痕</p>
                    <ul className="space-y-1">
                      {detail.interventions.map((v) => (
                        <li key={v.id} className="text-[11px] text-ink-faint">
                          {fmtTime(v.createdAt)} · {v.actor} · {IV_ACTION_LABEL[v.action] ?? v.action}
                          {v.subtaskId ? ` · 子任务#${v.subtaskId}` : ''}
                          {v.payload ? ` · ${v.payload.slice(0, 80)}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </WbPanel>

      {error && <WbError message={error} />}
    </div>
  )
}

// ─── B2 员工主动性：主动消息条（evo 周报 + 近 48h 产出进展）────────────────────
interface ProactiveItem { type: 'weekly_report' | 'artifact'; title: string; body: string; at: string | null }

function ProactiveInbox({ token }: { token: string }) {
  const [items, setItems] = useState<ProactiveItem[] | null>(null)
  useEffect(() => {
    wbQuery<{ items: ProactiveItem[] }>('terminal.proactiveInbox', { token })
      .then((res) => setItems(res.items))
      .catch(() => setItems([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])
  if (!items || items.length === 0) return null
  return (
    <WbPanel title="员工来报" hud="PROACTIVE · 数字员工主动汇报" className="mb-6">
      <ul className="space-y-2">
        {items.slice(0, 4).map((it, i) => (
          <li key={i} className="rounded-xl border border-line-subtle bg-void/40 px-4 py-3">
            <p className="flex items-center gap-2 text-sm font-medium text-ink-primary">
              <span className={cn('inline-block h-2 w-2 rounded-full', it.type === 'weekly_report' ? 'bg-forge-amber' : 'bg-jade-green')} />
              {it.title}
            </p>
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-secondary">{it.body}</p>
          </li>
        ))}
      </ul>
    </WbPanel>
  )
}

export default function StaffWorkspace() {
  const { session, clear } = useStaffSession()
  const navigate = useNavigate()
  const [home, setHome] = useState<DeptHomeData | null>(null)
  const [homeError, setHomeError] = useState<string | null>(null)
  const [activeAgent, setActiveAgent] = useState<DeptAgent | null>(null)
  const [activeTab, setActiveTab] = useState<'workspace' | 'meeting' | 'swarm' | 'config' | 'kb' | 'approval'>('workspace')

  const handleAuthFail = useCallback(() => {
    clearStaffSession()
    navigate('/staff/login', { replace: true })
  }, [navigate])

  // staff.me 校验会话有效性（单点 token 被覆盖/停用时自动退出）
  useEffect(() => {
    if (!session?.token) return
    wbQuery('staff.me', { token: session.token }).catch((err) => {
      if (isWbAuthError(err)) handleAuthFail()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token])

  useEffect(() => {
    if (!session?.token) return
    wbQuery<DeptHomeData>('staff.deptHome', { token: session.token })
      .then((res) => {
        setHome(res)
        setHomeError(null)
        setActiveAgent((prev) => prev ?? res.agents[0] ?? null)
      })
      .catch((err) => {
        if (isWbAuthError(err)) return handleAuthFail()
        setHomeError(wbErrorMessage(err))
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token])

  if (!session?.token) {
    return <Navigate to="/staff/login" replace />
  }

  function handleLogout() {
    clear()
    navigate('/staff/login', { replace: true })
  }

  const roleLabel = ROLE_LABEL[session.role] ?? session.role

  return (
    <div className="cyber-grid-bg min-h-screen bg-void text-ink-primary">
      {/* 顶栏 */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line-subtle bg-void/85 px-6 py-3.5 backdrop-blur">
        <div className="flex items-center gap-2.5">
          <img src="/logo-mark.png" alt="NumX Max" className="h-7 w-7 shrink-0 object-contain" />
          <div>
            <p className="font-display text-sm font-bold">
              {home?.dept.name ?? session.deptName} · 部门工作台
            </p>
            <p className="hud-label mt-0.5 text-[10px] text-forge-amber/70">NEBULA DEPT WORKSPACE</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-2 rounded-full border border-forge-amber/30 bg-forge-amber/[0.08] px-3 py-1 text-xs text-forge-amber">
            <Users className="h-3.5 w-3.5" />
            {session.displayName}
            <span className="text-ink-faint">· {roleLabel}</span>
          </span>
          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex items-center gap-1.5 rounded-[8px] border border-line-subtle px-3 py-1.5 text-xs text-ink-secondary transition-colors duration-300 hover:border-ember-red/40 hover:text-ember-red"
          >
            <LogOut className="h-3.5 w-3.5" />
            退出
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">
        {home === null && !homeError && <WbLoading />}
        <WbError message={homeError} />

        {home && (
          <>
            <ProactiveInbox token={session.token} />
            {/* 分区 Tab：工作台 / 协同会议室 / 圆桌配置 / 部门知识库 */}
            <div className="mb-6 flex flex-wrap gap-2 border-b border-line-subtle pb-3">
              {(
                [
                  { key: 'workspace', label: '工作台' },
                  { key: 'meeting', label: '协同会议室' },
                  { key: 'swarm', label: '班组协同' },
                  { key: 'config', label: '圆桌配置' },
                  { key: 'kb', label: '部门资料夹' },
                  ...(home.me.role === 'head' ? [{ key: 'approval', label: '审批中心' } as const] : []),
                ] as const
              ).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setActiveTab(t.key)}
                  className={cn(
                    'rounded-[8px] border px-3.5 py-1.5 text-xs transition-colors duration-300',
                    activeTab === t.key
                      ? 'border-forge-amber/40 bg-forge-amber/[0.12] text-forge-amber'
                      : 'border-line-subtle text-ink-secondary hover:border-pulse-cyan/40 hover:text-ink-primary',
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {activeTab === 'meeting' && (
              <MeetingPanel token={session.token} isHead={home.me.role === 'head'} myDeptKey={home.me.deptKey} onAuthFail={handleAuthFail} />
            )}
            {activeTab === 'swarm' && (
              <SwarmPanel token={session.token} isHead={home.me.role === 'head'} onAuthFail={handleAuthFail} />
            )}
            {activeTab === 'config' && (
              <RoundConfigPanel
                token={session.token}
                isHead={home.me.role === 'head'}
                myDeptKey={home.me.deptKey}
                onAuthFail={handleAuthFail}
              />
            )}
            {activeTab === 'kb' && (
              <DeptKbPanel
                token={session.token}
                isHead={home.me.role === 'head'}
                myDeptKey={home.me.deptKey}
                onAuthFail={handleAuthFail}
              />
            )}
            {activeTab === 'approval' && home.me.role === 'head' && (
              <TenantApprovalPanel token={session.token} onAuthFail={handleAuthFail} />
            )}

            {activeTab === 'workspace' && (
            <>
            {/* 部门信息卡 */}
            <WbPanel title={`${home.dept.name} · 部门信息`} hud="DEPT INFO">
              <p className="text-sm leading-relaxed text-ink-secondary">{home.dept.duty || '部门职责说明待补充。'}</p>
              <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                <div className="rounded-xl border border-line-subtle bg-void/30 px-4 py-3">
                  <p className="hud-label">部门成员</p>
                  <p className="mt-1.5 font-display text-xl font-bold text-forge-amber">{home.memberCount}</p>
                </div>
                <div className="rounded-xl border border-line-subtle bg-void/30 px-4 py-3">
                  <p className="hud-label">驻部智能体</p>
                  <p className="mt-1.5 font-display text-xl font-bold text-forge-amber">{home.agents.length}</p>
                </div>
                <div className="col-span-2 rounded-xl border border-line-subtle bg-void/30 px-4 py-3">
                  <p className="hud-label">最近会议</p>
                  {home.recentMeetings.length === 0 ? (
                    <p className="mt-1.5 text-xs text-ink-faint">共生工作空间暂无会议记录</p>
                  ) : (
                    <ul className="mt-1.5 space-y-1">
                      {home.recentMeetings.slice(0, 3).map((m) => (
                        <li key={m.id} className="flex items-center justify-between gap-3 text-xs text-ink-secondary">
                          <span className="truncate">{m.topic}</span>
                          <span className="shrink-0 text-ink-faint">{fmtTime(m.createdAt)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </WbPanel>

            {/* 迭代 36：会议抄送收件箱 */}
            <CcInboxPanel
              token={session.token}
              isHead={home.me.role === 'head'}
              onAuthFail={handleAuthFail}
              onGoChat={() => setActiveTab('workspace')}
            />

            {/* 驻部 Agent 对话区 */}
            <WbPanel title="驻部智能体对话" hud="DEPT AGENTS" className="mt-6">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[220px_1fr]">
                <div className="space-y-2">
                  <p className="hud-label mb-1">本部门智能体</p>
                  {home.agents.map((a) => (
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
                  {home.agents.length === 0 && (
                    <p className="text-xs text-ink-faint">本部门暂无驻部智能体</p>
                  )}
                </div>
                <div>
                  {activeAgent ? (
                    <AgentChatWindow
                      key={activeAgent.code}
                      token={session.token}
                      agent={activeAgent}
                      onAuthFail={handleAuthFail}
                    />
                  ) : (
                    <WbEmpty
                      text="选择左侧驻部智能体开始对话"
                      hint="对话上下文已注入两系统实时数据摘要。"
                    />
                  )}
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2 text-[11px] text-ink-faint">
                <Bot className="h-3.5 w-3.5" />
                仅可与本部门驻部智能体对话；回复均基于统一库两系统实时数据。
              </div>
            </WbPanel>

            {/* 负责人专属：员工账号分发 */}
            {home.me.role === 'head' && <MemberPanel token={session.token} onAuthFail={handleAuthFail} />}
            </>
            )}
          </>
        )}
      </main>
    </div>
  )
}
