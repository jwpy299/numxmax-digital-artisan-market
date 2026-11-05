import { useRef } from 'react'
import { motion, useInView } from 'framer-motion'
import { ShieldCheck, Star, AlertTriangle } from 'lucide-react'
import SectionHeader from '@/components/SectionHeader'
import HudCorner from '@/components/HudCorner'

const RULES = [
  {
    icon: ShieldCheck,
    title: '上架审核',
    text: 'Agent 上架前必须通过模型评审会审核，未通过不展示。',
    tone: 'jade' as const,
  },
  {
    icon: Star,
    title: '评分联动',
    text: '评分直接挂钩价格与排名：高评分溢价，低评分降价。',
    tone: 'amber' as const,
  },
]

function StarGauge({ started }: { started: boolean }) {
  // scale bar 0-5 stars; red line at 3
  return (
    <div className="mt-6">
      <div className="relative h-2 overflow-visible rounded-full bg-panel">
        <motion.div
          initial={{ scaleX: 0 }}
          animate={started ? { scaleX: 1 } : {}}
          transition={{ duration: 1.2, delay: 0.4, ease: 'easeOut' }}
          className="absolute inset-0 origin-left rounded-full bg-gradient-to-r from-ember-red via-forge-amber to-jade-green"
        />
        {/* red alert line at 3 stars */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={started ? { opacity: [0, 1, 0.3, 1, 0.3, 1] } : {}}
          transition={{ duration: 1.2, delay: 1.6, times: [0, 0.2, 0.4, 0.6, 0.8, 1] }}
          className="absolute -inset-y-2 left-[60%] w-0.5 bg-ember-red shadow-[0_0_10px_rgba(244,63,94,0.8)]"
        />
        <span className="absolute -top-7 left-[60%] -translate-x-1/2 rounded border border-ember-red/50 bg-ember-red/10 px-1.5 py-0.5 font-mono text-[9px] text-ember-red">
          下架红线 3★
        </span>
      </div>
      <div className="mt-3 flex justify-between font-mono text-[10px] text-ink-faint">
        {[0, 1, 2, 3, 4, 5].map((s) => (
          <span key={s} className={s === 3 ? 'text-ember-red' : ''}>
            {s}★
          </span>
        ))}
      </div>
    </div>
  )
}

export default function QualityControl() {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, margin: '-120px' })

  return (
    <section ref={ref} className="relative bg-deep">
      <div className="mx-auto max-w-site px-5 py-[72px] md:px-12 md:py-[120px]">
        <SectionHeader
          hud="TRUST RED LINE"
          title="质量控制 — 信任红线"
          subtitle="双边市场的根基是信任。三条机制，守住每一位数字工匠的质量底线。"
        />

        {/* the red line */}
        <div className="relative mt-16">
          <motion.div
            initial={{ scaleX: 0 }}
            animate={inView ? { scaleX: 1 } : {}}
            transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
            className="absolute left-0 right-0 top-1/2 hidden h-px origin-center bg-gradient-to-r from-transparent via-ember-red/70 to-transparent md:block"
            style={{ boxShadow: '0 0 12px rgba(244,63,94,0.4)' }}
          />

          <div className="relative grid gap-6 md:grid-cols-2">
            {RULES.map((r, i) => (
              <motion.div
                key={r.title}
                initial={{ opacity: 0, y: 40 }}
                animate={inView ? { opacity: 1, y: 0 } : {}}
                transition={{ duration: 0.6, delay: 0.2 + i * 0.12, ease: [0.16, 1, 0.3, 1] }}
                className="glass-panel relative rounded-2xl p-7"
              >
                <HudCorner />
                <span
                  className={`flex h-11 w-11 items-center justify-center rounded-xl border ${
                    r.tone === 'jade'
                      ? 'border-jade-green/40 bg-jade-green/10 text-jade-green'
                      : 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber'
                  }`}
                >
                  <r.icon className="h-5 w-5" />
                </span>
                <h3 className="mt-5 font-display text-lg font-bold text-ink-primary md:text-[22px]">{r.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary md:text-sm">{r.text}</p>
              </motion.div>
            ))}
          </div>

          {/* auto-delist card */}
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={inView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.6, delay: 0.45, ease: [0.16, 1, 0.3, 1] }}
            className="relative mx-auto mt-6 max-w-3xl rounded-2xl border border-ember-red/40 bg-[#160A12]/60 p-7 backdrop-blur-md md:p-8"
          >
            <HudCorner className="[&>span]:border-ember-red/60" />
            <div className="flex flex-col gap-6 md:flex-row md:items-start">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-ember-red/40 bg-ember-red/10 text-ember-red">
                <AlertTriangle className="h-5 w-5" />
              </span>
              <div className="flex-1">
                <h3 className="font-display text-lg font-bold text-ink-primary md:text-[22px]">自动下架</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary md:text-sm">
                  连续 <span className="font-grotesk text-base font-bold text-ember-red">3</span> 个月评分低于{' '}
                  <span className="font-grotesk text-base font-bold text-ember-red">3 星</span>
                  （满分 5 星）的 Agent 自动下架整改——质量不达标，就没有留在市场的资格。
                </p>
                <StarGauge started={inView} />
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  )
}
