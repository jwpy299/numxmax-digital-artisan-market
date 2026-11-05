/**
 * 工作台（/wb/*）共享小组件：信息密度优先的"干活工具"风格，
 * 沿用全局设计系统（玻璃拟态 / HUD 角标 / 深空配色）。
 */
import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import HudCorner from '@/components/HudCorner'
import { cn } from '@/lib/utils'

// ─── 面板 ────────────────────────────────────────────────────────────────────

export function WbPanel({
  title,
  hud,
  actions,
  children,
  className,
}: {
  title?: string
  hud?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('glass-panel relative rounded-xl p-5', className)}>
      <HudCorner />
      {(title || actions) && (
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            {hud && <p className="hud-label">{hud}</p>}
            {title && <h3 className="mt-1 text-base font-bold text-ink-primary">{title}</h3>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  )
}

// ─── 页头 ────────────────────────────────────────────────────────────────────

export function WbPageHeader({ hud, title, desc }: { hud: string; title: string; desc?: string }) {
  return (
    <div className="mb-6">
      <p className="hud-label text-pulse-cyan/80">{hud}</p>
      <h1 className="mt-2 font-display text-2xl font-bold tracking-[0.02em] text-ink-primary md:text-3xl">
        {title}
      </h1>
      {desc && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-secondary">{desc}</p>}
    </div>
  )
}

// ─── 状态徽章 ────────────────────────────────────────────────────────────────

const BADGE_STYLES: Record<string, string> = {
  pending: 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber',
  listed: 'border-jade-green/40 bg-jade-green/10 text-jade-green',
  active: 'border-jade-green/40 bg-jade-green/10 text-jade-green',
  published: 'border-jade-green/40 bg-jade-green/10 text-jade-green',
  rejected: 'border-ember-red/40 bg-ember-red/10 text-ember-red',
  revoked: 'border-ember-red/40 bg-ember-red/10 text-ember-red',
  expired: 'border-ink-faint/40 bg-ink-faint/10 text-ink-secondary',
  learning: 'border-pulse-cyan/40 bg-pulse-cyan/10 text-pulse-cyan',
  pending_confirm: 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber',
  admin: 'border-nebula-violet/50 bg-nebula-violet/10 text-nebula-violet',
  owner: 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber',
  member: 'border-line-subtle bg-panel/60 text-ink-secondary',
  dept_head: 'border-pulse-cyan/40 bg-pulse-cyan/10 text-pulse-cyan',
  skill: 'border-pulse-cyan/40 bg-pulse-cyan/10 text-pulse-cyan',
  agent: 'border-nebula-violet/50 bg-nebula-violet/10 text-nebula-violet',
  both: 'border-nebula-magenta/50 bg-nebula-magenta/10 text-nebula-magenta',
}

const STATUS_LABELS: Record<string, string> = {
  pending: '待审核',
  listed: '已上架',
  active: '生效中',
  published: '已发布',
  rejected: '已驳回',
  revoked: '已吊销',
  expired: '已过期',
  learning: '学习中',
  pending_confirm: '待确认',
  admin: '老板',
  owner: '企业负责人',
  member: '成员',
  dept_head: '部门负责人',
  // M16b：组织三级角色徽标（normalizeRole 后的新值）
  manager: '部门负责人',
  staff: '员工',
  skill: '技能',
  agent: '智能体',
  both: '技能+智能体',
}

export function statusLabel(s: string): string {
  return STATUS_LABELS[s] ?? s
}

export function WbBadge({ status, label }: { status: string; label?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[11px]',
        BADGE_STYLES[status] ?? 'border-line-subtle text-ink-secondary',
      )}
    >
      {label ?? statusLabel(status)}
    </span>
  )
}

// ─── 表单控件 ────────────────────────────────────────────────────────────────

export const wbInputCls =
  'w-full rounded-[10px] border border-line-subtle bg-void/60 px-3.5 py-2 text-sm text-ink-primary placeholder:text-ink-faint outline-none transition-colors duration-300 focus:border-pulse-cyan/60'
export const wbLabelCls = 'mb-1.5 block text-xs font-medium text-ink-secondary'

export function WbField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div>
      <label className={wbLabelCls}>{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-ink-faint">{hint}</p>}
    </div>
  )
}

export function WbButton({
  children,
  onClick,
  variant = 'primary',
  disabled,
  loading,
  className,
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
  loading?: boolean
  className?: string
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      onClick={onClick}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-[10px] px-4 py-2 text-sm font-medium transition-colors duration-300 disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-amber-gradient text-[#1A1206] hover:shadow-[0_0_20px_rgba(245,165,36,0.35)]',
        variant === 'secondary' &&
          'border border-line-subtle text-ink-primary hover:border-pulse-cyan/50 hover:bg-pulse-cyan/[0.08]',
        variant === 'danger' && 'border border-ember-red/40 text-ember-red hover:bg-ember-red/[0.08]',
        className,
      )}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  )
}

// ─── 反馈 ────────────────────────────────────────────────────────────────────

export function WbError({ message, className }: { message: string | null; className?: string }) {
  if (!message) return null
  return (
    <p
      className={cn(
        'rounded-xl border border-ember-red/30 bg-ember-red/[0.06] px-4 py-3 text-xs leading-relaxed text-ember-red',
        className,
      )}
    >
      {message}
    </p>
  )
}

export function WbNotice({ message, className }: { message: string | null; className?: string }) {
  if (!message) return null
  return (
    <p
      className={cn(
        'rounded-xl border border-jade-green/30 bg-jade-green/[0.06] px-4 py-3 text-xs leading-relaxed text-jade-green',
        className,
      )}
    >
      {message}
    </p>
  )
}

export function WbLoading({ text = '数据加载中…' }: { text?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-ink-secondary">
      <Loader2 className="h-4 w-4 animate-spin text-pulse-cyan" />
      {text}
    </div>
  )
}

export function WbEmpty({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line-subtle px-4 py-8 text-center">
      <p className="text-sm text-ink-secondary">{text}</p>
      {hint && <p className="mt-1 text-xs text-ink-faint">{hint}</p>}
    </div>
  )
}

// ─── 统计卡 ──────────────────────────────────────────────────────────────────

export function WbStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: ReactNode
  sub?: string
  tone?: 'cyan' | 'amber' | 'green' | 'red'
}) {
  const toneCls =
    tone === 'amber'
      ? 'text-amber-gradient'
      : tone === 'green'
        ? 'text-jade-green'
        : tone === 'red'
          ? 'text-ember-red'
          : 'text-pulse-cyan'
  return (
    <div className="glass-panel relative rounded-xl px-4 py-4">
      <HudCorner />
      <p className="hud-label">{label}</p>
      <p className={cn('mt-2 font-grotesk text-3xl font-bold', toneCls)}>{value}</p>
      {sub && <p className="mt-1 text-xs text-ink-faint">{sub}</p>}
    </div>
  )
}
