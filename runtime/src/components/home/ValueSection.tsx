import { motion } from 'framer-motion'
import { Hammer, Factory, Network, Globe2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import SectionHeader from '@/components/SectionHeader'

const CARDS: Array<{ icon: LucideIcon; title: string; desc: string; quote: string; author: string }> = [
  {
    icon: Hammer,
    title: '老师傅',
    desc: '经验变为有身份、有身价、能持续增值的数字徒弟。Agent 被雇佣越多，收益越高。',
    quote: '我带出了徒弟，现在徒弟能同时去一百家工厂上班。',
    author: '陈国栋 · 32年数控经验',
  },
  {
    icon: Factory,
    title: '工厂',
    desc: '不需学习复杂技能组合，直接雇佣数字工匠。越用越懂工厂，按需雇佣，灵活调整。',
    quote: '以前买软件像请家教，现在像招了个老师傅。',
    author: '某精密零部件厂 · 生产总监',
  },
  {
    icon: Network,
    title: '平台',
    desc: '从「技能交易市场」升级为「数字劳动力市场」，收入来源多元化，平台价值指数增长。',
    quote: '我们交易的不是功能，而是会成长的生产力。',
    author: 'NumX Max·数字匠市 · 产品团队',
  },
  {
    icon: Globe2,
    title: '行业',
    desc: '创造全新职业形态——数字员工。老师傅经验可永久传承，工业知识流动性被彻底激活。',
    quote: '断代的手艺，第一次有了不会退休的传人。',
    author: '行业协会 · 观察报告',
  },
]

export default function ValueSection() {
  return (
    <section className="bg-void py-[72px] md:py-[120px]">
      <div className="mx-auto max-w-site px-5 md:px-12">
        <SectionHeader hud="VALUE FOR ALL" title="一次升级，四方共赢" />

        <div className="mt-14 grid gap-6 md:grid-cols-2">
          {CARDS.map((card, i) => (
            <motion.div
              key={card.title}
              initial={{ opacity: 0, y: 60 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-60px' }}
              transition={{ duration: 0.8, delay: i * 0.15, ease: [0.16, 1, 0.3, 1] }}
              className="group relative overflow-hidden rounded-2xl glass-panel p-7 md:p-8"
            >
              {/* hover top gradient bar */}
              <span className="absolute inset-x-0 top-0 h-[2px] origin-left scale-x-0 bg-brand-gradient transition-transform duration-500 group-hover:scale-x-100" />
              <div className="flex items-center gap-4">
                <motion.span
                  animate={{ y: [0, -4, 0] }}
                  transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut', delay: i * 0.4 }}
                  className="inline-flex h-12 w-12 items-center justify-center rounded-xl border border-nebula-violet/40 bg-nebula-violet/10"
                >
                  <card.icon className="h-5 w-5 text-nebula-violet" />
                </motion.span>
                <h3 className="font-display text-xl font-bold text-ink-primary md:text-[22px]">{card.title}</h3>
              </div>
              <p className="mt-4 text-[15px] leading-[1.75] text-ink-secondary">{card.desc}</p>
              <p className="mt-5 border-t border-line-subtle pt-4 text-[13px] leading-relaxed text-ink-faint">
                「{card.quote}」—— {card.author}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
