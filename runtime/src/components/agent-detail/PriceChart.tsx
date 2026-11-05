import { useId } from 'react'
import { motion } from 'framer-motion'
import { formatToken } from '@/components/market/types'

interface PriceChartProps {
  points: { date: string; price: number }[]
  width?: number
  height?: number
}

/** Self-drawn SVG sparkline: cyan stroke + violet gradient area */
export default function PriceChart({ points, width = 320, height = 96 }: PriceChartProps) {
  const gradientId = useId()
  if (points.length < 2) {
    return <div className="flex h-24 items-center justify-center font-mono text-xs text-ink-faint">价格数据加载中…</div>
  }

  const prices = points.map((p) => p.price)
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const span = max - min || 1
  const pad = 6
  const stepX = (width - pad * 2) / (points.length - 1)
  const xy = points.map((p, i) => ({
    x: pad + i * stepX,
    y: pad + (1 - (p.price - min) / span) * (height - pad * 2),
  }))
  const line = xy.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const area = `${line} L${xy[xy.length - 1]!.x.toFixed(1)},${height} L${xy[0]!.x.toFixed(1)},${height} Z`
  const last = xy[xy.length - 1]!

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7C5CFF" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#7C5CFF" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gradientId})`} />
        <motion.path
          d={line}
          fill="none"
          stroke="#22D3EE"
          strokeWidth="1.6"
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          whileInView={{ pathLength: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 1.4, ease: 'easeOut' }}
        />
        <circle cx={last.x} cy={last.y} r="3" fill="#22D3EE" />
        <circle cx={last.x} cy={last.y} r="6" fill="#22D3EE" opacity="0.25" />
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-ink-faint">
        <span>{points[0]!.date.slice(5)}</span>
        <span>
          {formatToken(min)} — {formatToken(max)}
        </span>
        <span>{points[points.length - 1]!.date.slice(5)}</span>
      </div>
    </div>
  )
}
