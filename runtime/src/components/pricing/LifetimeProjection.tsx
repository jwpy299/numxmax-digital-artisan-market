import { useRef } from 'react'
import { motion, useInView } from 'framer-motion'
import SectionHeader from '@/components/SectionHeader'
import HudCorner from '@/components/HudCorner'
import { useCountUp } from '@/hooks/useCountUp'

const ROWS = [
  { source: '雇佣佣金', formula: '月薪 1,000 Token × 15% × 12 个月 × 10 个雇主', amount: '18,000 Token' },
  { source: '技能分润', formula: '每次 100 Token × 20% × 100 次/月 × 12 个月', amount: '24,000 Token' },
]

/** donut: 雇佣佣金 43% violet / 技能分润 57% cyan */
function Donut({ started }: { started: boolean }) {
  const R = 70
  const C = 2 * Math.PI * R
  const hire = 0.43
  return (
    <svg viewBox="0 0 180 180" className="h-44 w-44 -rotate-90" aria-hidden>
      <circle cx="90" cy="90" r={R} fill="none" stroke="#1B2647" strokeWidth="16" />
      <motion.circle
        cx="90" cy="90" r={R} fill="none" stroke="#7C5CFF" strokeWidth="16"
        strokeDasharray={C}
        initial={{ strokeDashoffset: C }}
        animate={started ? { strokeDashoffset: C * (1 - hire) } : {}}
        transition={{ duration: 1.1, ease: 'easeOut', delay: 0.3 }}
      />
      <motion.circle
        cx="90" cy="90" r={R} fill="none" stroke="#22D3EE" strokeWidth="16"
        strokeDasharray={C}
        transform={`rotate(${hire * 360} 90 90)`}
        initial={{ strokeDashoffset: C }}
        animate={started ? { strokeDashoffset: C * (1 - (1 - hire)) } : {}}
        transition={{ duration: 1.1, ease: 'easeOut', delay: 0.5 }}
      />
    </svg>
  )
}

export default function LifetimeProjection() {
  const rightRef = useRef<HTMLDivElement>(null)
  const inView = useInView(rightRef, { once: true, margin: '-100px' })
  const total = useCountUp(42000, { duration: 2, started: inView })

  return (
    <section className="bg-void py-20 md:py-28">
      <div className="mx-auto max-w-site px-5 md:px-12">
        <SectionHeader
          hud="UNIT ECONOMICS"
          title="单 Agent 生命周期收入测算"
          subtitle="以一位中坚数字工匠为样本：10 个雇主、每月 100 次技能调用，一年可为平台创造的收入。"
        />
        <div className="mt-12 grid items-center gap-10 lg:grid-cols-[55%_45%]">
          {/* 左 · 测算表 */}
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            className="glass-panel relative rounded-2xl p-7 md:p-8"
          >
            <HudCorner />
            <p className="hud-label text-ink-faint">ANNUAL PROJECTION · 账单</p>
            <div className="mt-5 divide-y divide-line-subtle">
              {ROWS.map((r, i) => (
                <motion.div
                  key={r.source}
                  initial={{ opacity: 0, x: -30 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true, margin: '-60px' }}
                  transition={{ duration: 0.6, delay: 0.2 + i * 0.12 }}
                  className="grid gap-1 py-4 sm:grid-cols-[110px_1fr_auto] sm:items-baseline sm:gap-4"
                >
                  <span className="text-sm font-bold text-ink-primary">{r.source}</span>
                  <span className="font-mono text-[11px] leading-relaxed text-ink-secondary md:text-xs">{r.formula}</span>
                  <span className="font-grotesk text-lg font-bold tabular-nums text-ink-primary">{r.amount}</span>
                </motion.div>
              ))}
              <motion.div
                initial={{ opacity: 0, x: -30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ duration: 0.6, delay: 0.45 }}
                className="relative grid gap-1 overflow-hidden py-5 sm:grid-cols-[110px_1fr_auto] sm:items-baseline sm:gap-4"
              >
                <motion.span
                  aria-hidden
                  className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-forge-amber/10 to-transparent"
                  initial={{ x: '-100%' }}
                  whileInView={{ x: '300%' }}
                  viewport={{ once: true }}
                  transition={{ duration: 1.4, delay: 0.9, ease: 'easeInOut' }}
                />
                <span className="text-sm font-bold text-forge-amber">合计</span>
                <span className="font-mono text-[11px] text-ink-faint">—</span>
                <span className="font-grotesk text-xl font-bold tabular-nums text-amber-gradient">42,000 Token / 年</span>
              </motion.div>
            </div>
          </motion.div>

          {/* 右 · 汇总可视化 */}
          <div ref={rightRef} className="flex flex-col items-center text-center">
            <p className="font-grotesk text-[56px] font-bold leading-none tabular-nums text-amber-gradient md:text-[72px]">{total}</p>
            <p className="mt-2 font-mono text-xs uppercase tracking-[0.14em] text-ink-faint">Token / 年 · 单 Agent</p>
            <div className="relative mt-8">
              <Donut started={inView} />
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="font-grotesk text-lg font-bold text-ink-primary">2 层</span>
                <span className="text-[10px] text-ink-faint">收入构成</span>
              </div>
            </div>
            <div className="mt-4 flex gap-5 font-mono text-[11px]">
              <span className="inline-flex items-center gap-1.5 text-ink-secondary">
                <span className="h-2 w-2 rounded-sm bg-nebula-violet" />雇佣佣金 43%
              </span>
              <span className="inline-flex items-center gap-1.5 text-ink-secondary">
                <span className="h-2 w-2 rounded-sm bg-pulse-cyan" />技能分润 57%
              </span>
            </div>
            <p className="mt-6 max-w-xs text-[13px] leading-relaxed text-ink-faint">
              这是一个 Agent 一年的平台收入。市场有 127 位工匠。
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
