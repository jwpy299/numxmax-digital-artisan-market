import { AlertTriangle, BadgeCheck, Hourglass, ShieldOff, XCircle } from 'lucide-react'
import type { RecruitLoopOutputs } from '@/lib/trpcRecruitLoop'

type Stats = RecruitLoopOutputs['review']['stats']

const ITEMS = [
  { key: 'pending', label: '待审核', hud: 'PENDING', icon: Hourglass, cls: 'text-forge-amber' },
  { key: 'active', label: '已上架', hud: 'ACTIVE', icon: BadgeCheck, cls: 'text-jade-green' },
  { key: 'rejected', label: '已驳回', hud: 'REJECTED', icon: XCircle, cls: 'text-ink-faint' },
  { key: 'suspended', label: '已下架', hud: 'SUSPENDED', icon: ShieldOff, cls: 'text-ember-red' },
  { key: 'risk', label: '下架风险', hud: 'RISK', icon: AlertTriangle, cls: 'text-ember-red' },
] as const

/** 审核管理台顶部仪表条 */
export default function ReviewStatsBar({ stats }: { stats: Stats }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      {ITEMS.map((it) => (
        <div key={it.key} className="glass-panel relative rounded-2xl p-5">
          <div className="flex items-center justify-between">
            <p className="hud-label text-[9px]">{it.hud}</p>
            <it.icon className={`h-4 w-4 ${it.cls}`} />
          </div>
          <p className="mt-3 font-mono text-3xl font-bold tracking-tight text-ink-primary">
            {stats[it.key]}
          </p>
          <p className="mt-1 text-xs text-ink-faint">{it.label}</p>
        </div>
      ))}
    </div>
  )
}
