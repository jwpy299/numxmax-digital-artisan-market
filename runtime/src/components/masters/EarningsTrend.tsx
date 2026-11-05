import { useId } from 'react'
import { motion } from 'framer-motion'

/** 近 30 天收益趋势迷你曲线（纯 SVG 自绘，描线动画 + 渐变填充） */
export default function EarningsTrend({ points }: { points: { date: string; amount: number }[] }) {
  const gid = useId().replace(/:/g, '')
  const W = 560
  const H = 120
  const PAD = 6

  const max = Math.max(1, ...points.map((p) => p.amount))
  const step = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0
  const xy = points.map((p, i) => [PAD + i * step, H - PAD - (p.amount / max) * (H - PAD * 2)] as const)
  const line = xy.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} L${(PAD + (points.length - 1) * step).toFixed(1)},${H} L${PAD},${H} Z`

  const last7 = points.slice(-7).reduce((a, p) => a + p.amount, 0)

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">30D EARNINGS TREND</p>
        <p className="font-mono text-xs text-pulse-cyan">
          近 7 日 +{last7.toLocaleString()} <span className="text-ink-faint">Token</span>
        </p>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-28 w-full" preserveAspectRatio="none" role="img" aria-label="近30天收益趋势">
        <defs>
          <linearGradient id={`trend-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22D3EE" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#22D3EE" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* grid lines */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={PAD}
            x2={W - PAD}
            y1={H * f}
            y2={H * f}
            stroke="rgba(124,140,222,0.12)"
            strokeDasharray="3 5"
          />
        ))}
        <path d={area} fill={`url(#trend-${gid})`} />
        <motion.path
          d={line}
          fill="none"
          stroke="#22D3EE"
          strokeWidth="2"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          whileInView={{ pathLength: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 1.4, ease: 'easeOut' }}
        />
        {/* 末端点 */}
        {xy.length > 0 && (
          <circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r="3" fill="#22D3EE">
            <animate attributeName="r" values="2.5;4;2.5" dur="2s" repeatCount="indefinite" />
          </circle>
        )}
      </svg>
      <div className="mt-1.5 flex justify-between font-mono text-[9px] text-ink-faint">
        <span>{points[0]?.date.slice(5) ?? ''}</span>
        <span>峰值 {max.toLocaleString()} / 日</span>
        <span>{points[points.length - 1]?.date.slice(5) ?? ''}</span>
      </div>
    </div>
  )
}
