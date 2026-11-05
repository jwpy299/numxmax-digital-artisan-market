/**
 * BaseKitChips —— 标配技能徽章行（iter99）。
 * 数据源：skills.baseSkills（免登录公共接口，st_base_skills 真实行）。
 * 用途：熊猫军团成员卡 / 数字员工卡展示「出生自带」的办公四件套徽章。
 * 失败静默（不阻断卡片渲染）。
 */
import { FileText, FileSpreadsheet, Presentation, CalendarClock } from 'lucide-react'
import { useWbSession, useWbQuery } from '@/lib/wbSession'
import { cn } from '@/lib/utils'

type BaseSkill = { skillKey: string; title: string; badge: string; intro: string | null }

const ICONS: Record<string, typeof FileText> = {
  office_doc: FileText,
  office_sheet: FileSpreadsheet,
  office_ppt: Presentation,
  daily_report: CalendarClock,
}

export default function BaseKitChips({ className }: { className?: string }) {
  const { session } = useWbSession()
  const { data } = useWbQuery<{ items: BaseSkill[] }>(
    'skills.baseSkills',
    session,
    {},
    { withToken: false },
  )
  const items = data?.items ?? []
  if (items.length === 0) return null
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {items.map((s) => {
        const Icon = ICONS[s.skillKey] ?? FileText
        return (
          <span
            key={s.skillKey}
            title={s.intro ?? s.title}
            className="inline-flex items-center gap-1 rounded-full border border-forge-amber/30 bg-forge-amber/10 px-2 py-0.5 text-[10px] font-medium text-forge-amber"
          >
            <Icon className="h-3 w-3" />
            {s.title}·{s.badge}
          </span>
        )
      })}
    </div>
  )
}
