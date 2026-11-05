/**
 * DeptConsoles（/admin/dept-consoles）—— 运营/品牌/市场三部门独立管理工作台。
 * 左列三张部门卡（主官/驻部数/DSH 引擎/模型槽位），右侧工作台：
 * ① 配置区：任命主官、驻部智能体组、DSH 开关、模型槽位（deptConsole.*）
 * ② DSH 内嵌对话窗：直接向部门主官交办任务，默认 DSH 底座深度执行轨；
 *    模型统一走 modelGateway（海禛云优先，自动降级）。
 * 与超级终端天然打通（本页即超终一屏）；APP 侧经同一 deptConsole API 复用。
 */
import { useMemo, useRef, useState } from 'react'
import { Bot, Crown, Paperclip, RefreshCw, Send, Settings2, Sparkles, Users } from 'lucide-react'
import { useWbSession, useWbQuery, wbMutation, wbErrorMessage } from '@/lib/wbSession'
import {
  WbButton,
  WbEmpty,
  WbError,
  WbLoading,
  WbPageHeader,
  WbPanel,
  WbStat,
  wbInputCls,
} from '@/components/wb/ui'
import { adminConfirm } from './shared'
import { cn } from '@/lib/utils'

type DeptCode = 'ops' | 'brand' | 'marketing' | 'tech' | 'finance' | 'legal'

interface ConsoleItem {
  deptCode: DeptCode
  deptName: string
  chiefAgentCode: string | null
  chiefAgent: { code: string; name: string; title: string } | null
  agentCodes: string[]
  agentCount: number
  dshEnabled: boolean
  modelSlot: string
  allowedModels?: string[] | null // M79 部门适配模型集合
  staffDeptKeys: string[]
  updatedAt: string
}

interface AgentOption {
  code: string
  name: string
  title: string
  deptCode: string
}

interface ChatMsg {
  role: 'user' | 'agent'
  content: string
  runtime?: 'bridge' | 'dsh'
  agentName?: string
}

const SLOT_LABEL: Record<string, string> = {
  brain: '深思档 brain',
  orggen: '组织档 orggen',
  chat: '对话档 chat',
  flash: '快答档 flash',
  creative: '创意档 creative',
}

const DEPT_TINT: Record<DeptCode, string> = {
  ops: 'border-pulse-cyan/30',
  brand: 'border-forge-amber/30',
  marketing: 'border-fuchsia-400/30',
  tech: 'border-emerald-400/30',
  finance: 'border-yellow-400/30',
  legal: 'border-sky-400/30',
}

const DEPT_SHORT: Record<DeptCode, string> = {
  ops: '运营部', brand: '品牌部', marketing: '市场部', tech: '技术部', finance: '财务部', legal: '法务部',
}

const PANDA_ROLE_LABEL: Record<string, string> = {
  co: '指挥官',
  ex: '执行者',
  va: '监察者',
  ev: '学习者',
}

interface LibSkill {
  key: string
  name: string
  layer: string
  description: string
}

interface EquippedSkill {
  skillKey: string
  name: string
  layer: string
}

interface CollabItem {
  id: number
  fromDeptName: string
  toDeptName: string
  fromAgent: string
  toAgent: string
  message: string
  reply: string
  runtime: string
  createdAt: string
}

interface MeetingItem {
  id: number
  topic: string
  status: string
  roomType: string
  participants: string
  createdAt: string
}

interface OverviewData {
  deptCode: DeptCode
  deptName: string
  chiefAgent: { code: string; name: string; title: string } | null
  dshEnabled: boolean
  modelSlot: string
  agents: { code: string; name: string; title: string; active: boolean }[]
  pandaSeats: { role: string; duty: string; refType: string; refKey: string; enabled: boolean }[]
  artifacts7d: number
}

export default function AdminDeptConsoles() {
  const { session } = useWbSession()
  const [selected, setSelected] = useState<DeptCode>('ops')
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const [chiefPick, setChiefPick] = useState('')
  const [agentPick, setAgentPick] = useState('')
  const [staffKeysDraft, setStaffKeysDraft] = useState('')
  const [chatInput, setChatInput] = useState('')
  const [chatLog, setChatLog] = useState<Partial<Record<DeptCode, ChatMsg[]>>>({})
  const [sending, setSending] = useState(false)

  const { data, error, loading, refetch } = useWbQuery<ConsoleItem[]>(
    'deptConsole.listConsoles',
    session,
    {},
  )
  const { data: ov } = useWbQuery<OverviewData>('deptConsole.overview', session, { deptCode: selected })
  const { data: library } = useWbQuery<LibSkill[]>('pluginStore.library', session, {})
  const { data: equipped, refetch: refetchEquipped } = useWbQuery<EquippedSkill[]>(
    'deptConsole.equippedSkills',
    session,
    { deptCode: selected },
  )
  const [skillPick, setSkillPick] = useState('')
  const [collabTarget, setCollabTarget] = useState('')
  const [collabMsg, setCollabMsg] = useState('')
  const [collabSending, setCollabSending] = useState(false)
  const collabFileRef = useRef<HTMLInputElement>(null)
  const { data: feed, refetch: refetchFeed } = useWbQuery<CollabItem[]>('deptConsole.collabFeed', session, {})
  // 临时会议
  const [mtTopic, setMtTopic] = useState('')
  const [mtScope, setMtScope] = useState<'dept' | 'cross' | 'all'>('dept')
  const [mtCross, setMtCross] = useState<DeptCode[]>([])
  const [mtBusy, setMtBusy] = useState(false)
  const [mtMsg, setMtMsg] = useState<string | null>(null)
  const { data: meetings, refetch: refetchMeetings } = useWbQuery<MeetingItem[]>('deptConsole.meetingList', session, {})
  // 任命池 = 内置主官花名册（deptConsole.officers；Panda 四模型为平台常设席位，不参与任命）
  const { data: officerData } = useWbQuery<AgentOption[]>('deptConsole.officers', session, {})
  const agents = useMemo(() => officerData ?? [], [officerData])

  const current = (data ?? []).find((d) => d.deptCode === selected)

  function run(mut: Promise<unknown>, okMsg: string) {
    setNotice(null)
    setActionError(null)
    setPending(true)
    mut
      .then(() => {
        setNotice(okMsg)
        refetch()
      })
      .catch((err) => setActionError(wbErrorMessage(err)))
      .finally(() => setPending(false))
  }

  function submitChief() {
    if (!chiefPick) return
    if (!adminConfirm(`任命「${chiefPick}」为${current?.deptName}主官？`)) return
    run(
      wbMutation('deptConsole.setChief', { token: session!.token, deptCode: selected, agentCode: chiefPick }),
      '主官任命已生效',
    )
    setChiefPick('')
  }

  function addAgent() {
    if (!agentPick || !current) return
    if (current.agentCodes.includes(agentPick)) return
    run(
      wbMutation('deptConsole.setAgents', {
        token: session!.token,
        deptCode: selected,
        agentCodes: [...current.agentCodes, agentPick],
      }),
      '驻部智能体已更新',
    )
    setAgentPick('')
  }

  function removeAgent(code: string) {
    if (!current) return
    if (!adminConfirm(`将「${code}」移出${current.deptName}驻部组？`)) return
    run(
      wbMutation('deptConsole.setAgents', {
        token: session!.token,
        deptCode: selected,
        agentCodes: current.agentCodes.filter((c) => c !== code),
      }),
      '驻部智能体已更新',
    )
  }

  function toggleDsh() {
    if (!current) return
    run(
      wbMutation('deptConsole.setEngine', {
        token: session!.token,
        deptCode: selected,
        dshEnabled: !current.dshEnabled,
      }),
      current.dshEnabled ? '已切换为快速通道（bridge）' : '已启用 DSH 深度引擎',
    )
  }

  function changeSlot(slot: string) {
    run(
      wbMutation('deptConsole.setEngine', { token: session!.token, deptCode: selected, modelSlot: slot }),
      '模型槽位已更新',
    )
  }

  function onCollabFile(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0]
    ev.target.value = ''
    if (!file || collabSending || !collabTarget) return
    if (file.size > 8 * 1024 * 1024) {
      setActionError('文件过大（上限 8MB）')
      return
    }
    setCollabSending(true)
    setNotice(null)
    setActionError(null)
    const reader = new FileReader()
    reader.onload = () => {
      const b64 = String(reader.result).split(',')[1] ?? ''
      wbMutation<{ title: string }>('wbFiles.upload', {
        token: session!.token,
        title: `协作附件·${file.name}`.slice(0, 64),
        fileName: file.name.slice(0, 128),
        mimeType: file.type || 'application/octet-stream',
        fileBase64: b64,
      })
        .then((r) =>
          wbMutation('deptConsole.delegate', {
            token: session!.token,
            fromDept: selected,
            toDept: collabTarget,
            message: `【协作附件】《${r.title}》已入企业附件库。${collabMsg.trim() || '请围绕附件办理。'}`,
          }),
        )
        .then(() => {
          setNotice(`附件「${file.name}」已随协作单送达对方主官`)
          setCollabMsg('')
          refetchFeed()
        })
        .catch((e) => setActionError(wbErrorMessage(e)))
        .finally(() => setCollabSending(false))
    }
    reader.onerror = () => {
      setActionError('文件读取失败')
      setCollabSending(false)
    }
    reader.readAsDataURL(file)
  }

  function sendCollab() {
    const msg = collabMsg.trim()
    if (!msg || !collabTarget || collabSending) return
    setCollabSending(true)
    setNotice(null)
    setActionError(null)
    wbMutation<{ to: { agent: string } }>('deptConsole.delegate', {
      token: session!.token,
      fromDept: selected,
      toDept: collabTarget,
      message: msg,
    })
      .then((r) => {
        setNotice(`协作已送达，${r.to.agent} 已回执（见下方台账）`)
        setCollabMsg('')
        setCollabTarget('')
        refetchFeed()
      })
      .catch((e) => setActionError(wbErrorMessage(e)))
      .finally(() => setCollabSending(false))
  }

  function startMeeting() {
    const topic = mtTopic.trim()
    if (!topic || mtBusy) return
    if (mtScope === 'cross' && mtCross.length < 2) {
      setActionError('跨部门会议需至少勾选 2 个部门')
      return
    }
    setMtBusy(true)
    setMtMsg(null)
    setActionError(null)
    wbMutation<{ meetingId: number }>('deptConsole.meetingStart', {
      token: session!.token,
      topic,
      scope: mtScope,
      deptCode: mtScope === 'dept' ? selected : undefined,
      participantDepts: mtScope === 'cross' ? mtCross : undefined,
      opening: `临时会议召集：${topic}`,
    })
      .then((r) => {
        setMtMsg(`会议 #${r.meetingId} 已召集——召集链接 /admin/meeting/${r.meetingId}（发给参会部门点击即入）`)
        setMtTopic('')
        setMtCross([])
        refetchMeetings()
      })
      .catch((e) => setActionError(wbErrorMessage(e)))
      .finally(() => setMtBusy(false))
  }

  function meetingAction(id: number, kind: 'round' | 'summarize') {
    setMtBusy(true)
    setActionError(null)
    wbMutation(kind === 'round' ? 'deptConsole.meetingRound' : 'deptConsole.meetingSummarize', {
      token: session!.token,
      meetingId: id,
    })
      .then(() => {
        setMtMsg(kind === 'round' ? `会议 #${id} 已推进一轮` : `会议 #${id} 纪要已收口`)
        refetchMeetings()
      })
      .catch((e) => setActionError(wbErrorMessage(e)))
      .finally(() => setMtBusy(false))
  }

  function sendChat() {
    const msg = chatInput.trim()
    if (!msg || sending) return
    setSending(true)
    setChatLog((m) => ({ ...m, [selected]: [...(m[selected] ?? []), { role: 'user', content: msg }] }))
    setChatInput('')
    wbMutation<{
      ok: boolean
      runtime: 'bridge' | 'dsh'
      agent: { name: string }
      reply: string
    }>('deptConsole.chat', { token: session!.token, deptCode: selected, message: msg })
      .then((r) => {
        setChatLog((m) => ({
          ...m,
          [selected]: [
            ...(m[selected] ?? []),
            { role: 'agent', content: r.reply, runtime: r.runtime, agentName: r.agent?.name },
          ],
        }))
      })
      .catch((err) => {
        setChatLog((m) => ({
          ...m,
          [selected]: [...(m[selected] ?? []), { role: 'agent', content: `（发送失败：${wbErrorMessage(err)}）` }],
        }))
      })
      .finally(() => setSending(false))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <WbPageHeader
          hud="DEPT CONSOLES"
          title="部门工作台"
          desc="运营 / 品牌 / 市场 · 配置驻部智能体与主官 · 内嵌 DeepSeek Harness 深度引擎 · 统一海禛云模型网关"
        />
        <WbButton variant="secondary" onClick={() => refetch()} disabled={loading} className="mt-2">
          <RefreshCw className={cn('mr-1 h-4 w-4', loading && 'animate-spin')} />
          刷新
        </WbButton>
      </div>

      {error && <WbError message={error} />}
      {notice && <div className="rounded-[10px] border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-300">{notice}</div>}
      {actionError && <WbError message={actionError} />}

      {loading && !data && <WbLoading />}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[320px_1fr]">
        {/* 左列：三张部门卡 */}
        <div className="space-y-3">
          {(data ?? []).map((d) => (
            <button
              key={d.deptCode}
              onClick={() => setSelected(d.deptCode)}
              className={cn(
                'w-full rounded-[14px] border bg-white/[0.02] p-4 text-left transition-colors',
                DEPT_TINT[d.deptCode],
                selected === d.deptCode ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]',
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-base font-semibold text-ink-primary">{d.deptName}</span>
                {d.dshEnabled ? (
                  <span className="flex items-center gap-1 rounded-full bg-forge-amber/15 px-2 py-0.5 text-[11px] text-forge-amber">
                    <Sparkles className="h-3 w-3" /> DSH 深度引擎
                  </span>
                ) : (
                  <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-ink-secondary">快速通道</span>
                )}
              </div>
              <div className="mt-2 flex items-center gap-2 text-sm text-ink-secondary">
                <Crown className="h-3.5 w-3.5 text-forge-amber" />
                {d.chiefAgent ? `${d.chiefAgent.name}（${d.chiefAgent.title}）` : '主官未任命'}
              </div>
              <div className="mt-1 flex items-center gap-2 text-sm text-ink-secondary">
                <Users className="h-3.5 w-3.5" />
                驻部 {d.agentCount} 人 · {SLOT_LABEL[d.modelSlot] ?? d.modelSlot}
                {Array.isArray(d.allowedModels) && d.allowedModels.length > 0 ? ` · 适配 ${d.allowedModels.length} 模型` : ''}
              </div>
            </button>
          ))}
        </div>

        {/* 右侧：驾驶舱级部门总览 + 配置区 + DSH 对话窗 */}
        <div className="space-y-4">
          {current ? (
            <>
              {/* 驾驶舱 KPI 条 */}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <WbStat label="驻部智能体" value={current.agentCount} sub="在役编制" tone="cyan" />
                <WbStat label="近 7 日产出" value={ov?.artifacts7d ?? '—'} sub="台账产出物" tone="green" />
                <WbStat
                  label="引擎"
                  value={current.dshEnabled ? 'DSH 深度' : '快速通道'}
                  sub={current.dshEnabled ? '多步推理+工具面' : 'bridge 直答'}
                  tone={current.dshEnabled ? 'amber' : 'cyan'}
                />
                <WbStat label="模型槽位" value={current.modelSlot} sub="海禛云统一网关" tone="cyan" />
              </div>

              {/* M79 部门适配模型集合（彭总 2026-08-24 指派令，海禛云 41 模型目录内） */}
              {Array.isArray(current.allowedModels) && current.allowedModels.length > 0 && (
                <WbPanel>
                  <div className="mb-3 flex items-center gap-2 text-sm font-medium text-ink-primary">
                    🧠 部门适配模型（{current.allowedModels.length} 个 · 首选 {current.allowedModels[0]}）
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {current.allowedModels.map((m) => (
                      <span key={m} className="rounded-full border border-line-subtle bg-black/20 px-3 py-1 text-xs text-ink-secondary">
                        {m}
                      </span>
                    ))}
                  </div>
                  <div className="mt-2 text-xs text-ink-faint">部门任务默认走首选模型，失败自动沿网关降级链兜底</div>
                </WbPanel>
              )}

              {/* Panda 四席位（平台军团） */}
              <WbPanel>
                <div className="mb-3 flex items-center gap-2 text-sm font-medium text-ink-primary">
                  🐼 Panda 四模型席位（平台军团派驻）
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  {(ov?.pandaSeats ?? []).map((p) => (
                    <div key={p.role} className="flex items-center gap-3 rounded-[10px] border border-line-subtle bg-black/20 px-3 py-2">
                      <span className={cn('h-2 w-2 rounded-full', p.enabled ? 'bg-jade-green' : 'bg-ink-faint')} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-ink-primary">
                          {PANDA_ROLE_LABEL[p.role] ?? p.role} · <span className="font-mono text-xs text-ink-secondary">{p.refKey}</span>
                        </p>
                        <p className="truncate text-[11px] text-ink-faint">{p.duty}</p>
                      </div>
                      <span className={cn('text-[10px]', p.enabled ? 'text-jade-green' : 'text-ink-faint')}>
                        {p.enabled ? '在岗' : '停训'}
                      </span>
                    </div>
                  ))}
                  {(ov?.pandaSeats ?? []).length === 0 && (
                    <p className="text-xs text-ink-faint">平台军团席位读取中或未组建</p>
                  )}
                </div>
              </WbPanel>

              <WbPanel>
                <div className="mb-3 flex items-center gap-2 text-sm font-medium text-ink-primary">
                  <Settings2 className="h-4 w-4" /> {current.deptName} · 配置区
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div>
                    <div className="mb-1 text-xs text-ink-secondary">任命主官（在役智能体）</div>
                    <div className="flex gap-2">
                      <select className={wbInputCls} value={chiefPick} onChange={(e) => setChiefPick(e.target.value)}>
                        <option value="">选择智能体…</option>
                        {agents.map((a) => (
                          <option key={a.code} value={a.code}>
                            {a.name}（{a.title}）
                          </option>
                        ))}
                      </select>
                      <WbButton onClick={submitChief} disabled={pending || !chiefPick}>任命</WbButton>
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 text-xs text-ink-secondary">添加驻部智能体</div>
                    <div className="flex gap-2">
                      <select className={wbInputCls} value={agentPick} onChange={(e) => setAgentPick(e.target.value)}>
                        <option value="">选择智能体…</option>
                        {agents
                          .filter((a) => !current.agentCodes.includes(a.code))
                          .map((a) => (
                            <option key={a.code} value={a.code}>
                              {a.name}（{a.title}）
                            </option>
                          ))}
                      </select>
                      <WbButton onClick={addAgent} disabled={pending || !agentPick}>加入</WbButton>
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {current.agentCodes.length === 0 && (
                    <span className="text-xs text-ink-secondary">驻部组为空——请先添加智能体</span>
                  )}
                  {current.agentCodes.map((c) => {
                    const a = agents.find((x) => x.code === c)
                    return (
                      <span
                        key={c}
                        className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-ink-primary"
                      >
                        <Bot className="h-3 w-3" />
                        {a ? a.name : c}
                        <button className="ml-1 text-ink-secondary hover:text-red-300" onClick={() => removeAgent(c)}>
                          ×
                        </button>
                      </span>
                    )
                  })}
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-white/[0.06] pt-3 text-sm">
                  <label className="flex cursor-pointer items-center gap-2 text-ink-secondary">
                    <input type="checkbox" checked={current.dshEnabled} onChange={toggleDsh} disabled={pending} />
                    DeepSeek Harness 深度引擎（多步推理 + 工具面）
                  </label>
                  <select
                    className={cn(wbInputCls, 'w-auto')}
                    value={current.modelSlot}
                    onChange={(e) => changeSlot(e.target.value)}
                    disabled={pending}
                  >
                    {Object.entries(SLOT_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>

                {/* 技能挂载：技能库真实技能文件 → 本部门全体驻部智能体（含主官） */}
                <div className="mt-3 border-t border-white/[0.06] pt-3">
                  <div className="mb-1 text-xs text-ink-secondary">
                    技能挂载（技能库真实技能，挂上即对本部门全体驻部智能体生效）
                  </div>
                  <div className="flex gap-2">
                    <select className={wbInputCls} value={skillPick} onChange={(e) => setSkillPick(e.target.value)}>
                      <option value="">从技能库选择…</option>
                      {(library ?? [])
                        .filter((sk) => !(equipped ?? []).some((e) => e.skillKey === sk.key))
                        .map((sk) => (
                          <option key={sk.key} value={sk.key}>
                            {sk.name}（{sk.layer}层）
                          </option>
                        ))}
                    </select>
                    <WbButton
                      variant="secondary"
                      disabled={pending || !skillPick}
                      onClick={() => {
                        run(
                          wbMutation('deptConsole.equipSkill', {
                            token: session!.token,
                            deptCode: selected,
                            skillKey: skillPick,
                          }),
                          '技能已挂载到本部门全体驻部智能体',
                        )
                        setSkillPick('')
                        setTimeout(() => refetchEquipped(), 400)
                      }}
                    >
                      挂载
                    </WbButton>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(equipped ?? []).map((e) => (
                      <span
                        key={e.skillKey}
                        className="flex items-center gap-1 rounded-full border border-jade-green/30 bg-jade-green/[0.08] px-2.5 py-1 text-xs text-jade-green"
                      >
                        {e.name}
                        <button
                          className="ml-1 text-ink-secondary hover:text-red-300"
                          onClick={() => {
                            run(
                              wbMutation('deptConsole.unequipSkill', {
                                token: session!.token,
                                deptCode: selected,
                                skillKey: e.skillKey,
                              }),
                              '已摘除',
                            )
                            setTimeout(() => refetchEquipped(), 400)
                          }}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    {(equipped ?? []).length === 0 && (
                      <span className="text-xs text-ink-faint">尚未挂载技能——从技能库选择即挂即用</span>
                    )}
                  </div>
                </div>

                {/* APP 员工通道归属：哪些 staff.deptKey 进本部门工作台 */}
                <div className="mt-3 flex items-end gap-2">
                  <div className="flex-1">
                    <div className="mb-1 text-xs text-ink-secondary">
                      APP 员工归属（staff.deptKey 白名单，逗号分隔；NumX Max APP 员工按此进入本部门）
                    </div>
                    <input
                      className={wbInputCls}
                      defaultValue={(current.staffDeptKeys ?? []).join(',')}
                      placeholder={`如：${current.deptCode},${current.deptCode}-01`}
                      onChange={(e) => setStaffKeysDraft(e.target.value)}
                    />
                  </div>
                  <WbButton
                    variant="secondary"
                    disabled={pending}
                    onClick={() => {
                      const keys = staffKeysDraft.split(',').map((s) => s.trim()).filter(Boolean)
                      run(
                        wbMutation('deptConsole.setStaffKeys', {
                          token: session!.token,
                          deptCode: selected,
                          staffDeptKeys: keys,
                        }),
                        'APP 员工归属已更新',
                      )
                    }}
                  >
                    保存归属
                  </WbButton>
                </div>
              </WbPanel>

              <WbPanel>
                <div className="mb-3 flex items-center gap-2 text-sm font-medium text-ink-primary">
                  <Sparkles className="h-4 w-4 text-forge-amber" /> DSH 内嵌对话 ·{' '}
                  {current.chiefAgent ? `${current.chiefAgent.name} 值守` : '待配置主官'}
                </div>
                <div className="mb-3 max-h-[380px] space-y-2 overflow-y-auto rounded-[10px] bg-black/20 p-3">
                  {(chatLog[selected] ?? []).length === 0 && (
                    <div className="py-6 text-center text-xs text-ink-secondary">
                      直接向{current.deptName}交办任务——默认走 DSH 底座深度执行，模型统一海禛云网关
                    </div>
                  )}
                  {(chatLog[selected] ?? []).map((m, i) => (
                    <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                      <div
                        className={cn(
                          'max-w-[80%] rounded-[12px] px-3 py-2 text-sm leading-relaxed',
                          m.role === 'user'
                            ? 'bg-pulse-cyan/15 text-ink-primary'
                            : 'border border-white/[0.08] bg-white/[0.04] text-ink-primary',
                        )}
                      >
                        {m.role === 'agent' && (
                          <div className="mb-1 text-[11px] text-ink-secondary">
                            {m.agentName ?? '部门智能体'} · {m.runtime === 'dsh' ? 'DSH 深度引擎' : '快速通道'}
                          </div>
                        )}
                        <div className="whitespace-pre-wrap">{m.content}</div>
                      </div>
                    </div>
                  ))}
                  {sending && <div className="text-xs text-ink-secondary">主官思考中…</div>}
                </div>
                <div className="flex gap-2">
                  <input
                    className={wbInputCls}
                    placeholder={`交办给${current.deptName}…`}
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && sendChat()}
                    disabled={sending}
                  />
                  <WbButton onClick={sendChat} disabled={sending || !chatInput.trim()}>
                    <Send className="h-4 w-4" />
                  </WbButton>
                </div>
              </WbPanel>

              {/* 跨部门协作通道：本部门主官 → 他部门主官 */}
              <WbPanel>
                <div className="mb-3 flex items-center gap-2 text-sm font-medium text-ink-primary">
                  <Send className="h-4 w-4 text-pulse-cyan" /> 跨部门协作（{current.deptName} 发起）
                </div>
                <div className="flex flex-col gap-2 md:flex-row">
                  <input ref={collabFileRef} type="file" className="hidden" onChange={onCollabFile} />
                  <select
                    className={cn(wbInputCls, 'md:w-40')}
                    value={collabTarget}
                    onChange={(e) => setCollabTarget(e.target.value)}
                  >
                    <option value="">协作对象…</option>
                    {(data ?? [])
                      .filter((d) => d.deptCode !== selected)
                      .map((d) => (
                        <option key={d.deptCode} value={d.deptCode}>{d.deptName}</option>
                      ))}
                  </select>
                  <WbButton
                    variant="secondary"
                    className="shrink-0"
                    disabled={collabSending || !collabTarget}
                    onClick={() => collabFileRef.current?.click()}
                  >
                    <Paperclip className="h-4 w-4" />
                  </WbButton>
                  <input
                    className={wbInputCls}
                    placeholder="协作事项（对方主官按本部门职责办理并回执）…"
                    value={collabMsg}
                    onChange={(e) => setCollabMsg(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && sendCollab()}
                    disabled={collabSending}
                  />
                  <WbButton onClick={sendCollab} disabled={collabSending || !collabTarget || !collabMsg.trim()} className="shrink-0">
                    {collabSending ? '协作中…' : '发起协作'}
                  </WbButton>
                </div>

                <div className="mt-3 space-y-2">
                  {(feed ?? []).slice(0, 8).map((f) => (
                    <div key={f.id} className="rounded-[10px] border border-white/[0.06] bg-black/20 p-3">
                      <div className="mb-1 text-[11px] text-ink-secondary">
                        {f.fromDeptName}·{f.fromAgent} → {f.toDeptName}·{f.toAgent} · {f.runtime === 'dsh' ? 'DSH 深度轨' : '快速通道'} · {f.createdAt}
                      </div>
                      <p className="text-sm text-ink-primary">【发起】{f.message}</p>
                      {f.reply && (
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink-secondary">【回执】{f.reply}</p>
                      )}
                    </div>
                  ))}
                  {(feed ?? []).length === 0 && (
                    <p className="py-3 text-center text-xs text-ink-faint">尚无协作记录——第一单跨部门协作从这里发起</p>
                  )}
                </div>
              </WbPanel>

              {/* 临时会议（插件能力：部门内/跨部门/全公司） */}
              <WbPanel>
                <div className="mb-3 text-sm font-medium text-ink-primary">🎙️ 临时会议（会议厅插件）</div>
                <div className="flex flex-col gap-2 md:flex-row">
                  <select
                    className={cn(wbInputCls, 'md:w-44')}
                    value={mtScope}
                    onChange={(e) => setMtScope(e.target.value as typeof mtScope)}
                  >
                    <option value="dept">本部门内部会</option>
                    <option value="cross">跨部门会</option>
                    <option value="all">全公司大会</option>
                  </select>
                  <input
                    className={wbInputCls}
                    placeholder="议题（如：Q3 产能爬坡协同）…"
                    value={mtTopic}
                    onChange={(e) => setMtTopic(e.target.value)}
                    disabled={mtBusy}
                  />
                  <WbButton onClick={startMeeting} disabled={mtBusy || !mtTopic.trim()} className="shrink-0">
                    {mtBusy ? '召集…' : '召集会议'}
                  </WbButton>
                </div>
                {mtScope === 'cross' && (
                  <div className="mt-2 flex gap-3 text-xs text-ink-secondary">
                    {(['ops', 'brand', 'marketing', 'tech', 'finance', 'legal'] as DeptCode[])
                      .filter((d) => d !== selected)
                      .map((d) => (
                        <label key={d} className="flex cursor-pointer items-center gap-1">
                          <input
                            type="checkbox"
                            checked={mtCross.includes(d)}
                            onChange={() =>
                              setMtCross((xs) => (xs.includes(d) ? xs.filter((x) => x !== d) : [...xs, d]))
                            }
                          />
                          {DEPT_SHORT[d]}
                        </label>
                      ))}
                    <span className="text-ink-faint">（本部门自动在席）</span>
                  </div>
                )}
                {mtMsg && <p className="mt-2 text-xs text-emerald-300">{mtMsg}</p>}

                <div className="mt-3 space-y-2">
                  {(meetings ?? []).slice(0, 6).map((m) => (
                    <div key={m.id} className="flex items-center gap-3 rounded-[10px] border border-white/[0.06] bg-black/20 px-3 py-2">
                      <a href={`/admin/meeting/${m.id}`} className="min-w-0 flex-1 truncate text-sm text-pulse-cyan hover:underline">
                        #{m.id} {m.topic}（点进会场）
                      </a>
                      <span className="font-mono text-[10px] text-ink-faint">
                        {m.roomType === 'dept' ? '部门内' : m.roomType === 'cross' ? '跨部门' : '全公司'} · {m.status}
                      </span>
                      {m.status !== 'closed' && (
                        <>
                          <button
                            className="rounded-full border border-pulse-cyan/40 px-2.5 py-0.5 text-[11px] text-pulse-cyan hover:bg-pulse-cyan/10"
                            disabled={mtBusy}
                            onClick={() => meetingAction(m.id, 'round')}
                          >
                            推进一轮
                          </button>
                          <button
                            className="rounded-full border border-forge-amber/40 px-2.5 py-0.5 text-[11px] text-forge-amber hover:bg-forge-amber/10"
                            disabled={mtBusy}
                            onClick={() => meetingAction(m.id, 'summarize')}
                          >
                            纪要收口
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                  {(meetings ?? []).length === 0 && (
                    <p className="py-3 text-center text-xs text-ink-faint">暂无会议——临时会议厅随时可召集</p>
                  )}
                </div>
              </WbPanel>
            </>
          ) : (
            <WbEmpty text="部门数据加载中或尚未初始化" />
          )}
        </div>
      </div>
    </div>
  )
}
