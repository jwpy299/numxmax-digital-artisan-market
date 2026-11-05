/**
 * DshRuntimePanel —— 总经理驾驶舱内嵌「DeepSeek Harness 运行时全景」。
 * ① 统一模型网关（海禛云优先）接入状态；② 三部门 DSH 引擎开关与主官值守；
 * ③ DSH 直达：从驾驶舱把任务直接交办进任一部门的 DSH 深度轨。
 * 数据：modelGateway.status（公开只读）+ deptConsole.listConsoles/chat（管理员）。
 */
import { useState } from 'react'
import { Send, Sparkles } from 'lucide-react'
import { useWbSession, useWbQuery, wbMutation, wbQuery, wbErrorMessage } from '@/lib/wbSession'
import { WbButton, wbInputCls } from '@/components/wb/ui'
import { cn } from '@/lib/utils'
import { useEffect } from 'react'

interface GatewayStatus {
  configuredCount?: number
  verifiedCount?: number
  totalCount?: number
  ido?: { label: string; configured: boolean }
}

interface ConsoleItem {
  deptCode: 'ops' | 'brand' | 'marketing'
  deptName: string
  chiefAgent: { code: string; name: string; title: string } | null
  agentCount: number
  dshEnabled: boolean
  modelSlot: string
}

type DeptKey = 'ops' | 'brand' | 'marketing' | 'tech' | 'finance' | 'legal'

interface Officer {
  code: string
  name: string
  title: string
  deptCode: string
}

export default function DshRuntimePanel() {
  const { session } = useWbSession()
  const [gw, setGw] = useState<GatewayStatus | null>(null)
  const [dept, setDept] = useState<DeptKey>('ops')
  const [msg, setMsg] = useState('')
  const [reply, setReply] = useState<{ text: string; runtime: string; agent: string } | null>(null)
  const [sending, setSending] = useState(false)
  const [sendErr, setSendErr] = useState<string | null>(null)

  const { data: consoles } = useWbQuery<ConsoleItem[]>('deptConsole.listConsoles', session, {})
  const { data: officers } = useWbQuery<Officer[]>('deptConsole.officers', session, {})
  const [officerPick, setOfficerPick] = useState('')
  // M52：驾驶舱协作/会议直达
  const [coFrom, setCoFrom] = useState<DeptKey>('ops')
  const [coTo, setCoTo] = useState<DeptKey>('marketing')
  const [coMsg, setCoMsg] = useState('')
  const [coBusy, setCoBusy] = useState(false)
  const [coNote, setCoNote] = useState<string | null>(null)
  const [mtTopic2, setMtTopic2] = useState('')
  const [mtBusy2, setMtBusy2] = useState(false)

  useEffect(() => {
    wbQuery<GatewayStatus>('modelGateway.status')
      .then(setGw)
      .catch(() => setGw(null))
  }, [])

  function fire() {
    const text = msg.trim()
    if (!text || sending) return
    setSending(true)
    setSendErr(null)
    setReply(null)
    const call = officerPick
      ? wbMutation<{ reply: string; runtime: string; agent: { name: string } }>('deptConsole.chatAgent', {
          token: session!.token,
          agentCode: officerPick,
          message: text,
          runtime: 'dsh',
        })
      : wbMutation<{ reply: string; runtime: string; agent: { name: string } }>('deptConsole.chat', {
          token: session!.token,
          deptCode: dept,
          message: text,
        })
    call
      .then((r) => setReply({ text: r.reply, runtime: r.runtime, agent: r.agent?.name ?? '' }))
      .catch((e) => setSendErr(wbErrorMessage(e)))
      .finally(() => setSending(false))
  }

  return (
    <div className="space-y-4">
      {/* 模型网关（海禛云统一接入） */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line-subtle bg-void/40 p-4">
        <Sparkles className="h-4 w-4 text-forge-amber" />
        <span className="text-sm font-medium text-ink-primary">统一模型网关</span>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 font-mono text-[10px]',
            gw?.ido?.configured
              ? 'border border-jade-green/40 bg-jade-green/[0.08] text-jade-green'
              : 'border border-red-400/40 bg-red-400/[0.08] text-red-300',
          )}
        >
          海禛云 {gw ? (gw.ido?.configured ? '已接入' : '未配置') : '读取中…'}
        </span>
        {gw && (
          <span className="text-xs text-ink-secondary">
            全网关模型：已配置 {gw.configuredCount ?? '-'} / 已验证 {gw.verifiedCount ?? '-'} / 共 {gw.totalCount ?? '-'}
          </span>
        )}
      </div>

      {/* 三部门 DSH 引擎状态 */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {(consoles ?? []).map((d) => (
          <div key={d.deptCode} className="rounded-xl border border-line-subtle bg-void/40 p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-ink-primary">{d.deptName}</p>
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 font-mono text-[10px]',
                  d.dshEnabled
                    ? 'border border-forge-amber/40 bg-forge-amber/[0.08] text-forge-amber'
                    : 'border border-line-subtle bg-white/[0.04] text-ink-faint',
                )}
              >
                {d.dshEnabled ? 'DSH 深度引擎' : '快速通道'}
              </span>
            </div>
            <p className="mt-2 text-xs text-ink-secondary">
              主官：{d.chiefAgent ? `${d.chiefAgent.name}（${d.chiefAgent.title}）` : '未任命'} · 驻部 {d.agentCount} 人 · 槽位 {d.modelSlot}
            </p>
          </div>
        ))}
      </div>

      {/* 六主官阵列（部门智能管理同步接入驾驶舱，点击即点将） */}
      <div className="rounded-xl border border-line-subtle bg-void/40 p-4">
        <p className="mb-2 text-sm font-medium text-ink-primary">部门主官阵列（点将直达）</p>
        <div className="flex flex-wrap gap-2">
          {(officers ?? []).map((o) => (
            <button
              key={o.code}
              onClick={() => setOfficerPick(officerPick === o.code ? '' : o.code)}
              className={cn(
                'rounded-full border px-3 py-1.5 text-xs transition-colors',
                officerPick === o.code
                  ? 'border-forge-amber/60 bg-forge-amber/15 text-forge-amber'
                  : 'border-line-subtle bg-white/[0.03] text-ink-secondary hover:text-ink-primary',
              )}
            >
              {o.name}（{o.title}）
            </button>
          ))}
          {(officers ?? []).length === 0 && <span className="text-xs text-ink-faint">花名册读取中…</span>}
        </div>
      </div>

      {/* DSH 直达交办 */}
      <div className="rounded-xl border border-line-subtle bg-void/40 p-4">
        <p className="mb-2 text-sm font-medium text-ink-primary">
          DSH 直达交办{officerPick ? `（点将：${officers?.find((o) => o.code === officerPick)?.name ?? officerPick}）` : ''}
        </p>
        <div className="flex flex-col gap-2 md:flex-row">
          <select
            className={cn(wbInputCls, 'md:w-36')}
            value={officerPick ? '' : dept}
            disabled={!!officerPick}
            onChange={(e) => setDept(e.target.value as typeof dept)}
          >
            <option value="ops">运营部</option>
            <option value="brand">品牌部</option>
            <option value="marketing">市场部</option>
          </select>
          <input
            className={wbInputCls}
            placeholder="把任务直接交办进该部门的 DSH 深度轨…"
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && fire()}
            disabled={sending}
          />
          <WbButton onClick={fire} disabled={sending || !msg.trim()} className="shrink-0">
            <Send className="h-4 w-4" />
          </WbButton>
        </div>
        {sending && <p className="mt-2 text-xs text-ink-secondary">DSH 深度引擎执行中（多步推理+工具面，可能比快答慢）…</p>}
        {sendErr && <p className="mt-2 text-xs text-red-300">{sendErr}</p>}
        {reply && (
          <div className="mt-3 rounded-[10px] border border-white/[0.08] bg-black/20 p-3">
            <p className="mb-1 text-[11px] text-ink-secondary">
              {reply.agent} · {reply.runtime === 'dsh' ? 'DSH 深度引擎' : '快速通道'}
            </p>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-primary">{reply.text}</p>
          </div>
        )}
      </div>

      {/* 跨部门协作 + 临时会议（驾驶舱直达） */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-line-subtle bg-void/40 p-4">
          <p className="mb-2 text-sm font-medium text-ink-primary">跨部门协作</p>
          <div className="flex flex-wrap items-center gap-2">
            <select className={cn(wbInputCls, 'w-28')} value={coFrom} onChange={(e) => setCoFrom(e.target.value as typeof coFrom)}>
              <option value="ops">运营部</option>
              <option value="brand">品牌部</option>
              <option value="marketing">市场部</option>
              <option value="tech">技术部</option>
              <option value="finance">财务部</option>
              <option value="legal">法务部</option>
            </select>
            <span className="text-ink-faint">→</span>
            <select className={cn(wbInputCls, 'w-28')} value={coTo} onChange={(e) => setCoTo(e.target.value as typeof coTo)}>
              <option value="ops">运营部</option>
              <option value="brand">品牌部</option>
              <option value="marketing">市场部</option>
              <option value="tech">技术部</option>
              <option value="finance">财务部</option>
              <option value="legal">法务部</option>
            </select>
          </div>
          <div className="mt-2 flex gap-2">
            <input
              className={wbInputCls}
              placeholder="协作事项…"
              value={coMsg}
              onChange={(e) => setCoMsg(e.target.value)}
              disabled={coBusy}
            />
            <WbButton
              className="shrink-0"
              disabled={coBusy || !coMsg.trim() || coFrom === coTo}
              onClick={() => {
                setCoBusy(true)
                setCoNote(null)
                wbMutation<{ to: { agent: string } }>('deptConsole.delegate', {
                  token: session!.token,
                  fromDept: coFrom,
                  toDept: coTo,
                  message: coMsg.trim(),
                })
                  .then((r) => {
                    setCoNote(`已送达，${r.to.agent} 回执（台账见部门工作台）`)
                    setCoMsg('')
                  })
                  .catch((e) => setCoNote(wbErrorMessage(e)))
                  .finally(() => setCoBusy(false))
              }}
            >
              {coBusy ? '送达中…' : '发起协作'}
            </WbButton>
          </div>
          {coNote && <p className="mt-2 text-xs text-emerald-300">{coNote}</p>}
        </div>

        <div className="rounded-xl border border-line-subtle bg-void/40 p-4">
          <p className="mb-2 text-sm font-medium text-ink-primary">临时会议厅</p>
          <div className="flex gap-2">
            <input
              className={wbInputCls}
              placeholder="议题（召集全公司大会）…"
              value={mtTopic2}
              onChange={(e) => setMtTopic2(e.target.value)}
              disabled={mtBusy2}
            />
            <WbButton
              className="shrink-0"
              disabled={mtBusy2 || !mtTopic2.trim()}
              onClick={() => {
                setMtBusy2(true)
                setCoNote(null)
                wbMutation<{ meetingId: number }>('deptConsole.meetingStart', {
                  token: session!.token,
                  topic: mtTopic2.trim(),
                  scope: 'all',
                  opening: `总经理驾驶舱召集全员会：${mtTopic2.trim()}`,
                })
                  .then((r) => {
                    setCoNote(`全员会 #${r.meetingId} 已召集（部门工作台可推进圆桌/收口纪要）`)
                    setMtTopic2('')
                  })
                  .catch((e) => setCoNote(wbErrorMessage(e)))
                  .finally(() => setMtBusy2(false))
              }}
            >
              {mtBusy2 ? '召集…' : '召集全员会'}
            </WbButton>
          </div>
        </div>
      </div>
    </div>
  )
}
