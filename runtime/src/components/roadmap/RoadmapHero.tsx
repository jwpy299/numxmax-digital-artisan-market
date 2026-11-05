import { motion } from 'framer-motion'

const CHIPS = [
  { num: '3–5', unit: '位', label: '首批老师傅' },
  { num: '前 100', unit: '家', label: '雇主优惠' },
  { num: '5', unit: '周', label: '上线计划' },
]

const TITLE_WORDS = ['运营', '策略', '与', '上线', '路线']

export default function RoadmapHero() {
  return (
    <section className="relative overflow-hidden bg-void">
      <div className="nebula-halo pointer-events-none absolute -top-40 left-1/2 h-96 w-[900px] -translate-x-1/2" />
      <div className="relative mx-auto max-w-site px-5 pb-16 pt-20 md:px-12 md:pb-20 md:pt-24">
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6 }} className="hud-label text-pulse-cyan/80">
          GO-TO-MARKET · LAUNCH PLAN
        </motion.p>

        <h1 className="mt-4 font-display text-[32px] font-bold leading-[1.2] tracking-[0.02em] text-ink-primary md:text-5xl">
          {TITLE_WORDS.map((w, i) => (
            <motion.span
              key={w}
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.1 + i * 0.08, ease: [0.16, 1, 0.3, 1] }}
              className="mr-2 inline-block last:mr-0"
            >
              {w}
            </motion.span>
          ))}
        </h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="mt-5 max-w-2xl text-[15px] leading-relaxed text-ink-secondary md:text-base"
        >
          一个双边市场的冷启动：先让老师傅愿意来，再让工厂愿意雇，最后用质量守住信任。
        </motion.p>

        <div className="mt-10 flex flex-wrap gap-4">
          {CHIPS.map((c, i) => (
            <motion.div
              key={c.label}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: 'spring', stiffness: 260, damping: 16, delay: 0.5 + i * 0.07 }}
              className="glass-panel flex items-baseline gap-2 rounded-full px-5 py-3"
            >
              <span className="font-grotesk text-xl font-bold text-brand-gradient md:text-2xl">
                {c.num}
                <span className="ml-0.5 font-sans text-xs font-normal text-ink-secondary">{c.unit}</span>
              </span>
              <span className="text-xs text-ink-faint">{c.label}</span>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
