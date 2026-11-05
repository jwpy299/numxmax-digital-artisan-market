/**
 * Skills（/admin/skills）—— 技能中心（迭代 30：技能体系 + 自进化引擎）。
 * 5 Tab（迭代 40 新增「数字员工技能库」：匠市 V/U 技能只读总览）：
 *  1. 技能库（skills.list，卡片网格：名称/层/模型槽位/描述/挂载数）
 *  2. 挂载矩阵（skills.agentSkills + skills.setEnabled 启停）
 *  3. 进化提案（evo.proposals 状态筛选 + evo.decide 批准/驳回）
 *  4. 进化周报（evo.generateReport 生成 + evo.reports 历史列表 + 全文展开）
 */
import { useState } from 'react'
import {
  BookOpenCheck,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cpu,
  FileText,
  Layers,
  Link2,
  RefreshCw,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Wrench,
  XCircle,
} from 'lucide-react'
import { callWb, useWbSession, useWbQuery } from '@/lib/wbSession'
import { WbError, WbLoading, WbPageHeader, WbPanel, wbInputCls } from '@/components/wb/ui'
import { cn } from '@/lib/utils'

// ─── 类型 ────────────────────────────────────────────────────────────────────

interface SkillRow {
  id: number
  skillKey: string
  name: string
  layer: 'general' | 'professional' | 'industry'
  category?: string | null
  description?: string | null
  slot?: string | null
  status?: string | null
  mountCount?: number
  mounts?: number
}

interface AgentSkillRow {
  id?: number
  agentId?: number
  skillKey: string
  name?: string | null
  layer?: string | null
  description?: string | null
  slot?: string | null
  enabled: number | boolean
  proficiency?: number
  revisions?: number
}

interface EvoProposal {
  id: number
  week: string
  targetType: string
  targetKey: string
  title: string
  content: string
  evidence?: string | null
  status: 'pending' | 'approved' | 'rejected' | 'applied'
  decidedBy?: string | null
  decidedAt?: string | null
  createdAt?: string | null
}

interface EvoReport {
  id: number
  week: string
  content: string
  createdAt?: string | null
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

const LAYER_LABEL: Record<string, string> = {
  general: '通用办公',
  professional: '岗位专业',
  industry: '行业技能',
}
const LAYER_STYLE: Record<string, string> = {
  general: 'border-pulse-cyan/40 bg-pulse-cyan/10 text-pulse-cyan',
  professional: 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber',
  industry: 'border-nebula-violet/50 bg-nebula-violet/10 text-nebula-violet',
}

const SLOT_NAMES: Record<string, string> = {
  brain: '公司大脑',
  orggen: '组织生成',
  chat: '对话交互',
  flash: '轻量任务',
  creative: '文案创意',
}

const PROPOSAL_STATUS: Record<string, { cls: string; label: string }> = {
  pending: { cls: 'border-forge-amber/50 bg-forge-amber/10 text-forge-amber', label: '待审批' },
  approved: { cls: 'border-jade-green/40 bg-jade-green/10 text-jade-green', label: '已批准' },
  rejected: { cls: 'border-ember-red/40 bg-ember-red/10 text-ember-red', label: '已驳回' },
  applied: { cls: 'border-pulse-cyan/40 bg-pulse-cyan/10 text-pulse-cyan', label: '已生效' },
}

const TARGET_TYPE_LABEL: Record<string, string> = {
  skill: '技能',
  agent: '数字员工',
  knowledge: '知识库',
  ops: '运营',
}

type TabKey = 'library' | 'matrix' | 'market' | 'proposals' | 'reports'

const TABS: { key: TabKey; label: string; icon: typeof Wrench }[] = [
  { key: 'library', label: '技能库', icon: BookOpenCheck },
  { key: 'matrix', label: '挂载矩阵', icon: Link2 },
  { key: 'market', label: '数字员工技能库', icon: Layers },
  { key: 'proposals', label: '进化提案', icon: Sparkles },
  { key: 'reports', label: '进化周报', icon: FileText },
]

// ─── Tab（迭代 40）：数字员工技能库（匠市 V/U 技能只读总览）─────────────────────

interface MarketSkillRow {
  id: number
  agentId: number
  agentName: string
  agentCode: string
  industryGroup: string
  name: string
  type: string
  complexity: number
  pricePerCall: number
  callCount: number
  successRate: number
  description: string
}

function MarketSkillLibrary({ session }: { session: { token: string } | null }) {
  const [groupFilter, setGroupFilter] = useState('')
  const { data, error, loading } = useWbQuery<MarketSkillRow[]>(
    'skills.marketSkillOverview',
    session,
    {},
    { enabled: !!session?.token },
  )
  const rows: MarketSkillRow[] = Array.isArray(data) ? data : []
  const groups = Array.from(new Set(rows.map((r) => r.industryGroup).filter(Boolean)))
  const filtered = groupFilter ? rows.filter((r) => r.industryGroup === groupFilter) : rows
  const vCount = filtered.filter((r) => r.type === 'V').length
  const uCount = filtered.filter((r) => r.type === 'U').length
  const agentCount = new Set(filtered.map((r) => r.agentId)).size

  if (loading && !data) return <WbLoading text="数字员工技能库加载中…" />
  if (error) return <WbError message={error} />

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          className="rounded-[10px] border border-line-subtle bg-void/60 px-3 py-2 text-sm text-ink-primary outline-none"
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
        >
          <option value="">全部行业大类</option>
          {groups.map((g) => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>
        <span className="ml-auto text-xs text-ink-faint">
          共 {filtered.length} 个技能（V 动作 {vCount} / U 判断 {uCount}），覆盖 {agentCount} 位数字员工
        </span>
      </div>
      {filtered.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-faint">暂无数字员工技能数据。</p>
      ) : (
        <div className="glass-panel overflow-x-auto rounded-xl">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead>
              <tr className="border-b border-line-subtle text-xs text-ink-faint">
                <th className="px-4 py-2.5 font-medium">数字员工</th>
                <th className="px-4 py-2.5 font-medium">行业大类</th>
                <th className="px-4 py-2.5 font-medium">技能</th>
                <th className="px-4 py-2.5 font-medium">类型</th>
                <th className="px-4 py-2.5 font-medium">复杂度</th>
                <th className="px-4 py-2.5 font-medium">单价</th>
                <th className="px-4 py-2.5 font-medium">调用</th>
                <th className="px-4 py-2.5 font-medium">成功率</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-b border-line-subtle/60 last:border-0">
                  <td className="px-4 py-2.5">
                    <p className="text-ink-primary">{r.agentName}</p>
                    <p className="font-mono text-[11px] text-ink-faint">{r.agentCode || `#${r.agentId}`}</p>
                  </td>
                  <td className="px-4 py-2.5 text-ink-secondary">{r.industryGroup || '—'}</td>
                  <td className="px-4 py-2.5">
                    <p className="text-ink-primary">{r.name}</p>
                    {r.description && (
                      <p className="mt-0.5 line-clamp-1 max-w-[280px] text-[11px] text-ink-faint">{r.description}</p>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[11px]',
                        r.type === 'V'
                          ? 'border-pulse-cyan/40 text-pulse-cyan'
                          : 'border-forge-amber/40 text-forge-amber',
                      )}
                    >
                      {r.type === 'V' ? 'V 动作' : 'U 判断'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-ink-secondary">{r.complexity}</td>
                  <td className="px-4 py-2.5 font-mono text-ink-secondary">{r.pricePerCall}</td>
                  <td className="px-4 py-2.5 font-mono text-ink-secondary">{r.callCount}</td>
                  <td className="px-4 py-2.5 font-mono text-ink-secondary">{r.successRate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function mountCountOf(s: SkillRow): number {
  return s.mountCount ?? s.mounts ?? 0
}

// ─── Tab 1：技能库 ───────────────────────────────────────────────────────────

interface SkillEffRow {
  skillKey: string
  uses: number
  adopted: number
  rejected: number
  adoptRate: number | null
  boost: number
}

function SkillLibrary({ session }: { session: { token: string } | null }) {
  const { data, error, loading } = useWbQuery<SkillRow[] | { rows: SkillRow[] }>(
    'skills.list',
    session,
    {},
    { enabled: !!session?.token },
  )
  const eff = useWbQuery<SkillEffRow[]>('skills.effectiveness', session, {}, { enabled: !!session?.token })
  const effMap = new Map((eff.data ?? []).map((e) => [e.skillKey, e]))
  const rows: SkillRow[] = Array.isArray(data) ? data : (data?.rows ?? [])

  if (loading && !data) return <WbLoading text="技能库加载中…" />
  if (error) return <WbError message={error} />
  if (rows.length === 0)
    return <p className="py-10 text-center text-sm text-ink-faint">技能库为空，请先在后端执行种子（skills.seed）。</p>

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {rows.map((s) => (
        <div key={s.skillKey} className="glass-panel relative rounded-xl px-5 py-4">
          <div className="flex items-center gap-2">
            <Wrench className="h-4 w-4 shrink-0 text-forge-amber" />
            <p className="truncate text-sm font-medium text-ink-primary">{s.name}</p>
            <span
              className={cn(
                'ml-auto inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 font-mono text-[11px]',
                LAYER_STYLE[s.layer] ?? 'border-line-subtle text-ink-secondary',
              )}
            >
              {LAYER_LABEL[s.layer] ?? s.layer}
            </span>
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-ink-faint">{s.skillKey}</p>
          <p className="mt-2 line-clamp-2 min-h-[2.5rem] text-xs leading-relaxed text-ink-secondary">
            {s.description ?? '—'}
          </p>
          <div className="mt-3 flex items-center gap-3 text-[11px] text-ink-faint">
            <span className="flex items-center gap-1">
              <BrainCircuit className="h-3 w-3 text-pulse-cyan" />
              槽位：{SLOT_NAMES[s.slot ?? ''] ?? s.slot ?? '—'}
            </span>
            <span className="flex items-center gap-1">
              <Link2 className="h-3 w-3 text-jade-green" />
              挂载数：{mountCountOf(s)}
            </span>
            {(() => {
              const e = effMap.get(s.skillKey)
              if (!e || e.adoptRate === null) return <span>采纳率：—</span>
              return (
                <span className={cn('flex items-center gap-1', e.adoptRate >= 60 ? 'text-jade-green' : e.adoptRate < 40 ? 'text-red-400' : '')}>
                  采纳率：{e.adoptRate}%（{e.adopted}采/{e.rejected}驳）
                </span>
              )
            })()}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Tab 2：挂载矩阵 ─────────────────────────────────────────────────────────

function MountMatrix({ session }: { session: { token: string } | null }) {
  const [agentIdInput, setAgentIdInput] = useState('')
  const [agentId, setAgentId] = useState<number | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const query = useWbQuery<AgentSkillRow[] | { rows: AgentSkillRow[] }>(
    'skills.agentSkills',
    session,
    agentId != null ? { agentId } : {},
    { enabled: !!session?.token && agentId != null },
  )
  const rows: AgentSkillRow[] = Array.isArray(query.data) ? query.data : (query.data?.rows ?? [])

  const toggle = async (skillKey: string, enabled: boolean) => {
    if (agentId == null) return
    setBusyKey(skillKey)
    setActionError(null)
    try {
      await callWb('mutation', 'skills.setEnabled', session, { agentId, skillKey, enabled })
      query.refetch()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <WbPanel hud="MOUNT MATRIX" title="按数字员工查看技能挂载">
      <form
        className="mb-4 flex max-w-md items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          const n = Number(agentIdInput.trim())
          setAgentId(Number.isFinite(n) && n > 0 ? n : null)
        }}
      >
        <div className="flex-1">
          <label className="mb-1.5 block text-xs font-medium text-ink-secondary">数字员工 ID（agentId）</label>
          <input
            className={wbInputCls}
            value={agentIdInput}
            onChange={(e) => setAgentIdInput(e.target.value)}
            placeholder="如 7"
            inputMode="numeric"
          />
        </div>
        <button
          type="submit"
          className="rounded-[10px] border border-pulse-cyan/50 bg-pulse-cyan/10 px-4 py-2 text-sm text-pulse-cyan transition-colors hover:bg-pulse-cyan/20"
        >
          查询
        </button>
      </form>

      {actionError && <WbError message={actionError} className="mb-3" />}
      {agentId == null ? (
        <p className="py-6 text-center text-sm text-ink-faint">输入数字员工 ID 后查看其技能挂载与启停状态。</p>
      ) : query.loading && !query.data ? (
        <WbLoading text={`员工 #${agentId} 技能加载中…`} />
      ) : query.error ? (
        <WbError message={query.error} />
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-faint">员工 #{agentId} 暂无挂载技能。</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-line-subtle text-xs text-ink-faint">
                <th className="pb-2 pr-3 font-medium">技能</th>
                <th className="pb-2 pr-3 font-medium">层级</th>
                <th className="pb-2 pr-3 font-medium">槽位</th>
                <th className="pb-2 pr-3 font-medium">熟练度</th>
                <th className="pb-2 pr-3 font-medium">进化修订</th>
                <th className="pb-2 font-medium">启用</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const enabled = r.enabled === true || r.enabled === 1
                return (
                  <tr key={r.skillKey} className="border-b border-line-subtle/60 last:border-0">
                    <td className="py-2.5 pr-3">
                      <p className="text-ink-primary">{r.name ?? r.skillKey}</p>
                      <p className="font-mono text-[11px] text-ink-faint">{r.skillKey}</p>
                    </td>
                    <td className="py-2.5 pr-3">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[11px]',
                          LAYER_STYLE[r.layer ?? ''] ?? 'border-line-subtle text-ink-secondary',
                        )}
                      >
                        {LAYER_LABEL[r.layer ?? ''] ?? r.layer ?? '—'}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-ink-secondary">{SLOT_NAMES[r.slot ?? ''] ?? r.slot ?? '—'}</td>
                    <td className="py-2.5 pr-3 font-mono text-ink-secondary">{r.proficiency ?? 0}</td>
                    <td className="py-2.5 pr-3 font-mono text-ink-secondary">{r.revisions ?? 0}</td>
                    <td className="py-2.5">
                      <button
                        type="button"
                        disabled={busyKey === r.skillKey}
                        onClick={() => void toggle(r.skillKey, !enabled)}
                        className={cn(
                          'relative h-6 w-11 rounded-full border transition-colors duration-300 disabled:opacity-50',
                          enabled ? 'border-jade-green/50 bg-jade-green/20' : 'border-line-subtle bg-void/60',
                        )}
                        aria-label={enabled ? '停用' : '启用'}
                      >
                        <span
                          className={cn(
                            'absolute top-0.5 rounded-full transition-all duration-300',
                            enabled ? 'left-[22px] bg-jade-green' : 'left-1 bg-ink-faint',
                          )}
                          style={{ height: 18, width: 18 }}
                        />
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
  )
}

// ─── Tab 3：进化提案 ─────────────────────────────────────────────────────────

type ProposalFilter = 'pending' | 'approved' | 'rejected' | 'applied'

function EvoProposals({ session }: { session: { token: string } | null }) {
  const [filter, setFilter] = useState<ProposalFilter>('pending')
  const query = useWbQuery<EvoProposal[] | { rows: EvoProposal[] }>(
    'evo.proposals',
    session,
    { status: filter },
    { enabled: !!session?.token },
  )
  const rows: EvoProposal[] = Array.isArray(query.data) ? query.data : (query.data?.rows ?? [])
  const [busyId, setBusyId] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanNote, setScanNote] = useState<string | null>(null)
  // 迭代59：applied 提案效果回看
  interface ImpactItem {
    proposalId: number
    skillKey: string
    before: { adopted: number; rejected: number; adoptRate: number | null }
    after: { adopted: number; rejected: number; adoptRate: number | null; days: number; fullWindow: boolean }
    verdict: '观察期' | '暂无反馈' | '改善' | '持平' | '恶化'
  }
  const impact = useWbQuery<{ items: ImpactItem[] }>(
    'evo.proposalImpact',
    session,
    {},
    { enabled: !!session?.token && filter === 'applied' },
  )
  const impactMap = new Map((impact.data?.items ?? []).map((i) => [i.proposalId, i]))
  const verdictCls = (v: ImpactItem['verdict']) =>
    v === '改善' ? 'text-jade-green' : v === '恶化' ? 'text-red-400' : 'text-ink-faint'

  const scanBadSkills = async () => {
    setScanning(true)
    setActionError(null)
    setScanNote(null)
    try {
      const r = await callWb<{ generated: number; skipped: number; items: string[] }>(
        'mutation', 'evo.autoDraftBadSkills', session, {},
      )
      setScanNote(`扫描差评技能完成：新草拟 ${r.generated} 条，跳过已有 pending ${r.skipped} 条`)
      setFilter('pending')
      query.refetch()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setScanning(false)
    }
  }

  const decide = async (id: number, action: 'approved' | 'rejected') => {
    setBusyId(id)
    setActionError(null)
    try {
      await callWb('mutation', 'evo.decide', session, { id, action })
      query.refetch()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <WbPanel
      hud="EVO PROPOSALS"
      title="进化提案（LLM 只产出建议，生效必须人工审批）"
      actions={
        <div className="flex gap-1.5">
          <button
            type="button"
            disabled={scanning}
            onClick={scanBadSkills}
            className="rounded-lg border border-forge-amber/50 px-3 py-1 text-xs text-forge-amber transition-colors duration-300 hover:bg-forge-amber/10 disabled:opacity-50"
          >
            {scanning ? '扫描中…' : '扫描差评技能'}
          </button>
          {(['pending', 'approved', 'rejected', 'applied'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-lg border px-3 py-1 text-xs transition-colors duration-300',
                filter === f
                  ? (PROPOSAL_STATUS[f]?.cls ?? 'border-pulse-cyan/50 text-pulse-cyan')
                  : 'border-line-subtle text-ink-secondary hover:border-pulse-cyan/50 hover:text-ink-primary',
              )}
            >
              {PROPOSAL_STATUS[f]?.label ?? f}
            </button>
          ))}
        </div>
      }
    >
      {actionError && <WbError message={actionError} className="mb-3" />}
      {query.error && <WbError message={query.error} className="mb-3" />}
      {scanNote && <p className="mb-3 text-xs text-jade-green">{scanNote}</p>}
      {query.loading && !query.data ? (
        <WbLoading text="提案加载中…" />
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-faint">
          当前无「{PROPOSAL_STATUS[filter]?.label ?? filter}」状态的提案。
        </p>
      ) : (
        <div className="space-y-4">
          {rows.map((p) => {
            const st = PROPOSAL_STATUS[p.status] ?? PROPOSAL_STATUS.pending!
            return (
              <div key={p.id} className="rounded-xl border border-line-subtle bg-void/40 px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Sparkles className="h-4 w-4 shrink-0 text-forge-amber" />
                  <p className="text-sm font-medium text-ink-primary">{p.title}</p>
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[11px]',
                      st.cls,
                    )}
                  >
                    {st.label}
                  </span>
                  <span className="ml-auto font-mono text-[11px] text-ink-faint">
                    {p.week} · {TARGET_TYPE_LABEL[p.targetType] ?? p.targetType} / {p.targetKey}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-secondary">{p.content}</p>
                {p.evidence && (
                  <div className="mt-3 rounded-lg border border-line-subtle bg-panel/40 px-3.5 py-2.5">
                    <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-ink-faint">
                      <Layers className="h-3 w-3 text-pulse-cyan" />
                      数据依据
                    </p>
                    <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink-secondary">{p.evidence}</p>
                  </div>
                )}
                {p.status === 'applied' && impactMap.has(p.id) && (() => {
                  const im = impactMap.get(p.id)!
                  const fmtR = (x: { adopted: number; rejected: number; adoptRate: number | null }) =>
                    x.adoptRate === null ? '—' : `${x.adoptRate}%（${x.adopted}采/${x.rejected}驳）`
                  return (
                    <p className="mt-3 text-[11px] text-ink-faint">
                      效果回看：前 7 天 {fmtR(im.before)} → 应用后 {fmtR(im.after)}
                      {im.after.fullWindow ? '' : `（观察期 ${im.after.days}/7 天）`}
                      <span className={cn('ml-2 font-medium', verdictCls(im.verdict))}>{im.verdict}</span>
                    </p>
                  )
                })()}
                {p.status === 'pending' ? (
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      disabled={busyId === p.id}
                      onClick={() => void decide(p.id, 'approved')}
                      className="flex items-center gap-1.5 rounded-md border border-jade-green/40 px-3 py-1.5 text-xs text-jade-green transition-colors hover:bg-jade-green/[0.08] disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      批准
                    </button>
                    <button
                      type="button"
                      disabled={busyId === p.id}
                      onClick={() => void decide(p.id, 'rejected')}
                      className="flex items-center gap-1.5 rounded-md border border-ember-red/40 px-3 py-1.5 text-xs text-ember-red transition-colors hover:bg-ember-red/[0.08] disabled:opacity-50"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      驳回
                    </button>
                  </div>
                ) : (
                  <p className="mt-3 text-[11px] text-ink-faint">
                    {p.decidedBy ? `决策人：${p.decidedBy}` : ''}
                    {p.decidedAt ? ` · ${new Date(p.decidedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </WbPanel>
  )
}

// ─── Tab 4：进化周报 ─────────────────────────────────────────────────────────

function EvoReports({ session }: { session: { token: string } | null }) {
  const query = useWbQuery<EvoReport[] | { rows: EvoReport[] }>(
    'evo.reports',
    session,
    {},
    { enabled: !!session?.token },
  )
  const rows: EvoReport[] = Array.isArray(query.data) ? query.data : (query.data?.rows ?? [])
  const [generating, setGenerating] = useState(false)
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const generate = async () => {
    setGenerating(true)
    setActionMsg(null)
    setActionError(null)
    try {
      const res = await callWb<{ week?: string }>('mutation', 'evo.generateReport', session, {})
      setActionMsg(`已生成周报 ${res?.week ?? ''}（重复生成会覆盖同周内容）。`)
      query.refetch()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <WbPanel
      hud="EVO WEEKLY"
      title="进化周报"
      actions={
        <button
          type="button"
          disabled={generating}
          onClick={() => void generate()}
          className="flex items-center gap-1.5 rounded-[10px] border border-forge-amber/50 bg-forge-amber/10 px-4 py-2 text-sm text-forge-amber transition-colors hover:bg-forge-amber/20 disabled:opacity-50"
        >
          <RefreshCw className={cn('h-4 w-4', generating && 'animate-spin')} />
          {generating ? '生成中…' : '生成本周周报'}
        </button>
      }
    >
      {actionMsg && (
        <p className="mb-3 rounded-lg border border-jade-green/30 bg-jade-green/[0.06] px-3.5 py-2 text-xs text-jade-green">
          {actionMsg}
        </p>
      )}
      {actionError && <WbError message={actionError} className="mb-3" />}
      {query.error && <WbError message={query.error} className="mb-3" />}
      {query.loading && !query.data ? (
        <WbLoading text="周报加载中…" />
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-faint">暂无周报，点击右上角「生成本周周报」。</p>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => {
            const expanded = expandedId === r.id
            return (
              <div key={r.id} className="rounded-xl border border-line-subtle bg-void/40 px-5 py-4">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 shrink-0 text-pulse-cyan" />
                  <p className="font-mono text-sm font-medium text-ink-primary">{r.week}</p>
                  <span className="ml-auto font-mono text-[11px] text-ink-faint">
                    {r.createdAt ? new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false }) : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : r.id)}
                    className="flex items-center gap-1 rounded-md border border-line-subtle px-2.5 py-1 text-[11px] text-ink-secondary transition-colors hover:border-pulse-cyan/50 hover:text-ink-primary"
                  >
                    {expanded ? (
                      <>
                        收起 <ChevronUp className="h-3 w-3" />
                      </>
                    ) : (
                      <>
                        展开全文 <ChevronDown className="h-3 w-3" />
                      </>
                    )}
                  </button>
                </div>
                <p
                  className={cn(
                    'mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-secondary',
                    !expanded && 'line-clamp-3',
                  )}
                >
                  {r.content}
                </p>
              </div>
            )
          })}
        </div>
      )}
    </WbPanel>
  )
}

// ─── 主页面 ──────────────────────────────────────────────────────────────────

export default function AdminSkills() {
  const { session } = useWbSession()
  const [tab, setTab] = useState<TabKey>('library')

  return (
    <div>
      <WbPageHeader
        hud="SKILL CENTER"
        title="技能中心"
        desc="技能库与挂载管理、自进化提案审批与周报——LLM 只产出建议，生效必须人工审批。"
      />

      {/* Tab 栏 */}
      <div className="mb-5 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border px-3.5 py-1.5 text-sm transition-colors duration-300',
              tab === t.key
                ? 'border-forge-amber/50 bg-forge-amber/10 font-medium text-forge-amber'
                : 'border-line-subtle text-ink-secondary hover:border-pulse-cyan/50 hover:text-ink-primary',
            )}
          >
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'library' && <SkillLibrary session={session} />}
      {tab === 'matrix' && <MountMatrix session={session} />}
      {tab === 'market' && <MarketSkillLibrary session={session} />}
      {tab === 'proposals' && <EvoProposals session={session} />}
      {tab === 'reports' && <EvoReports session={session} />}

      {/* 信号说明 */}
      <p className="mt-6 flex items-center gap-1.5 text-[11px] text-ink-faint">
        <Cpu className="h-3 w-3" />
        工作台反馈信号（
        <ThumbsUp className="inline h-3 w-3 text-jade-green" />
        有用 /
        <ThumbsDown className="inline h-3 w-3 text-ember-red" />
        没用 / 返工）驱动每周复盘引擎生成上方进化提案。
      </p>
    </div>
  )
}
