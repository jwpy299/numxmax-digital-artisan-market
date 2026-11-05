import { motion } from 'framer-motion'
import SectionHeader from '@/components/SectionHeader'

const QUOTES = [
  {
    role: '老师傅',
    hud: 'FOR MASTERS',
    text: '经验变为有身份、有身价、能持续增值的数字徒弟。Agent 被雇佣越多，收益越高。',
    color: 'text-nebula-violet',
  },
  {
    role: '工厂',
    hud: 'FOR FACTORIES',
    text: '不需学习复杂技能组合，直接雇佣数字工匠。Agent 越用越懂工厂，按需雇佣，灵活调整。',
    color: 'text-pulse-cyan',
  },
  {
    role: '平台',
    hud: 'FOR PLATFORM',
    text: '从「技能交易市场」升级为「数字劳动力市场」，收入来源多元化，平台价值指数增长。',
    color: 'text-forge-amber',
  },
  {
    role: '行业',
    hud: 'FOR INDUSTRY',
    text: '创造全新职业形态——数字员工。老师傅经验可永久传承、持续增值，工业知识流动性被彻底激活。',
    color: 'text-jade-green',
  },
]

export default function ValueFinale() {
  return (
    <section className="relative bg-deep">
      <div className="mx-auto max-w-site px-5 py-[72px] md:px-12 md:py-[120px]">
        <SectionHeader
          hud="SHARED VALUE"
          title="价值终章 — 四方共赢"
          subtitle="一个市场能走多远，取决于它让多少角色变得更好。"
        />

        <div className="mx-auto mt-16 max-w-[760px] space-y-14">
          {QUOTES.map((q, i) => (
            <motion.blockquote
              key={q.role}
              initial={{ opacity: 0, y: 40 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-80px' }}
              transition={{ duration: 0.7, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
              className="relative pl-14 md:pl-20"
            >
              <motion.span
                aria-hidden
                initial={{ opacity: 0, scale: 1.3 }}
                whileInView={{ opacity: 0.15, scale: 1 }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{ duration: 0.8, delay: 0.15 + i * 0.05 }}
                className="absolute -top-8 left-0 select-none font-display text-[80px] leading-none text-ink-primary md:-top-10 md:text-[120px]"
              >
                “
              </motion.span>
              <p className={`hud-label ${q.color}`}>{q.hud}</p>
              <h3 className="mt-2 font-display text-xl font-bold text-ink-primary md:text-2xl">{q.role}</h3>
              <p className="mt-3 text-[15px] leading-[1.9] text-ink-secondary md:text-base">{q.text}</p>
            </motion.blockquote>
          ))}
        </div>
      </div>
    </section>
  )
}
