import { motion } from 'framer-motion'
import { TrendingUp, Star, Sparkles } from 'lucide-react'

const CHIPS = [
  { icon: TrendingUp, label: '供需浮动 ±20%/月', target: 'rule-demand' },
  { icon: Star, label: '评分溢价', target: 'rule-rating' },
  { icon: Sparkles, label: '经验增值', target: 'rule-experience' },
]

const TITLE = '经验即身价，供需定价格'

export default function PricingHero() {
  return (
    <section className="relative overflow-hidden bg-void pb-16 pt-24 md:pb-20 md:pt-32">
      <div aria-hidden className="nebula-halo pointer-events-none absolute -top-48 left-1/2 h-[480px] w-[820px] -translate-x-1/2" />
      <div className="relative z-10 mx-auto max-w-3xl px-5 text-center md:px-12">
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6 }}
          className="hud-label text-pulse-cyan/80"
        >
          MARKET-DRIVEN PRICING
        </motion.p>
        <h1 className="mt-5 font-display text-[32px] font-bold leading-tight tracking-[0.02em] text-ink-primary md:text-5xl">
          {TITLE.split('，').map((part, i) => (
            <span key={part} className="inline-block overflow-hidden align-bottom">
              {Array.from(part).map((ch, j) => (
                <motion.span
                  key={j}
                  className="inline-block"
                  initial={{ y: 40, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.6, delay: 0.08 * (i * 6 + j), ease: [0.16, 1, 0.3, 1] }}
                >
                  {ch}
                </motion.span>
              ))}
              {i === 0 && (
                <motion.span
                  className="inline-block"
                  initial={{ y: 40, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.6, delay: 0.08 * 6, ease: [0.16, 1, 0.3, 1] }}
                >
                  ，
                </motion.span>
              )}
            </span>
          ))}
        </h1>
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.7 }}
          className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-ink-secondary md:text-base"
        >
          数字工匠的月薪不再是一口价。它随市场供需、雇主评分与累计经验持续浮动——就像真实的人才市场。
        </motion.p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          {CHIPS.map((c, i) => (
            <motion.button
              key={c.label}
              type="button"
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 320, damping: 18, delay: 0.9 + i * 0.07 }}
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.96 }}
              onClick={() => document.getElementById(c.target)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
              className="inline-flex items-center gap-2 rounded-full border border-pulse-cyan/30 bg-panel/60 px-4 py-2 text-[13px] text-ink-secondary transition-colors hover:border-pulse-cyan/60 hover:text-pulse-cyan"
            >
              <c.icon className="h-3.5 w-3.5 text-pulse-cyan" />
              {c.label}
            </motion.button>
          ))}
        </div>
      </div>
    </section>
  )
}
