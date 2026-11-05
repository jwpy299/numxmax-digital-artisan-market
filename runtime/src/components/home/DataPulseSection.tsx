import { useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { motion, useInView } from 'framer-motion'
import HudCorner from '@/components/HudCorner'
import { useCountUp } from '@/hooks/useCountUp'

/** deterministic pseudo-random walk */
function genSeries(n: number, seed: number) {
  let v = 50
  const pts: number[] = []
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 9301 + 49297) % 233280
    v = Math.max(15, Math.min(95, v + ((s / 233280) - 0.42) * 18))
    pts.push(v)
  }
  return pts
}

function AreaChart({ started }: { started: boolean }) {
  const { line, area } = useMemo(() => {
    const pts = genSeries(30, 7)
    const w = 240
    const h = 64
    const step = w / (pts.length - 1)
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - (p / 100) * h).toFixed(1)}`).join(' ')
    const area = `${line} L${w},${h} L0,${h} Z`
    return { line, area }
  }, [])
  return (
    <svg viewBox="0 0 240 64" className="mt-4 h-16 w-full" aria-hidden>
      <defs>
        <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7C5CFF" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#7C5CFF" stopOpacity="0" />
        </linearGradient>
      </defs>
      <motion.path
        d={area}
        fill="url(#areaFill)"
        initial={{ opacity: 0 }}
        animate={started ? { opacity: 1 } : {}}
        transition={{ duration: 1.2, delay: 0.5 }}
      />
      <motion.path
        d={line}
        fill="none"
        stroke="#7C5CFF"
        strokeWidth="2"
        initial={{ pathLength: 0 }}
        animate={started ? { pathLength: 1 } : {}}
        transition={{ duration: 1.2, delay: 0.3, ease: 'easeOut' }}
      />
    </svg>
  )
}

function RingProgress({ started, pct }: { started: boolean; pct: number }) {
  const r = 26
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 64 64" className="h-16 w-16" aria-hidden>
      <circle cx="32" cy="32" r={r} fill="none" stroke="#1B2647" strokeWidth="5" />
      <motion.circle
        cx="32"
        cy="32"
        r={r}
        fill="none"
        stroke="#22D3EE"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={c}
        initial={{ strokeDashoffset: c }}
        animate={started ? { strokeDashoffset: c * (1 - pct) } : {}}
        transition={{ duration: 1.4, delay: 0.3, ease: 'easeOut' }}
        transform="rotate(-90 32 32)"
      />
    </svg>
  )
}

function MiniBars({ started }: { started: boolean }) {
  const bars = useMemo(() => genSeries(8, 21).map((v) => 20 + v * 0.6), [])
  return (
    <div className="mt-4 flex h-16 items-end gap-1.5" aria-hidden>
      {bars.map((h, i) => (
        <motion.span
          key={i}
          className="w-full rounded-sm bg-gradient-to-t from-nebula-violet/60 to-pulse-cyan/70"
          initial={{ height: 0 }}
          animate={started ? { height: `${h}%` } : {}}
          transition={{ duration: 0.7, delay: 0.3 + i * 0.06, ease: [0.16, 1, 0.3, 1] }}
        />
      ))}
    </div>
  )
}

function Gauge({ started, pct }: { started: boolean; pct: number }) {
  // semicircle gauge: needle sweeps from -90deg to -90 + pct*180
  return (
    <svg viewBox="0 0 120 70" className="mt-2 h-16 w-full" aria-hidden>
      {Array.from({ length: 11 }).map((_, i) => {
        const a = Math.PI + (i * Math.PI) / 10
        const x1 = 60 + 44 * Math.cos(a)
        const y1 = 62 + 44 * Math.sin(a)
        const x2 = 60 + 52 * Math.cos(a)
        const y2 = 62 + 52 * Math.sin(a)
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#2A3A6B" strokeWidth="1.4" />
      })}
      <path d="M 12 62 A 48 48 0 0 1 108 62" fill="none" stroke="#1B2647" strokeWidth="5" strokeLinecap="round" />
      <motion.path
        d="M 12 62 A 48 48 0 0 1 108 62"
        fill="none"
        stroke="#34D399"
        strokeWidth="5"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={started ? { pathLength: pct } : {}}
        transition={{ duration: 1.4, delay: 0.3, ease: 'easeOut' }}
      />
      <motion.line
        x1="60"
        y1="62"
        x2="60"
        y2="24"
        stroke="#EDF2FF"
        strokeWidth="2"
        strokeLinecap="round"
        style={{ transformOrigin: '60px 62px' }}
        initial={{ rotate: -90 }}
        animate={started ? { rotate: -90 + pct * 180 } : {}}
        transition={{ type: 'spring', stiffness: 60, damping: 8, delay: 0.4 }}
      />
      <circle cx="60" cy="62" r="3.5" fill="#34D399" />
    </svg>
  )
}

interface PanelProps {
  hud: string
  value: string
  label: string
  children: ReactNode
}

function Panel({ hud, value, label, children }: PanelProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 40 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      whileHover={{ scale: 1.04 }}
      className="group relative rounded-2xl glass-panel p-6 transition-shadow duration-300 hover:shadow-[0_0_28px_rgba(124,92,255,0.3)]"
    >
      <HudCorner />
      <p className="hud-label">{hud}</p>
      <p className="mt-3 font-grotesk text-3xl font-bold tabular-nums text-ink-primary md:text-4xl">{value}</p>
      <p className="mt-1 text-[13px] text-ink-faint">{label}</p>
      {children}
    </motion.div>
  )
}

export default function DataPulseSection() {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, margin: '-80px' })

  const gmv = useCountUp(1284600, { duration: 1.8, started: inView })
  const skills = useCountUp(12040, { duration: 1.8, started: inView })
  const industries = useCountUp(86, { duration: 1.8, started: inView })
  const fulfillment = useCountUp(98.2, { duration: 1.8, decimals: 1, started: inView })

  return (
    <section className="relative bg-deep py-[72px] md:py-[120px]">
      <div className="mx-auto max-w-site px-5 md:px-12" ref={ref}>
        <div className="mb-12 flex items-end justify-between">
          <div>
            <p className="hud-label text-pulse-cyan/80">LIVE PULSE</p>
            <h2 className="mt-3 font-display text-[26px] font-bold tracking-[0.02em] text-ink-primary md:text-4xl">
              数据星云 · 平台实时脉搏
            </h2>
          </div>
          <p className="hidden items-center gap-2 font-mono text-[11px] tracking-[0.18em] text-jade-green md:flex">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-jade-green" />
            LIVE
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
          <Panel hud="MONTHLY GMV · TOKEN" value={`¥ ${gmv}`} label="平台月度雇佣交易额">
            <AreaChart started={inView} />
          </Panel>
          <Panel hud="SKILLS HATCHED" value={skills} label="累计孵化技能数">
            <div className="mt-3 flex items-center gap-4">
              <RingProgress started={inView} pct={0.78} />
              <p className="font-mono text-[11px] leading-relaxed text-ink-faint">
                TARGET
                <br />
                <span className="text-pulse-cyan">78%</span> OF 15,500
              </p>
            </div>
          </Panel>
          <Panel hud="INDUSTRIES" value={industries} label="覆盖工业细分行业">
            <MiniBars started={inView} />
          </Panel>
          <Panel hud="CONTRACT FULFILLMENT" value={`${fulfillment}%`} label="智能合约履约率">
            <Gauge started={inView} pct={0.982} />
          </Panel>
        </div>
      </div>
    </section>
  )
}
