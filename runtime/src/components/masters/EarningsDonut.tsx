import { motion } from 'framer-motion'

const SEGMENTS = [
  { key: 'hire', label: '雇佣分成', color: '#7C5CFF', desc: '月薪 × 85%' },
  { key: 'skill', label: '技能分润', color: '#22D3EE', desc: '单次调用 × 80%' },
  { key: 'other', label: '其他流水', color: '#F5A524', desc: '激励 / 调价' },
] as const

/** 收益构成 donut（纯 SVG 自绘）：雇佣分成 vs 技能分润 */
export default function EarningsDonut({
  hire,
  skill,
  other,
}: {
  hire: number
  skill: number
  other: number
}) {
  const values = { hire, skill, other }
  const total = Math.max(1, hire + skill + other)

  const R = 52
  const C = 2 * Math.PI * R
  let offset = 0
  const arcs = SEGMENTS.filter((s) => values[s.key] > 0).map((s) => {
    const frac = values[s.key] / total
    const arc = { ...s, frac, dash: frac * C, offset }
    offset += frac * C
    return arc
  })

  return (
    <div className="flex items-center gap-6">
      {/* donut */}
      <div className="relative h-[140px] w-[140px] shrink-0">
        <svg viewBox="0 0 140 140" className="h-full w-full -rotate-90">
          <circle cx="70" cy="70" r={R} fill="none" stroke="rgba(124,140,222,0.12)" strokeWidth="14" />
          {arcs.map((a, i) => (
            <motion.circle
              key={a.key}
              cx="70"
              cy="70"
              r={R}
              fill="none"
              stroke={a.color}
              strokeWidth="14"
              strokeLinecap="butt"
              strokeDasharray={`${a.dash} ${C - a.dash}`}
              initial={{ strokeDashoffset: -a.offset + C / 4, opacity: 0 }}
              whileInView={{ strokeDashoffset: -a.offset, opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.9, delay: 0.15 * i, ease: [0.16, 1, 0.3, 1] }}
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">Total</span>
          <span className="font-grotesk text-lg font-bold text-ink-primary">{total.toLocaleString()}</span>
          <span className="font-mono text-[9px] text-ink-faint">Token</span>
        </div>
      </div>

      {/* legend */}
      <ul className="min-w-0 flex-1 space-y-3">
        {SEGMENTS.map((s) => {
          const v = values[s.key]
          const pct = Math.round((v / total) * 100)
          return (
            <li key={s.key} className="flex items-center gap-3">
              <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: s.color }} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-[13px] text-ink-secondary">{s.label}</span>
                  <span className="font-grotesk text-sm font-bold text-ink-primary">
                    {v.toLocaleString()}
                    <span className="ml-1.5 font-mono text-[10px] font-normal text-ink-faint">{pct}%</span>
                  </span>
                </span>
                <span className="mt-1 block h-1 overflow-hidden rounded-full bg-void/80">
                  <motion.span
                    initial={{ width: 0 }}
                    whileInView={{ width: `${pct}%` }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                    className="block h-full rounded-full"
                    style={{ background: s.color }}
                  />
                </span>
              </span>
            </li>
          )
        })}
        <li className="pt-1 font-mono text-[10px] text-ink-faint">平台抽成：雇佣 15% · 技能 20%，其余归老师傅</li>
      </ul>
    </div>
  )
}
