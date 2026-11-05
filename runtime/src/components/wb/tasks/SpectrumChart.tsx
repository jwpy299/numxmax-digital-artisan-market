import { memo } from 'react'
import { motion } from 'framer-motion'

const W = 560
const H = 220
const BASE_Y = 168

/** 确定性伪随机噪声（SSR 稳定） */
function noise(x: number, seed: number): number {
  return (
    Math.sin(x * 0.11 + seed) * 6 +
    Math.sin(x * 0.031 + seed * 2.7) * 10 +
    Math.sin(x * 0.53 + seed * 1.3) * 2.5
  )
}

function buildPath(seed: number, peak?: { x: number; amp: number; width: number }): string {
  const pts: string[] = []
  for (let x = 0; x <= W; x += 8) {
    let y = BASE_Y - Math.abs(noise(x, seed))
    if (peak) {
      const d = (x - peak.x) / peak.width
      y -= peak.amp * Math.exp(-d * d)
    }
    pts.push(`${x === 0 ? 'M' : 'L'}${x},${y.toFixed(1)}`)
  }
  return pts.join(' ')
}

const BASELINE = buildPath(1.7)
const CURRENT = buildPath(3.1, { x: 404, amp: 96, width: 16 })
const PEAK = { x: 404, y: BASE_Y - 96 - Math.abs(noise(404, 3.1)) }

interface SpectrumChartProps {
  /** 0..1 描线进度（随执行步骤推进） */
  progress: number
  /** 是否显示异常峰（验证阶段后） */
  showAnomaly: boolean
  active: boolean
}

/** 振动频谱图：基线 cyan + 当前频谱 violet + 异常峰 amber，全部代码自绘 */
function SpectrumChart({ progress, showAnomaly, active }: SpectrumChartProps) {
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="振动频谱图">
        {/* 网格 */}
        {Array.from({ length: 5 }).map((_, i) => (
          <line key={`h${i}`} x1={0} x2={W} y1={36 + i * 40} y2={36 + i * 40} stroke="rgba(124,140,222,0.10)" strokeDasharray="3 6" />
        ))}
        {Array.from({ length: 8 }).map((_, i) => (
          <line key={`v${i}`} y1={24} y2={H - 24} x1={i * 80} x2={i * 80} stroke="rgba(124,140,222,0.07)" />
        ))}
        {/* 轴标签 */}
        <text x={4} y={20} fill="#55638A" fontSize={9} fontFamily="JetBrains Mono, monospace">AMP mm/s</text>
        <text x={W - 92} y={H - 8} fill="#55638A" fontSize={9} fontFamily="JetBrains Mono, monospace">FREQ Hz →</text>
        <text x={PEAK.x - 14} y={H - 8} fill="#F5A524" fontSize={9} fontFamily="JetBrains Mono, monospace">162</text>

        {/* 正常基线 */}
        <path d={BASELINE} fill="none" stroke="#22D3EE" strokeOpacity={0.55} strokeWidth={1.2} />

        {/* 当前频谱（随进度描画） */}
        {active && (
          <motion.path
            d={CURRENT}
            fill="none"
            stroke="#7C5CFF"
            strokeWidth={1.8}
            initial={{ pathLength: 0 }}
            animate={{ pathLength: Math.max(0.04, progress) }}
            transition={{ duration: 0.8, ease: 'easeInOut' }}
          />
        )}

        {/* 异常峰 amber 闪烁 */}
        {showAnomaly && (
          <motion.circle
            cx={PEAK.x}
            cy={PEAK.y}
            r={5}
            fill="#F5A524"
            initial={{ opacity: 0, scale: 0 }}
            animate={{ opacity: [0, 1, 0.3, 1, 0.3, 1, 1], scale: 1 }}
            transition={{ duration: 1.8, times: [0, 0.15, 0.3, 0.45, 0.6, 0.75, 1] }}
            style={{ transformOrigin: `${PEAK.x}px ${PEAK.y}px`, filter: 'drop-shadow(0 0 6px rgba(245,165,36,0.8))' }}
          />
        )}
        {showAnomaly && (
          <motion.text
            x={PEAK.x + 10}
            y={PEAK.y + 4}
            fill="#F5A524"
            fontSize={10}
            fontFamily="JetBrains Mono, monospace"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.2 }}
          >
            BPFI +34%
          </motion.text>
        )}
      </svg>

      {/* 图例 */}
      <div className="mt-2 flex items-center gap-4 font-mono text-[10px] text-ink-faint">
        <span className="flex items-center gap-1.5">
          <span className="h-[2px] w-4 bg-pulse-cyan/60" /> 正常基线
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-[2px] w-4 bg-nebula-violet" /> 当前频谱
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-forge-amber" /> 异常峰
        </span>
      </div>
    </div>
  )
}

export default memo(SpectrumChart)
