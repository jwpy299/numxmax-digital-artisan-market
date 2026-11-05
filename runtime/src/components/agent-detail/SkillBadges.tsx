/**
 * SkillBadges —— 匠市技能徽章（迭代 30）。
 * 调用 skills.byAgentPublic（免登录 query，仅返回 name/layer/description），
 * 展示前 4 个技能名小徽章，超出折叠为「+N」；请求失败/无数据时静默不渲染，
 * 绝不影响匠市现有展示。
 */
import { Wrench } from 'lucide-react'
import { useWbQuery } from '@/lib/wbSession'
import { cn } from '@/lib/utils'

interface PublicSkill {
  name: string
  layer?: string | null
  description?: string | null
}

const LAYER_STYLE: Record<string, string> = {
  general: 'border-pulse-cyan/40 bg-pulse-cyan/10 text-pulse-cyan',
  professional: 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber',
  industry: 'border-nebula-violet/50 bg-nebula-violet/10 text-nebula-violet',
}

export default function SkillBadges({ agentId }: { agentId: number | null | undefined }) {
  const { data } = useWbQuery<PublicSkill[] | { rows: PublicSkill[] }>(
    'skills.byAgentPublic',
    null,
    agentId != null ? { agentId } : {},
    { withToken: false, enabled: agentId != null },
  )
  const skills: PublicSkill[] = Array.isArray(data) ? data : (data?.rows ?? [])
  if (skills.length === 0) return null

  const shown = skills.slice(0, 4)
  const rest = skills.length - shown.length
  return (
    <div className="mt-4">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-ink-faint">
        <Wrench className="h-3 w-3 text-pulse-cyan" />
        已挂载技能
      </p>
      <div className="flex flex-wrap gap-2">
        {shown.map((s) => (
          <span
            key={s.name}
            title={s.description ?? s.name}
            className={cn(
              'inline-flex items-center rounded-full border px-3 py-1 text-xs',
              LAYER_STYLE[s.layer ?? ''] ?? 'border-line-subtle text-ink-secondary',
            )}
          >
            {s.name}
          </span>
        ))}
        {rest > 0 && (
          <span className="inline-flex items-center rounded-full border border-line-subtle bg-panel/60 px-3 py-1 font-mono text-xs text-ink-faint">
            +{rest}
          </span>
        )}
      </div>
    </div>
  )
}
