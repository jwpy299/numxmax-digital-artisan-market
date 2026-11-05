import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { keepPreviousData } from '@tanstack/react-query'
import { Activity } from 'lucide-react'
import { trpc } from '@/providers/trpc'
import { Slider } from '@/components/ui/slider'
import HudCorner from '@/components/HudCorner'
import PriceTicker from '@/components/PriceTicker'
import { simulatePriceLocal } from './simulatorMath'
import type { SimulatorInput } from './simulatorMath'
import { cn } from '@/lib/utils'

interface SliderSpec {
  key: keyof SimulatorInput
  label: string
  min: number
  max: number
  step: number
  format: (v: number) => string
  hint?: [string, string]
}

const SLIDERS: SliderSpec[] = [
  { key: 'skillCount', label: '技能数量', min: 5, max: 20, step: 1, format: (v) => `${v} 项` },
  { key: 'complexity', label: '技能复杂度', min: 1, max: 5, step: 1, format: (v) => `${v} 档` },
  { key: 'reputation', label: '老师傅声望', min: 50, max: 100, step: 1, format: (v) => `${v} 分` },
  { key: 'demandRatio', label: '市场供需比', min: 0.5, max: 1.8, step: 0.05, format: (v) => v.toFixed(2), hint: ['供过于求', '供不应求'] },
  { key: 'rating', label: '雇主评分', min: 3.0, max: 5.0, step: 0.1, format: (v) => `${v.toFixed(1)} ★` },
  { key: 'tasksCompleted', label: '累计经验', min: 0, max: 500, step: 1, format: (v) => `${v} 次任务` },
]

const SEGMENT_STYLE: Record<string, { color: string; label: string }> = {
  base: { color: '#55638A', label: '基准价' },
  skill: { color: '#38BDF8', label: '技能加成' },
  reputation: { color: '#B44CFF', label: '声望加成' },
  demand: { color: '#22D3EE', label: '供需浮动' },
  rating: { color: '#34D399', label: '评分溢价' },
  experience: { color: '#7C5CFF', label: '经验增值' },
}

export default function PricingSimulator() {
  const [input, setInput] = useState<SimulatorInput>({
    skillCount: 12,
    complexity: 3,
    reputation: 92,
    demandRatio: 1.3,
    rating: 4.9,
    tasksCompleted: 327,
  })

  // 真实定价引擎：pricing.simulate tRPC 接口；接口不可用时降级为前端本地计算（同构算法）
  const query = trpc.pricing.simulate.useQuery(input, {
    placeholderData: keepPreviousData,
    retry: 1,
    staleTime: 10_000,
  })
  const local = useMemo(() => simulatePriceLocal(input), [input])
  const result = query.data ?? local
  const isFallback = query.isError

  const totalAbs = result.breakdown.reduce((a, b) => a + Math.abs(b.amount), 0)

  // 12 个月轨迹 + ±20%/月封顶线坐标
  const chart = useMemo(() => {
    const pts = result.trajectory
    const caps = pts.map((p) => ({ up: result.suggestedPrice * Math.pow(1.2, p.month), down: result.suggestedPrice * Math.pow(0.8, p.month) }))
    const max = Math.max(...caps.map((c) => c.up), ...pts.map((p) => p.price))
    const min = Math.min(...caps.map((c) => c.down), ...pts.map((p) => p.price))
    const W = 560
    const H = 200
    const padX = 26
    const padTop = 14
    const padBottom = 26
    const x = (i: number) => padX + (i / (pts.length - 1)) * (W - padX * 2)
    const y = (v: number) => padTop + (1 - (v - min) / (max - min || 1)) * (H - padTop - padBottom)
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ')
    const capUp = caps.map((c, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(c.up).toFixed(1)}`).join(' ')
    const capDown = caps.map((c, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(c.down).toFixed(1)}`).join(' ')
    return { W, H, x, y, line, capUp, capDown, pts }
  }, [result])

  return (
    <motion.div
      initial={{ opacity: 0, y: 60 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-25% 0px' }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
      className="glass-panel relative mx-auto w-full max-w-[1100px] rounded-2xl p-6 md:p-9"
    >
      <HudCorner />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="hud-label text-pulse-cyan/80">PRICING SIMULATOR</p>
          <h3 className="mt-2 font-display text-xl font-bold text-ink-primary md:text-2xl">交互定价模拟器</h3>
        </div>
        <span
          className={cn(
            'inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em]',
            isFallback ? 'border-forge-amber/40 text-forge-amber' : 'border-pulse-cyan/40 text-pulse-cyan',
          )}
        >
          <span className={cn('h-1.5 w-1.5 rounded-full', isFallback ? 'bg-forge-amber' : 'bg-pulse-cyan pulse-halo')} />
          {isFallback ? 'OFFLINE · 本地估算' : query.isLoading ? 'CONNECTING…' : 'LIVE · 定价引擎在线'}
        </span>
      </div>

      <div className="grid gap-8 lg:grid-cols-[45%_55%] lg:gap-10">
        {/* 左 · 控制台 */}
        <div className="space-y-6">
          {SLIDERS.map((s) => (
            <div key={s.key}>
              <div className="flex items-baseline justify-between">
                <label className="text-[13px] text-ink-secondary">{s.label}</label>
                <span className="font-mono text-sm font-medium tabular-nums text-pulse-cyan">{s.format(input[s.key])}</span>
              </div>
              <Slider
                className="mt-3"
                min={s.min}
                max={s.max}
                step={s.step}
                value={[input[s.key]]}
                onValueChange={([v]) => setInput((prev) => ({ ...prev, [s.key]: v }))}
              />
              {s.hint && (
                <div className="mt-1.5 flex justify-between text-[10px] text-ink-faint">
                  <span>{s.hint[0]}</span>
                  <span>{s.hint[1]}</span>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* 右 · 结果可视化 */}
        <div className="flex flex-col">
          <div className="flex items-baseline gap-3">
            <span className="text-[13px] text-ink-secondary">预估月薪</span>
            <PriceTicker value={result.suggestedPrice} prefix="" suffix=" Token / 月" className="font-grotesk text-4xl font-bold md:text-[56px]" />
          </div>

          {/* 价格构成瀑布条 */}
          <div className="mt-5">
            <div className="flex h-5 w-full overflow-hidden rounded-full bg-muted/40">
              {result.breakdown.map((b) => (
                <motion.div
                  key={b.key}
                  className="h-full"
                  style={{ backgroundColor: b.amount < 0 ? '#F43F5E' : SEGMENT_STYLE[b.key].color }}
                  initial={false}
                  animate={{ width: `${(Math.abs(b.amount) / (totalAbs || 1)) * 100}%` }}
                  transition={{ type: 'spring', stiffness: 180, damping: 22 }}
                  title={`${b.label} ${b.amount >= 0 ? '+' : ''}${b.amount}`}
                />
              ))}
            </div>
            <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
              {result.breakdown.map((b) => (
                <span key={b.key} className="inline-flex items-center gap-1.5 font-mono text-[10px] text-ink-secondary">
                  <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: b.amount < 0 ? '#F43F5E' : SEGMENT_STYLE[b.key].color }} />
                  {b.label}
                  <span className={cn('tabular-nums', b.amount < 0 ? 'text-ember-red' : 'text-ink-primary')}>
                    {b.amount >= 0 ? '+' : ''}
                    {b.amount}
                  </span>
                </span>
              ))}
            </div>
          </div>

          {/* 12 个月价格走势预测 */}
          <div className="mt-5 flex-1">
            <p className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
              <Activity className="h-3 w-3 text-pulse-cyan" />
              12 个月价格走势预测 · ±20%/月封顶
            </p>
            <svg viewBox={`0 0 ${chart.W} ${chart.H}`} className="w-full" fill="none" aria-hidden>
              <defs>
                <linearGradient id="simTrajFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#F5A524" stopOpacity="0.22" />
                  <stop offset="100%" stopColor="#F5A524" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={`${chart.line} L${chart.x(chart.pts.length - 1)},${chart.H - 26} L${chart.x(0)},${chart.H - 26} Z`} fill="url(#simTrajFill)" stroke="none" />
              <path d={chart.capUp} stroke="#F43F5E" strokeWidth="1" strokeDasharray="4 5" opacity="0.6" />
              <path d={chart.capDown} stroke="#7C8CDE" strokeWidth="1" strokeDasharray="4 5" opacity="0.5" />
              <path d={chart.line} stroke="#F5A524" strokeWidth="2" strokeLinejoin="round" />
              {chart.pts.map((p, i) => (
                <circle key={p.month} cx={chart.x(i)} cy={chart.y(p.price)} r="2.4" fill="#F5A524" stroke="#05070F" strokeWidth="1" />
              ))}
              {chart.pts.map((p, i) => (
                <text key={p.month} x={chart.x(i)} y={chart.H - 10} textAnchor="middle" fill="#55638A" fontSize="9" fontFamily="JetBrains Mono, monospace">
                  M{p.month}
                </text>
              ))}
              <text x={chart.W - 4} y={chart.y(chart.pts[chart.pts.length - 1].price) - 8} textAnchor="end" fill="#F5A524" fontSize="10" fontWeight="700" fontFamily="Space Grotesk, sans-serif">
                {chart.pts[chart.pts.length - 1].price.toLocaleString('zh-CN')}
              </text>
            </svg>
          </div>

          {/* 规则说明 */}
          <ul className="mt-4 space-y-1 border-t border-line-subtle pt-3">
            {result.rules.map((r) => (
              <li key={r} className="font-mono text-[10px] leading-relaxed text-ink-faint">
                * {r}
              </li>
            ))}
            <li className="font-mono text-[10px] leading-relaxed text-ink-faint">
              * 每月调价幅度上限 +20% / 下限 -20% · 连续 3 个月评分 &lt; 3 星自动下架整改
            </li>
          </ul>
        </div>
      </div>
    </motion.div>
  )
}
