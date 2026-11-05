import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Link } from 'react-router'
import { motion } from 'framer-motion'
import {
  BadgeCheck,
  Briefcase,
  Building2,
  CheckCircle2,
  Clock3,
  Coins,
  Flame,
  Layers,
  Loader2,
  LogIn,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  UserRound,
  Users,
  Wrench,
  X,
} from 'lucide-react'
import { trpc } from '@/providers/trpc'
import { useAuth } from '@/hooks/useAuth'
import { LOGIN_PATH } from '@/const'
import GlowButton from '@/components/GlowButton'
import HudCorner from '@/components/HudCorner'
import TagChip from '@/components/TagChip'
import SectionHeader from '@/components/SectionHeader'
import ApplyDialog from '@/components/recruit/ApplyDialog'
import RecruitmentApplications from '@/components/recruit/RecruitmentApplications'
import MyApplications from '@/components/recruit/MyApplications'
import { cn } from '@/lib/utils'

// ─── 常量 ────────────────────────────────────────────────────────────────────
const INDUSTRIES = ['机械制造', '装备制造', '汽车零部件', '压力容器', '精密仪器', '模具钢加工', '电子装配', '航空配套']
const CAP_SUGGESTIONS = ['振动诊断', '声学检测', '焊接工艺', '精密测量', '热处理', '产线巡检', '故障预测', '质量评估', '工艺优化', 'SPC']
const AVATARS = [
  { src: '/avatar-zhenheng.png', label: '振衡' },
  { src: '/avatar-tingtao.png', label: '听涛' },
  { src: '/avatar-chimou.png', label: '炽眸' },
  { src: '/avatar-hengzhun.png', label: '衡准' },
  { src: '/avatar-celu.png', label: '策炉' },
  { src: '/avatar-xunxian.png', label: '巡线' },
] as const
type AvatarSrc = (typeof AVATARS)[number]['src']

const RECRUIT_STATUS: Record<string, { label: string; cls: string }> = {
  open: { label: '招募中', cls: 'border-jade-green/40 bg-jade-green/10 text-jade-green' },
  filled: { label: '已招满', cls: 'border-pulse-cyan/40 bg-pulse-cyan/10 text-pulse-cyan' },
  closed: { label: '已关闭', cls: 'border-line-subtle bg-panel/60 text-ink-faint' },
}
const AGENT_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '待审核', cls: 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber' },
  active: { label: '上架中', cls: 'border-jade-green/40 bg-jade-green/10 text-jade-green' },
  suspended: { label: '已下架', cls: 'border-ember-red/40 bg-ember-red/10 text-ember-red' },
}

// ─── 基础表单样式 ────────────────────────────────────────────────────────────
const inputCls =
  'w-full rounded-[10px] border border-line-subtle bg-void/60 px-4 py-2.5 text-sm text-ink-primary placeholder:text-ink-faint outline-none transition-colors focus:border-pulse-cyan/60 focus:bg-void/80'

function Field({ label, hud, children }: { label: string; hud?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-ink-secondary">{label}</span>
        {hud && <span className="hud-label">{hud}</span>}
      </span>
      {children}
    </label>
  )
}

function Feedback({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null
  return (
    <motion.p
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        'flex items-center gap-2 rounded-[10px] border px-4 py-2.5 text-[13px]',
        msg.ok ? 'border-jade-green/40 bg-jade-green/10 text-jade-green' : 'border-ember-red/40 bg-ember-red/10 text-ember-red',
      )}
    >
      {msg.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <X className="h-4 w-4 shrink-0" />}
      {msg.text}
    </motion.p>
  )
}

/** 能力标签编辑：chip 增删 + 回车添加 */
function TagInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const add = (raw: string) => {
    const v = raw.trim()
    if (!v || tags.includes(v) || tags.length >= 8) return
    onChange([...tags, v])
    setDraft('')
  }
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line-subtle bg-void/60 px-3 py-2.5">
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1.5 rounded-full border border-pulse-cyan/40 bg-pulse-cyan/10 px-3 py-1 text-xs text-pulse-cyan">
            {t}
            <button type="button" aria-label={`移除 ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))} className="text-pulse-cyan/60 hover:text-pulse-cyan">
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add(draft)
            }
          }}
          placeholder={tags.length ? '' : '输入标签后回车添加'}
          className="min-w-[120px] flex-1 bg-transparent py-1 text-sm text-ink-primary placeholder:text-ink-faint outline-none"
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {CAP_SUGGESTIONS.filter((s) => !tags.includes(s)).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => add(s)}
            className="rounded-full border border-line-subtle px-2.5 py-0.5 text-[11px] text-ink-faint transition-colors hover:border-pulse-cyan/40 hover:text-pulse-cyan"
          >
            + {s}
          </button>
        ))}
      </div>
    </div>
  )
}

function SubmitButton({ pending, disabled, children }: { pending: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <motion.button
      type="submit"
      disabled={disabled || pending}
      whileHover={disabled || pending ? undefined : { scale: 1.02 }}
      whileTap={disabled || pending ? undefined : { scale: 0.98 }}
      className={cn(
        'group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-[10px] bg-amber-gradient px-6 py-3 text-sm font-medium text-[#1A1206] transition-shadow duration-300 hover:shadow-[0_0_28px_rgba(245,165,36,0.45)]',
        (disabled || pending) && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/30 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-full"
      />
      <span className="relative z-10 inline-flex items-center gap-2">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        {children}
      </span>
    </motion.button>
  )
}

// ─── 表单 1：发布招募 ────────────────────────────────────────────────────────
function RecruitmentForm({ canSubmit }: { canSubmit: boolean }) {
  const utils = trpc.useUtils()
  const [title, setTitle] = useState('')
  const [industry, setIndustry] = useState(INDUSTRIES[0])
  const [tags, setTags] = useState<string[]>([])
  const [description, setDescription] = useState('')
  const [budget, setBudget] = useState('12000')
  const [period, setPeriod] = useState('12')
  const [urgent, setUrgent] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const create = trpc.recruitments.create.useMutation({
    onSuccess: async (r) => {
      setMsg({ ok: true, text: `招募单「${r.title}」已发布，进入招募大厅。` })
      setTitle(''); setTags([]); setDescription(''); setUrgent(false)
      await Promise.all([utils.recruitments.list.invalidate(), utils.recruitments.mine.invalidate()])
    },
    onError: (e) => setMsg({ ok: false, text: e.message || '发布失败，请稍后重试。' }),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    if (tags.length === 0) return setMsg({ ok: false, text: '请至少添加一个所需能力标签。' })
    create.mutate({
      title: title.trim(),
      industry,
      capabilityTags: tags,
      description: description.trim(),
      budgetMonthly: Number(budget) || 0,
      periodMonths: Number(period) || 1,
      urgent,
    })
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="grid gap-5 md:grid-cols-2">
        <Field label="招募标题" hud="TITLE">
          <input required minLength={2} maxLength={128} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：急招数控车间振动诊断数字工匠" className={inputCls} />
        </Field>
        <Field label="所属行业" hud="INDUSTRY">
          <select value={industry} onChange={(e) => setIndustry(e.target.value)} className={inputCls}>
            {INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
        </Field>
      </div>
      <Field label="所需能力标签（最多 8 个）" hud="CAPABILITIES">
        <TagInput tags={tags} onChange={setTags} />
      </Field>
      <Field label="任务描述" hud="BRIEF">
        <textarea required minLength={10} maxLength={2000} rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="描述产线背景、设备情况、期望 Agent 承担的任务与交付物…" className={cn(inputCls, 'resize-none leading-relaxed')} />
      </Field>
      <div className="grid gap-5 md:grid-cols-3">
        <Field label="预算（Token / 月）" hud="BUDGET">
          <input required type="number" min={100} max={1000000} step={100} value={budget} onChange={(e) => setBudget(e.target.value)} className={cn(inputCls, 'font-mono')} />
        </Field>
        <Field label="周期（月）" hud="PERIOD">
          <input required type="number" min={1} max={36} value={period} onChange={(e) => setPeriod(e.target.value)} className={cn(inputCls, 'font-mono')} />
        </Field>
        <Field label="急聘标记" hud="URGENT">
          <button
            type="button"
            onClick={() => setUrgent((v) => !v)}
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-[10px] border px-4 py-2.5 text-sm transition-colors',
              urgent ? 'border-forge-amber/60 bg-forge-amber/15 text-forge-amber' : 'border-line-subtle bg-void/60 text-ink-faint hover:text-ink-secondary',
            )}
          >
            <Flame className="h-4 w-4" />
            {urgent ? '已标记急聘' : '标记为急聘'}
          </button>
        </Field>
      </div>
      <Feedback msg={msg} />
      <SubmitButton pending={create.isPending} disabled={!canSubmit}>
        {canSubmit ? '发布招募单' : '登录后可发布招募'}
      </SubmitButton>
    </form>
  )
}

// ─── 表单 2：上架 Agent ─────────────────────────────────────────────────────
type SkillDraft = { name: string; type: 'V' | 'U'; complexity: number; pricePerCall: string; description: string }
const emptySkill = (): SkillDraft => ({ name: '', type: 'V', complexity: 3, pricePerCall: '100', description: '' })

function AgentForm({ canSubmit }: { canSubmit: boolean }) {
  const utils = trpc.useUtils()
  const [name, setName] = useState('')
  const [industry, setIndustry] = useState(INDUSTRIES[0])
  const [tags, setTags] = useState<string[]>([])
  const [signature, setSignature] = useState('')
  const [intro, setIntro] = useState('')
  const [price, setPrice] = useState('9800')
  const [avatar, setAvatar] = useState<AvatarSrc>(AVATARS[0].src)
  const [skillDrafts, setSkillDrafts] = useState<SkillDraft[]>([])
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const create = trpc.agents.create.useMutation({
    onSuccess: async ({ agent }) => {
      setMsg({ ok: true, text: `「${agent.name}」（${agent.code}）已提交上架，进入平台审核队列。` })
      setName(''); setTags([]); setSignature(''); setIntro(''); setSkillDrafts([])
      await utils.agents.list.invalidate()
    },
    onError: (e) => setMsg({ ok: false, text: e.message || '上架失败，请稍后重试。' }),
  })

  const setSkill = (i: number, patch: Partial<SkillDraft>) =>
    setSkillDrafts((arr) => arr.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    if (tags.length === 0) return setMsg({ ok: false, text: '请至少添加一个能力标签。' })
    const skills = skillDrafts
      .filter((s) => s.name.trim())
      .map((s) => ({
        name: s.name.trim(),
        type: s.type,
        complexity: s.complexity,
        pricePerCall: Number(s.pricePerCall) || 100,
        description: s.description.trim() || undefined,
      }))
    create.mutate({
      name: name.trim(),
      industry,
      capabilityTags: tags,
      masterSignature: signature.trim(),
      intro: intro.trim(),
      monthlyPrice: Number(price) || 0,
      avatar,
      initialSkills: skills,
    })
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="grid gap-5 md:grid-cols-2">
        <Field label="工匠名称" hud="NAME">
          <input required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} placeholder="如：听岚 / 焊瞳" className={inputCls} />
        </Field>
        <Field label="所属行业" hud="INDUSTRY">
          <select value={industry} onChange={(e) => setIndustry(e.target.value)} className={inputCls}>
            {INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
        </Field>
      </div>
      <Field label="能力标签（最多 8 个）" hud="CAPABILITIES">
        <TagInput tags={tags} onChange={setTags} />
      </Field>
      <div className="grid gap-5 md:grid-cols-2">
        <Field label="老师傅署名" hud="MASTER">
          <input required minLength={2} maxLength={128} value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="如：陈国栋 · 32年数控经验" className={inputCls} />
        </Field>
        <Field label="初始月薪定价（Token）" hud="PRICE">
          <input required type="number" min={100} max={1000000} step={100} value={price} onChange={(e) => setPrice(e.target.value)} className={cn(inputCls, 'font-mono')} />
        </Field>
      </div>
      <Field label="工匠简介" hud="INTRO">
        <textarea required minLength={10} maxLength={1000} rows={3} value={intro} onChange={(e) => setIntro(e.target.value)} placeholder="一句话讲清这位数字工匠师承何处、擅长什么、适合什么产线…" className={cn(inputCls, 'resize-none leading-relaxed')} />
      </Field>
      <Field label="选择头像" hud="AVATAR">
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          {AVATARS.map((a) => (
            <button
              key={a.src}
              type="button"
              onClick={() => setAvatar(a.src)}
              className={cn(
                'group relative overflow-hidden rounded-[12px] border transition-all',
                avatar === a.src ? 'border-pulse-cyan shadow-[0_0_18px_rgba(34,211,238,0.35)]' : 'border-line-subtle opacity-60 hover:opacity-100',
              )}
            >
              <img src={a.src} alt={a.label} className="aspect-square w-full object-cover" />
              <span className="absolute inset-x-0 bottom-0 bg-void/70 py-1 text-center text-[10px] text-ink-secondary">{a.label}</span>
            </button>
          ))}
        </div>
      </Field>

      {/* 初始技能 */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-medium text-ink-secondary">初始技能（可选，最多 8 项）</span>
          <button
            type="button"
            onClick={() => setSkillDrafts((arr) => (arr.length >= 8 ? arr : [...arr, emptySkill()]))}
            className="inline-flex items-center gap-1 rounded-full border border-pulse-cyan/40 px-3 py-1 text-xs text-pulse-cyan transition-colors hover:bg-pulse-cyan/10"
          >
            <Plus className="h-3 w-3" /> 新建技能
          </button>
        </div>
        <div className="space-y-3">
          {skillDrafts.map((s, i) => (
            <div key={i} className="relative rounded-[12px] border border-line-subtle bg-void/40 p-4">
              <button type="button" aria-label="移除技能" onClick={() => setSkillDrafts((arr) => arr.filter((_, idx) => idx !== i))} className="absolute right-3 top-3 text-ink-faint hover:text-ember-red">
                <X className="h-4 w-4" />
              </button>
              <div className="grid gap-3 md:grid-cols-[1fr_120px_110px_130px]">
                <input value={s.name} onChange={(e) => setSkill(i, { name: e.target.value })} placeholder="技能名称，如：主轴振动频谱分析" className={inputCls} />
                <select value={s.type} onChange={(e) => setSkill(i, { type: e.target.value as 'V' | 'U' })} className={inputCls}>
                  <option value="V">V · 动作</option>
                  <option value="U">U · 判断</option>
                </select>
                <select value={s.complexity} onChange={(e) => setSkill(i, { complexity: Number(e.target.value) })} className={inputCls}>
                  {[1, 2, 3, 4, 5].map((c) => <option key={c} value={c}>复杂度 {c}</option>)}
                </select>
                <input type="number" min={1} value={s.pricePerCall} onChange={(e) => setSkill(i, { pricePerCall: e.target.value })} placeholder="Token/次" className={cn(inputCls, 'font-mono')} />
              </div>
            </div>
          ))}
          {skillDrafts.length === 0 && (
            <p className="rounded-[12px] border border-dashed border-line-subtle px-4 py-3 text-center text-xs text-ink-faint">
              暂无初始技能 —— 可先上架工匠，稍后在「上架技能」页签补充
            </p>
          )}
        </div>
      </div>

      <Feedback msg={msg} />
      <SubmitButton pending={create.isPending} disabled={!canSubmit}>
        {canSubmit ? '提交上架审核' : '登录后可上架 Agent'}
      </SubmitButton>
    </form>
  )
}

// ─── 表单 3：上架技能 ────────────────────────────────────────────────────────
function SkillForm({ canSubmit }: { canSubmit: boolean }) {
  const utils = trpc.useUtils()
  const agentsQuery = trpc.agents.list.useQuery({ limit: 100, sort: 'newest' })
  const agentItems = agentsQuery.data?.items ?? []

  const [agentId, setAgentId] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [type, setType] = useState<'V' | 'U'>('V')
  const [complexity, setComplexity] = useState(3)
  const [price, setPrice] = useState('100')
  const [description, setDescription] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const effectiveAgentId = agentId ?? agentItems[0]?.id ?? null

  const create = trpc.skills.create.useMutation({
    onSuccess: async (s) => {
      setMsg({ ok: true, text: `技能「${s.name}」已上架并关联到所属 Agent。` })
      setName(''); setDescription('')
      await utils.agents.list.invalidate()
    },
    onError: (e) => setMsg({ ok: false, text: e.message || '上架失败，请稍后重试。' }),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    if (!effectiveAgentId) return setMsg({ ok: false, text: '请先在「上架 Agent」创建一位工匠。' })
    create.mutate({
      agentId: effectiveAgentId,
      name: name.trim(),
      type,
      complexity,
      pricePerCall: Number(price) || 0,
      description: description.trim() || undefined,
    })
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <Field label="所属 Agent" hud="AGENT">
        <select
          value={effectiveAgentId ?? ''}
          onChange={(e) => setAgentId(Number(e.target.value))}
          className={inputCls}
          disabled={agentItems.length === 0}
        >
          {agentItems.length === 0 && <option value="">暂无上架中的工匠</option>}
          {agentItems.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {a.code}（{AGENT_STATUS[a.status]?.label ?? a.status}）
            </option>
          ))}
        </select>
      </Field>
      <div className="grid gap-5 md:grid-cols-2">
        <Field label="技能名称" hud="SKILL">
          <input required minLength={2} maxLength={128} value={name} onChange={(e) => setName(e.target.value)} placeholder="如：焊缝缺陷二次判读" className={inputCls} />
        </Field>
        <Field label="技能类型" hud="TYPE">
          <div className="grid grid-cols-2 gap-2">
            {([['V', 'V · 动作类'], ['U', 'U · 判断逻辑']] as const).map(([v, label]) => (
              <button
                key={v}
                type="button"
                onClick={() => setType(v)}
                className={cn(
                  'rounded-[10px] border px-3 py-2.5 font-mono text-xs transition-colors',
                  type === v ? 'border-pulse-cyan/60 bg-pulse-cyan/10 text-pulse-cyan' : 'border-line-subtle bg-void/60 text-ink-faint hover:text-ink-secondary',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        <Field label="复杂度（1-5）" hud="COMPLEXITY">
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setComplexity(c)}
                className={cn(
                  'h-10 flex-1 rounded-[10px] border font-mono text-sm transition-colors',
                  complexity === c ? 'border-forge-amber/60 bg-forge-amber/15 text-forge-amber' : 'border-line-subtle bg-void/60 text-ink-faint hover:text-ink-secondary',
                )}
              >
                {c}
              </button>
            ))}
          </div>
        </Field>
        <Field label="单次调用价（Token）" hud="PRICE / CALL">
          <input required type="number" min={1} max={100000} value={price} onChange={(e) => setPrice(e.target.value)} className={cn(inputCls, 'font-mono')} />
        </Field>
      </div>
      <Field label="技能说明" hud="DESC">
        <textarea maxLength={255} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="输入输出、适用工况、调用约束…" className={cn(inputCls, 'resize-none leading-relaxed')} />
      </Field>
      <Feedback msg={msg} />
      <SubmitButton pending={create.isPending} disabled={!canSubmit || agentItems.length === 0}>
        {canSubmit ? '上架技能' : '登录后可上架技能'}
      </SubmitButton>
    </form>
  )
}

// ─── 我的发布 ────────────────────────────────────────────────────────────────
function MyPublications() {
  const { isAuthenticated } = useAuth()
  const utils = trpc.useUtils()
  const mine = trpc.recruitments.mine.useQuery(undefined, { enabled: isAuthenticated, retry: false })
  const agentsQuery = trpc.agents.list.useQuery({ limit: 100, sort: 'newest' })
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const close = trpc.recruitments.close.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.recruitments.mine.invalidate(), utils.recruitments.list.invalidate()])
    },
  })

  const listed = (agentsQuery.data?.items ?? []).filter((a) => a.status === 'pending' || a.status === 'active')

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* 我的招募单 */}
      <div className="glass-panel relative rounded-2xl p-7">
        <HudCorner />
        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className="hud-label text-pulse-cyan/80">MY RECRUITMENTS</p>
            <h3 className="mt-1 font-display text-lg font-bold text-ink-primary">我的招募单</h3>
          </div>
          <span className="rounded-full border border-line-subtle px-3 py-1 font-mono text-xs text-ink-faint">
            {isAuthenticated ? `${mine.data?.length ?? 0} 条` : '未登录'}
          </span>
        </div>
        {!isAuthenticated ? (
          <p className="rounded-[12px] border border-dashed border-line-subtle px-4 py-6 text-center text-sm text-ink-faint">
            登录后可查看与管理你发布的招募单
          </p>
        ) : mine.isLoading ? (
          <p className="flex items-center gap-2 py-6 text-sm text-ink-faint"><Loader2 className="h-4 w-4 animate-spin" /> 加载中…</p>
        ) : (mine.data?.length ?? 0) === 0 ? (
          <p className="rounded-[12px] border border-dashed border-line-subtle px-4 py-6 text-center text-sm text-ink-faint">
            还没有发布记录 —— 在上方「发布招募」发出第一单
          </p>
        ) : (
          <ul className="space-y-3">
            {mine.data!.map((r) => {
              const st = RECRUIT_STATUS[r.status] ?? RECRUIT_STATUS.closed
              return (
                <li key={r.id} className="rounded-[12px] border border-line-subtle bg-void/40 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink-primary">
                        {r.urgent && <Flame className="mr-1 inline h-3.5 w-3.5 text-forge-amber" />}
                        {r.title}
                      </p>
                      <p className="mt-1 font-mono text-xs text-ink-faint">
                        {r.budgetMonthly.toLocaleString()} Token/月 · {r.periodMonths} 个月 · {r.industry}
                      </p>
                    </div>
                    <span className={cn('shrink-0 rounded-full border px-2.5 py-0.5 text-[11px]', st.cls)}>{st.label}</span>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={() => setExpandedId((v) => (v === r.id ? null : r.id))}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] transition-colors',
                        expandedId === r.id
                          ? 'border-pulse-cyan/60 bg-pulse-cyan/10 text-pulse-cyan'
                          : 'border-line-subtle text-ink-faint hover:border-pulse-cyan/40 hover:text-pulse-cyan',
                      )}
                    >
                      <Users className="h-3 w-3" />
                      {expandedId === r.id ? '收起亚征' : '查看应征'}
                    </button>
                    {r.status !== 'closed' && (
                      <button
                        onClick={() => close.mutate({ id: r.id })}
                        disabled={close.isPending}
                        className="rounded-full border border-line-subtle px-3 py-1 text-[11px] text-ink-faint transition-colors hover:border-ember-red/50 hover:text-ember-red disabled:opacity-50"
                      >
                        关闭招募
                      </button>
                    )}
                  </div>
                  {expandedId === r.id && (
                    <RecruitmentApplications recruitmentId={r.id} recruitmentOpen={r.status === 'open'} />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* 上架中的 Agent */}
      <div className="glass-panel relative rounded-2xl p-7">
        <HudCorner />
        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className="hud-label text-pulse-cyan/80">LISTED AGENTS</p>
            <h3 className="mt-1 font-display text-lg font-bold text-ink-primary">平台上架中的 Agent</h3>
          </div>
          <span className="rounded-full border border-line-subtle px-3 py-1 font-mono text-xs text-ink-faint">{listed.length} 位</span>
        </div>
        {agentsQuery.isLoading ? (
          <p className="flex items-center gap-2 py-6 text-sm text-ink-faint"><Loader2 className="h-4 w-4 animate-spin" /> 加载中…</p>
        ) : listed.length === 0 ? (
          <p className="rounded-[12px] border border-dashed border-line-subtle px-4 py-6 text-center text-sm text-ink-faint">
            暂无上架中的工匠 —— 在「上架 Agent」提交第一位
          </p>
        ) : (
          <ul className="space-y-3">
            {listed.map((a) => {
              const st = AGENT_STATUS[a.status] ?? AGENT_STATUS.pending
              return (
                <li key={a.id} className="flex items-center gap-4 rounded-[12px] border border-line-subtle bg-void/40 p-4 transition-colors hover:border-pulse-cyan/30">
                  <img src={a.avatar} alt={a.name} className="h-12 w-12 shrink-0 rounded-[10px] border border-line-subtle object-cover" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium text-ink-primary">
                      <span className="truncate">{a.name}</span>
                      <span className="font-mono text-[11px] text-ink-faint">{a.code}</span>
                      {a.certified && <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-pulse-cyan" />}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-ink-faint">{a.masterSignature ?? a.industry}</p>
                    <p className="mt-1 font-mono text-xs text-forge-amber">{a.monthlyPrice.toLocaleString()} Token/月</p>
                  </div>
                  <span className={cn('shrink-0 rounded-full border px-2.5 py-0.5 text-[11px]', st.cls)}>{st.label}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

// ─── 招募大厅 ────────────────────────────────────────────────────────────────
function RecruitmentHall() {
  const { isAuthenticated } = useAuth()
  const [industry, setIndustry] = useState<string | null>(null)
  const [applyTarget, setApplyTarget] = useState<{ id: number; title: string; budgetMonthly: number; periodMonths: number } | null>(null)
  const list = trpc.recruitments.list.useQuery(industry ? { industry } : undefined)
  const items = list.data ?? []

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setIndustry(null)}
          className={cn(
            'rounded-full border px-3.5 py-1.5 text-xs transition-colors',
            industry === null ? 'border-pulse-cyan/60 bg-pulse-cyan/10 text-pulse-cyan' : 'border-line-subtle text-ink-faint hover:text-ink-secondary',
          )}
        >
          全部行业
        </button>
        {INDUSTRIES.map((i) => (
          <button
            key={i}
            onClick={() => setIndustry(i)}
            className={cn(
              'rounded-full border px-3.5 py-1.5 text-xs transition-colors',
              industry === i ? 'border-pulse-cyan/60 bg-pulse-cyan/10 text-pulse-cyan' : 'border-line-subtle text-ink-faint hover:text-ink-secondary',
            )}
          >
            {i}
          </button>
        ))}
      </div>

      {list.isLoading ? (
        <p className="flex items-center gap-2 py-10 text-sm text-ink-faint"><Loader2 className="h-4 w-4 animate-spin" /> 正在接入招募大厅…</p>
      ) : items.length === 0 ? (
        <p className="rounded-[12px] border border-dashed border-line-subtle px-4 py-10 text-center text-sm text-ink-faint">
          该行业暂无招募单
        </p>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {items.map((r, idx) => {
            const st = RECRUIT_STATUS[r.status] ?? RECRUIT_STATUS.closed
            return (
              <motion.article
                key={r.id}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ duration: 0.5, delay: (idx % 3) * 0.08, ease: [0.16, 1, 0.3, 1] }}
                className="glass-panel group relative flex flex-col rounded-2xl p-6 transition-all duration-300 hover:-translate-y-1.5 hover:shadow-[0_0_24px_rgba(124,92,255,0.35)]"
              >
                <HudCorner />
                <div className="flex items-start justify-between gap-3">
                  <p className="flex items-center gap-1.5 text-[11px] text-ink-faint">
                    <Building2 className="h-3.5 w-3.5" />
                    <span className="truncate">{r.enterpriseName ?? '匿名企业'}</span>
                  </p>
                  <span className={cn('shrink-0 rounded-full border px-2.5 py-0.5 text-[11px]', st.cls)}>{st.label}</span>
                </div>
                <h3 className="mt-3 text-base font-bold leading-snug text-ink-primary">
                  {r.urgent && (
                    <span className="mr-1.5 inline-flex items-center gap-0.5 rounded-full border border-forge-amber/50 bg-forge-amber/10 px-2 py-0.5 align-middle text-[10px] text-forge-amber">
                      <Flame className="h-3 w-3" /> 急聘
                    </span>
                  )}
                  {r.title}
                </h3>
                <p className="mt-2 line-clamp-3 flex-1 text-[13px] leading-relaxed text-ink-secondary">{r.description}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {r.capabilityTags.map((t) => <TagChip key={t} label={t} />)}
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-line-subtle pt-4">
                  <span className="flex items-center gap-1.5 font-mono text-sm text-forge-amber">
                    <Coins className="h-4 w-4" />
                    {r.budgetMonthly.toLocaleString()}
                    <span className="text-[11px] text-ink-faint">Token/月</span>
                  </span>
                  <span className="flex items-center gap-1 font-mono text-[11px] text-ink-faint">
                    <Clock3 className="h-3.5 w-3.5" /> {r.periodMonths} 个月
                  </span>
                </div>
                {r.status === 'open' && (
                  <button
                    onClick={() => {
                      if (!isAuthenticated) {
                        window.location.href = LOGIN_PATH
                        return
                      }
                      setApplyTarget({ id: r.id, title: r.title, budgetMonthly: r.budgetMonthly, periodMonths: r.periodMonths })
                    }}
                    className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-[10px] border border-nebula-violet/50 bg-nebula-violet/10 px-4 py-2.5 text-sm font-medium text-nebula-violet transition-all hover:bg-nebula-violet/20 hover:shadow-[0_0_20px_rgba(124,92,255,0.3)]"
                  >
                    <Send className="h-4 w-4" />
                    {isAuthenticated ? '应征' : '登录后应征'}
                  </button>
                )}
              </motion.article>
            )
          })}
        </div>
      )}
      <ApplyDialog
        recruitment={applyTarget}
        open={applyTarget !== null}
        onOpenChange={(v) => { if (!v) setApplyTarget(null) }}
      />
    </div>
  )
}

// ─── 页面 ────────────────────────────────────────────────────────────────────
type TabKey = 'recruit' | 'agent' | 'skill'
const TABS: { key: TabKey; label: string; hud: string; icon: typeof Briefcase; desc: string }[] = [
  { key: 'recruit', label: '发布招募', hud: 'POST RECRUITMENT', icon: Briefcase, desc: '发布 Agent 招募需求，进入全平台招募大厅' },
  { key: 'agent', label: '上架 Agent', hud: 'LIST AGENT', icon: UserRound, desc: '把老师傅的经验封装为数字工匠，提交平台审核' },
  { key: 'skill', label: '上架技能', hud: 'LIST SKILL', icon: Wrench, desc: '为已上架工匠补充动作 / 判断类技能' },
]

export default function Enterprise() {
  const { user, isAuthenticated, isLoading } = useAuth()
  const [tab, setTab] = useState<TabKey>('recruit')

  return (
    <div className="relative">
      {/* 顶部光晕 */}
      <div aria-hidden className="nebula-halo pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[860px] -translate-x-1/2" />

      {/* ── 企业身份卡 ── */}
      <section className="mx-auto max-w-site px-5 pt-14 md:px-12 md:pt-20">
        <motion.div
          initial={{ opacity: 0, y: 32 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="glass-panel relative overflow-hidden rounded-2xl p-7 md:p-9"
        >
          <HudCorner />
          <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-5">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-nebula-violet/40 bg-nebula-violet/10">
                {isAuthenticated && user?.avatar ? (
                  <img src={user.avatar} alt={user.name ?? '用户'} className="h-full w-full rounded-2xl object-cover" />
                ) : (
                  <Building2 className="h-7 w-7 text-nebula-violet" />
                )}
              </div>
              <div>
                <p className="hud-label text-pulse-cyan/80">ENTERPRISE CENTER</p>
                <h1 className="mt-1.5 font-display text-2xl font-bold tracking-[0.02em] text-ink-primary md:text-3xl">
                  企业中心
                </h1>
                {isLoading ? (
                  <p className="mt-1.5 flex items-center gap-2 text-sm text-ink-faint"><Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在校验登录态…</p>
                ) : isAuthenticated ? (
                  <p className="mt-1.5 text-sm text-ink-secondary">
                    <span className="text-ink-primary">{user?.name ?? '企业用户'}</span>
                    <span className="mx-2 text-ink-faint">·</span>
                    示范企业「华辰精工股份有限公司」工作区
                  </p>
                ) : (
                  <p className="mt-1.5 text-sm text-ink-secondary">登录后即可发布招募、上架 Agent 与技能，全部真实落库。</p>
                )}
              </div>
            </div>
            {!isLoading && !isAuthenticated && (
              <GlowButton to={LOGIN_PATH} className="shrink-0">
                <LogIn className="h-4 w-4" /> 登录企业账号
              </GlowButton>
            )}
            {isAuthenticated && (
              <div className="flex shrink-0 flex-col items-end gap-2">
                <div className="flex items-center gap-2 rounded-full border border-jade-green/40 bg-jade-green/10 px-4 py-2 text-xs text-jade-green">
                  <span className="h-1.5 w-1.5 rounded-full bg-jade-green" />
                  已登录 · 可发布
                </div>
                <Link
                  to="/admin/review"
                  className="inline-flex items-center gap-1 text-[11px] text-ink-faint transition-colors hover:text-pulse-cyan"
                >
                  <ShieldCheck className="h-3 w-3" /> 平台评审会 →
                </Link>
              </div>
            )}
          </div>
        </motion.div>
      </section>

      {/* ── 三大职能 ── */}
      <section className="mx-auto max-w-site px-5 pt-16 md:px-12 md:pt-24">
        <SectionHeader
          align="left"
          hud="PUBLISH & LIST"
          title="发布与上架"
          subtitle="招募数字劳动力，或把你的工艺经验上架为可雇佣的 Agent 与技能。"
        />
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'group relative rounded-2xl border p-5 text-left transition-all duration-300',
                tab === t.key
                  ? 'border-nebula-violet/60 bg-nebula-violet/10 shadow-[0_0_24px_rgba(124,92,255,0.25)]'
                  : 'glass-panel hover:-translate-y-1 hover:border-pulse-cyan/30',
              )}
            >
              <t.icon className={cn('h-5 w-5', tab === t.key ? 'text-nebula-violet' : 'text-ink-faint group-hover:text-pulse-cyan')} />
              <p className="mt-3 text-sm font-bold text-ink-primary">{t.label}</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-faint">{t.desc}</p>
              <p className="hud-label mt-3 text-[9px]">{t.hud}</p>
            </button>
          ))}
        </div>

        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
          className="glass-panel relative mt-6 rounded-2xl p-7 md:p-9"
        >
          <HudCorner />
          {tab === 'recruit' && <RecruitmentForm canSubmit={isAuthenticated} />}
          {tab === 'agent' && <AgentForm canSubmit={isAuthenticated} />}
          {tab === 'skill' && <SkillForm canSubmit={isAuthenticated} />}
        </motion.div>
      </section>

      {/* ── 我的发布 ── */}
      <section className="mx-auto max-w-site px-5 pt-16 md:px-12 md:pt-24">
        <SectionHeader align="left" hud="MY PUBLICATIONS" title="我的发布" subtitle="管理你的招募单并处理应征，跟踪上架 Agent 的审核状态与我的应征进度。" />
        <div className="mt-8 space-y-6">
          <MyPublications />
          <MyApplications />
        </div>
      </section>

      {/* ── 招募大厅 ── */}
      <section className="mx-auto max-w-site px-5 pb-24 pt-16 md:px-12 md:pb-32 md:pt-24">
        <SectionHeader
          align="left"
          hud="RECRUITMENT HALL"
          title="招募大厅"
          subtitle="全平台企业发布的 Agent 需求实时可见 —— 看懂同行在为什么样的数字劳动力付费。"
        />
        <div className="mt-8">
          <RecruitmentHall />
        </div>
        <div className="mt-12 flex flex-col items-center gap-4 rounded-2xl border border-line-subtle bg-deep/60 px-6 py-10 text-center">
          <Sparkles className="h-6 w-6 text-nebula-violet" />
          <p className="max-w-xl text-sm leading-relaxed text-ink-secondary">
            找不到匹配需求的现成工匠？发布招募单，让平台上的老师傅与企业带着方案来找你。
          </p>
          <div className="flex items-center gap-3">
            <Layers className="h-4 w-4 text-pulse-cyan" />
            <Link to="/market" className="text-sm text-pulse-cyan transition-colors hover:text-ink-primary">
              先去数字匠市逛逛 →
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}
