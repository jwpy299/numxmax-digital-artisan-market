import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Bot, CheckCircle2, CircleX, GitBranch, Play, RefreshCw, ShieldCheck, Users, WalletCards } from 'lucide-react'
import { callWb, useWbQuery, useWbSession, wbErrorMessage } from '@/lib/wbSession'
import { WbError, WbLoading, WbNotice } from '@/components/wb/ui'

type RuntimeRow = { id: string; name: string; ready: boolean; detail: string; capabilities: string[]; identity: { registrationId: number; registrationStatus: string } | null }
type Role = { id: number; role: string; title: string; brief: string; rewardJobTokens: number; runtimePreference: string; status: string; assignedRuntime: string | null; jobId: number | null; employmentId: number | null; claimId: number | null; result: string | null; resultSha256: string | null; wageSettled: boolean; executed: boolean; done: boolean }
type Candidate = { id: number; roleId: number; runtime: string; registrationId: number; applicationId: number | null; status: string; errorCode: string | null }
type Outbox = { id: number; roleId: number; eventType: string; status: string; attemptCount: number; maxAttempts: number; lastError: string | null }
type Plan = {
  plan: { id: number; planNo: string; departmentId: string; creatorUserId: number; naturalLanguage: string; status: string; planner: { provider: string; model: string; requestSha256: string; responseSha256: string } | null; plannerError: string | null }
  roles: Role[]
  candidates: Candidate[]
  outbox: Outbox[]
  events: Array<{ id: number; eventType: string; actorUserId: number | null; createdAt: string }>
  contract: { eventDriven: boolean; executedNotDone: boolean; awaitingReviewNotDelivered: boolean; wageSettlement: string }
  already?: boolean
}
type Registration = { id: number; agentName: string; status: string }
const runtimeIds = ['dsh', 'kimi', 'glm', 'workbuddy', 'qwen']
const statusText: Record<string, string> = {
  planning: '规划中', planned: '待竞岗', awaiting_selection: '竞岗中', ready_to_dispatch: '待派发', running: '事件执行中',
  awaiting_review: '待独立验收', attention_required: '需处理', completed: '已验收完成', failed: '规划失败', cancelled: '已撤销',
  selected: '已录用', claimed: '已领取', executing: '执行中', accepted: '已验收', rejected: '已驳回', blocked: '已阻断', applied: '待录用', ineligible: '资格不符',
}
const label = (status: string) => statusText[status] ?? status

export default function AgentRuntimeContainer() {
  const { session } = useWbSession()
  const token = session?.token ?? ''
  const identity = useWbQuery<{ departmentId: string | null; orgRole: string }>('agentWork.identity', session, {}, { enabled: !!token })
  const canManage = ['admin', 'manager'].includes(identity.data?.orgRole ?? '')
  const factory = useWbQuery<{ departments: Array<{ id: string; name: string }> }>('agentWork.factory', session, {}, { enabled: !!token && canManage })
  const mine = useWbQuery<{ qualifiedRegistrations: Registration[] }>('agentTraining.mine', session, {}, { enabled: !!token && canManage })
  const [departmentId, setDepartmentId] = useState('')
  const departments = factory.data?.departments ?? []
  useEffect(() => {
    if (departmentId && departments.some((item) => item.id === departmentId)) return
    const preferred = identity.data?.departmentId && departments.some((item) => item.id === identity.data?.departmentId) ? identity.data?.departmentId : departments[0]?.id
    if (preferred) setDepartmentId(preferred)
  }, [departmentId, departments, identity.data?.departmentId])
  const runtimes = useWbQuery<{ runtimes: RuntimeRow[] }>('agentRuntime.runtimes', session, { departmentId }, { enabled: !!token && canManage && !!departmentId })
  const plans = useWbQuery<Plan[]>('agentRuntime.list', session, {}, { enabled: !!token && canManage })
  const [selected, setSelected] = useState<Plan | null>(null)
  const [instruction, setInstruction] = useState('')
  const [reward, setReward] = useState(1)
  const [bindRuntime, setBindRuntime] = useState('dsh')
  const [registrationId, setRegistrationId] = useState(0)
  const [reviewNote, setReviewNote] = useState('独立复核：交付物、证据与岗位要求一致。')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const actionKeys = useRef<Record<string, string>>({})
  const qualified = mine.data?.qualifiedRegistrations ?? []
  const active = selected?.plan.status === 'running'
  useEffect(() => {
    if (!active || !selected) return
    let cancelled = false
    const timer = window.setInterval(() => {
      callWb<Plan>('query', 'agentRuntime.plan', session, { planId: selected.plan.id }).then((plan) => { if (!cancelled) setSelected(plan) }).catch(() => undefined)
    }, 2000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [active, selected, session])
  async function action(key: string, path: string, input: Record<string, unknown>, success: string) {
    if (!session || busy) return
    setBusy(key); setError(null); setNotice(null)
    try {
      const plan = await callWb<Plan>('mutation', path, session, input)
      setSelected(plan); setNotice(success); plans.refetch(); runtimes.refetch()
    } catch (cause) { setError(wbErrorMessage(cause)) } finally { setBusy(null) }
  }
  async function create() {
    if (!session || instruction.trim().length < 4 || reward < 1 || !departmentId) return
    const key = actionKeys.current.create ??= crypto.randomUUID()
    await action('create', 'agentRuntime.createPlan', { departmentId, idempotencyKey: key, rewardJobTokens: reward, instruction: instruction.trim() }, '真实规划已落库；请核对岗位后发起竞岗。')
  }
  async function bind() {
    if (!session || !registrationId || !departmentId || busy) return
    setBusy('bind'); setError(null); setNotice(null)
    try {
      await callWb('mutation', 'agentRuntime.bindIdentity', session, { departmentId, runtime: bindRuntime, registrationId })
      setNotice('runtime 与本人 Agent 身份已绑定；竞岗时仍会重新核验就业资格。'); runtimes.refetch()
    } catch (cause) { setError(wbErrorMessage(cause)) } finally { setBusy(null) }
  }
  if (!token) return <section className="mx-auto max-w-3xl p-6"><WbNotice message="请先登录企业负责人或部门负责人账号，再进入多 Agent 编排。" /><Link className="mt-4 inline-flex min-h-11 items-center text-pulse-cyan" to="/agent-employment">前往登录与 Agent 就业中心</Link></section>
  if (identity.loading || (canManage && factory.loading && !factory.data)) return <WbLoading text="读取组织与编排权限" />
  if (!canManage) return <WbError message="仅企业负责人或部门负责人可使用多 Agent 编排；普通成员不能控制 runtime。" />

  return <main className="mx-auto max-w-[1440px] space-y-6 p-4 pb-16 md:p-6">
    <header className="flex flex-col gap-4 border-b border-line-subtle pb-5 md:flex-row md:items-end md:justify-between">
      <div><p className="text-sm text-ink-faint">NumX Max · 组织智能运行时</p><h1 className="mt-1 text-2xl font-bold md:text-3xl">多 Agent 自然语言编排</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-ink-faint">一句话拆岗位，多个 runtime 竞岗并行执行。事件驱动、canonical MySQL 回读；执行不等于交付，独立验收通过才由原工资链结算。</p></div>
      <Link to="/agent-employment" className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-subtle px-4 text-sm text-pulse-cyan"><Users className="h-4 w-4" />Agent 就业与身份</Link>
    </header>
    {error && <WbError message={error} />}
    {notice && <WbNotice message={notice} />}
    <section className="grid gap-4 lg:grid-cols-[1.1fr_1.9fr]">
      <div className="rounded-xl border border-line-subtle p-4">
        <h2 className="flex items-center gap-2 font-semibold"><GitBranch className="h-4 w-4" />自然语言计划</h2>
        <label className="mt-4 block text-sm">工作部门<select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-line-subtle bg-transparent px-3">{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
        <label className="mt-4 block text-sm">告诉组织要做什么<textarea value={instruction} onChange={(event) => { setInstruction(event.target.value); delete actionKeys.current.create }} placeholder="例如：让巡检、报告、复核三个岗位并行完成本周产线检查；各自提交证据，最后由另一负责人验收。" rows={5} className="mt-1 w-full rounded-lg border border-line-subtle bg-transparent p-3 text-sm leading-6" /></label>
        <label className="mt-3 block text-sm">每个岗位验收工资（job_token）<input type="number" min={1} value={reward} onChange={(event) => setReward(Number(event.target.value))} className="mt-1 min-h-11 w-full rounded-lg border border-line-subtle bg-transparent px-3" /></label>
        <p className="mt-2 text-xs leading-5 text-ink-faint">规划模型不决定工资。创建后先核对岗位，再发起竞岗；不会一句话直接扣款或执行。</p>
        <button type="button" disabled={!!busy || instruction.trim().length < 4 || reward < 1 || !departmentId} onClick={() => void create()} className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-pulse-cyan px-4 font-semibold text-void disabled:opacity-40"><Play className="h-4 w-4" />{busy === 'create' ? 'SCNet 真实规划中…' : '生成岗位计划'}</button>
      </div>
      <div className="rounded-xl border border-line-subtle p-4">
        <h2 className="flex items-center gap-2 font-semibold"><Bot className="h-4 w-4" />runtime 大容器与竞岗身份</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">{(runtimes.data?.runtimes ?? []).map((runtime) => <article key={runtime.id} className="rounded-lg border border-line-subtle p-3"><div className="flex items-center justify-between gap-2"><strong>{runtime.name}</strong><span className={runtime.ready ? 'text-jade-green' : 'text-forge-amber'}>{runtime.ready ? '适配器已接通' : '未接通'}</span></div><p className="mt-2 text-xs leading-5 text-ink-faint">{runtime.detail}</p><p className="mt-2 text-xs">竞岗身份：{runtime.identity ? `#${runtime.identity.registrationId} · ${runtime.identity.registrationStatus}` : '未绑定'}</p></article>)}</div>
        <div className="mt-4 grid gap-2 md:grid-cols-[1fr_1.4fr_auto]"><select aria-label="绑定 runtime" value={bindRuntime} onChange={(event) => setBindRuntime(event.target.value)} className="min-h-11 rounded-lg border border-line-subtle bg-transparent px-3">{runtimeIds.map((id) => <option key={id}>{id}</option>)}</select><select aria-label="绑定本人已达标 Agent" value={registrationId} onChange={(event) => setRegistrationId(Number(event.target.value))} className="min-h-11 rounded-lg border border-line-subtle bg-transparent px-3"><option value={0}>选择本人已达标 Agent</option>{qualified.map((registration) => <option key={registration.id} value={registration.id}>#{registration.id} · {registration.agentName}</option>)}</select><button type="button" disabled={!!busy || !registrationId} onClick={() => void bind()} className="min-h-11 rounded-lg border border-pulse-cyan px-4 text-pulse-cyan disabled:opacity-40">绑定竞岗身份</button></div>
      </div>
    </section>
    <section className="grid gap-4 xl:grid-cols-[280px_1fr]">
      <aside className="rounded-xl border border-line-subtle p-3"><div className="flex items-center justify-between"><h2 className="font-semibold">编排计划</h2><button aria-label="刷新计划" type="button" onClick={() => plans.refetch()} className="inline-flex min-h-11 min-w-11 items-center justify-center"><RefreshCw className="h-4 w-4" /></button></div><div className="mt-2 space-y-2">{(plans.data ?? []).map((plan) => <button type="button" key={plan.plan.id} onClick={() => setSelected(plan)} className={`min-h-11 w-full rounded-lg border p-3 text-left text-sm ${selected?.plan.id === plan.plan.id ? 'border-pulse-cyan' : 'border-line-subtle'}`}><span className="block truncate font-medium">{plan.plan.naturalLanguage}</span><span className="mt-1 block text-xs text-ink-faint">{plan.plan.planNo} · {label(plan.plan.status)}</span></button>)}{plans.data?.length === 0 && <p className="p-3 text-sm text-ink-faint">尚无编排计划。</p>}</div></aside>
      <div className="min-w-0">{!selected ? <div className="rounded-xl border border-dashed border-line-subtle p-8 text-center text-sm text-ink-faint">选择左侧计划，或先用自然语言创建。</div> : <div className="space-y-4">
        <section className="rounded-xl border border-line-subtle p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold">{selected.plan.planNo} · {label(selected.plan.status)}</h2><p className="mt-2 max-w-4xl whitespace-pre-wrap text-sm leading-6 text-ink-faint">{selected.plan.naturalLanguage}</p>{selected.plan.planner && <p className="mt-2 break-all font-mono text-xs text-ink-faint">{selected.plan.planner.provider} · {selected.plan.planner.model} · request {selected.plan.planner.requestSha256.slice(0, 16)}… · response {selected.plan.planner.responseSha256.slice(0, 16)}…</p>}</div><div className="flex flex-wrap gap-2">{selected.plan.status === 'planned' && <button type="button" disabled={!!busy} onClick={() => void action('compete', 'agentRuntime.openCompetition', { planId: selected.plan.id }, '岗位与候选应聘已落库，请由另一负责人录用。')} className="min-h-11 rounded-lg bg-pulse-cyan px-4 font-semibold text-void">发起竞岗</button>}{['ready_to_dispatch', 'running'].includes(selected.plan.status) && selected.roles.some((role) => role.status === 'selected') && <button type="button" disabled={!!busy} onClick={() => void action('dispatch', 'agentRuntime.dispatch', { planId: selected.plan.id }, '任务已领取，canonical outbox 正驱动并行执行。')} className="min-h-11 rounded-lg bg-pulse-cyan px-4 font-semibold text-void">领取任务并并行执行</button>}{!['completed', 'cancelled', 'awaiting_review'].includes(selected.plan.status) && <button type="button" disabled={!!busy} onClick={() => void action('cancel', 'agentRuntime.cancel', { planId: selected.plan.id, reason: '企业负责人撤销未交付编排' }, '计划与未交付任务已撤销。')} className="min-h-11 rounded-lg border border-forge-amber px-4 text-forge-amber">撤销未交付计划</button>}</div></div></section>
        {selected.roles.map((role) => <section key={role.id} className="rounded-xl border border-line-subtle p-4"><div className="flex flex-wrap justify-between gap-2"><div><h3 className="font-semibold">{role.role} · {role.title}</h3><p className="mt-1 text-sm text-ink-faint">{role.brief}</p></div><span className="text-sm">{label(role.status)}</span></div><div className="mt-3 grid gap-2 text-xs text-ink-faint md:grid-cols-4"><span>奖励 {role.rewardJobTokens} job_token</span><span>偏好 {role.runtimePreference}</span><span>执行 {role.assignedRuntime ?? '待录用'}</span><span>工资 {role.wageSettled ? '已结算' : '未结算'}</span></div>
          <div className="mt-3 space-y-2">{selected.candidates.filter((candidate) => candidate.roleId === role.id).map((candidate) => <div key={candidate.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line-subtle p-3 text-sm"><span>{candidate.runtime} · Agent #{candidate.registrationId} · {label(candidate.status)}{candidate.errorCode ? ` · ${candidate.errorCode}` : ''}</span>{candidate.status === 'applied' && <button type="button" disabled={!!busy} onClick={() => void action(`select-${candidate.id}`, 'agentRuntime.selectCandidate', { candidateId: candidate.id }, '候选人已由独立负责人录用。')} className="min-h-11 rounded-lg border border-pulse-cyan px-3 text-pulse-cyan">独立录用</button>}</div>)}</div>
          {role.result && <details className="mt-3 rounded-lg border border-line-subtle p-3"><summary className="cursor-pointer text-sm">查看执行交付与证据</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs leading-5 text-ink-faint">{role.result}</pre><p className="mt-2 break-all font-mono text-xs">SHA-256 {role.resultSha256}</p></details>}
          {role.status === 'failed' && <button type="button" disabled={!!busy} onClick={() => void action(`retry-${role.id}`, 'agentRuntime.retry', { roleId: role.id }, '失败岗位已重新进入 canonical outbox，等待真实执行。')} className="mt-3 min-h-11 rounded-lg border border-pulse-cyan px-4 text-pulse-cyan">重试失败岗位</button>}
          {role.status === 'awaiting_review' && <div className="mt-3 rounded-lg border border-forge-amber/50 p-3"><p className="text-sm text-forge-amber">已提交但未验收，当前不会发工资。</p><textarea aria-label={`岗位 ${role.role} 验收意见`} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} rows={2} className="mt-2 w-full rounded-lg border border-line-subtle bg-transparent p-3 text-sm" /><div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={!!busy || reviewNote.trim().length < 4} onClick={() => void action(`accept-${role.id}`, 'agentRuntime.review', { roleId: role.id, verdict: 'accept', note: reviewNote }, '独立验收通过，原工资链已按实际交付结算。')} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-jade-green px-4 text-void"><CheckCircle2 className="h-4 w-4" />验收并按交付发薪</button><button type="button" disabled={!!busy || reviewNote.trim().length < 4} onClick={() => void action(`reject-${role.id}`, 'agentRuntime.review', { roleId: role.id, verdict: 'reject', note: reviewNote }, '交付已驳回，未结算工资。')} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-forge-amber px-4 text-forge-amber"><CircleX className="h-4 w-4" />驳回不发薪</button></div></div>}
        </section>)}
        <section className="grid gap-4 lg:grid-cols-2"><div className="rounded-xl border border-line-subtle p-4"><h3 className="flex items-center gap-2 font-semibold"><WalletCards className="h-4 w-4" />canonical outbox</h3><div className="mt-2 space-y-2 text-xs">{selected.outbox.map((event) => <p key={event.id}>#{event.id} · {event.eventType} · {event.status} · 尝试 {event.attemptCount}/{event.maxAttempts}{event.lastError ? ` · ${event.lastError}` : ''}</p>)}</div></div><div className="rounded-xl border border-line-subtle p-4"><h3 className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4" />事件与审计</h3><div className="mt-2 max-h-64 space-y-2 overflow-auto text-xs">{selected.events.map((event) => <p key={event.id}>#{event.id} · {event.eventType} · actor {event.actorUserId ?? 'worker'} · {String(event.createdAt)}</p>)}</div></div></section>
      </div>}</div>
    </section>
  </main>
}
