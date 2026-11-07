/**
 * BaseSkillBadges（iter97 基础教育包）——标配办公技能徽章条。
 * 数据：skills.baseSkills（st_base_skills，全员出生自带，真实执行器）。
 * 拉取失败静默不渲染（不阻塞详情页）。
 */
import { useEffect, useState } from 'react'
import { FileText, Table2, Presentation, CalendarCheck } from 'lucide-react'
import { cn } from '@/lib/utils'

interface BaseSkill {
  skillKey: string
  title: string
  intro?: string | null
}

const ICONS: Record<string, typeof FileText> = {
  office_doc: FileText,
  office_sheet: Table2,
  office_ppt: Presentation,
  daily_report: CalendarCheck,
}

export default function BaseSkillBadges({ className }: { className?: string }) {
  const [items, setItems] = useState<BaseSkill[]>([])
  useEffect(() => {
    let alive = true
    // v2026-09-05 修复：trpc React 代理没有裸 .query()（vendor 运行期 t[o] is not a function 崩整页）
    // ——裸拉走 HTTP 端点（与 wb 同源契约），失败静默不渲染
    fetch('https://wb.lingshu-nebulaai.com/api/trpc/skills.baseSkills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: {} }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const list = j?.result?.data?.json?.items as BaseSkill[] | undefined
        if (alive && Array.isArray(list)) setItems(list)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  if (items.length === 0) return null
  return (
    <div className={cn('flex flex-wrap items-center gap-2.5', className)}>
      <span className="font-mono text-[10px] tracking-widest text-ink-faint">BASE KIT</span>
      {items.map((s) => {
        const Icon = ICONS[s.skillKey] ?? FileText
        return (
          <span
            key={s.skillKey}
            title={s.intro ?? s.title}
            className="inline-flex items-center gap-1.5 rounded-full border border-pulse-cyan/40 bg-pulse-cyan/10 px-3 py-1 text-xs text-pulse-cyan"
          >
            <Icon className="h-3.5 w-3.5" />
            {s.title}
            <span className="rounded bg-pulse-cyan/20 px-1 text-[10px]">标配</span>
          </span>
        )
      })}
    </div>
  )
}
