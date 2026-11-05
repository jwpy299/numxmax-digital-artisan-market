import { motion } from 'framer-motion'
import { SlidersHorizontal, Scale, Star, TrendingUp } from 'lucide-react'
import SectionHeader from '@/components/SectionHeader'
import HudCorner from '@/components/HudCorner'

const RULES = [
  {
    id: 'rule-base',
    num: '01',
    icon: SlidersHorizontal,
    title: '初始定价',
    body: '参考技能数量、复杂度、老师傅声望、同类 Agent 参考价，平台给出建议价，老师傅确认后可自主微调。',
  },
  {
    id: 'rule-demand',
    num: '02',
    icon: Scale,
    title: '供需调价',
    body: '供不应求 → 自动上浮（每月上限 +20%）；供过于求 → 自动下调（每月下限 -20%）。',
  },
  {
    id: 'rule-rating',
    num: '03',
    icon: Star,
    title: '评分联动',
    body: '高评分 Agent 获得溢价空间；低评分 Agent 自动降价；连续 3 个月低于 3 星下架整改。',
  },
  {
    id: 'rule-experience',
    num: '04',
    icon: TrendingUp,
    title: '经验增值',
    body: '累计任务与工作记忆沉淀为经验值，经验越高价格越高，经验永不贬值。',
  },
]

export default function PricingRules() {
  return (
    <section className="bg-void py-20 md:py-28">
      <div className="mx-auto max-w-site px-5 md:px-12">
        <SectionHeader
          hud="PRICING RULES"
          title="四条定价规则"
          subtitle="一只看不见的手，配合四条写得清的规则——价格永远有据可依。"
        />
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {RULES.map((r, i) => (
            <motion.div
              key={r.num}
              id={r.id}
              initial={{ opacity: 0, y: 50 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-80px' }}
              transition={{ duration: 0.7, delay: i * 0.12, ease: [0.16, 1, 0.3, 1] }}
              whileHover={{ y: -6 }}
              className="glass-panel group relative rounded-2xl p-7 transition-shadow duration-300 hover:shadow-[0_0_24px_rgba(124,92,255,0.35)]"
            >
              <HudCorner />
              <div className="flex items-start justify-between">
                <span className="font-grotesk text-3xl font-bold text-forge-amber/90 transition-all duration-300 group-hover:[text-shadow:0_0_18px_rgba(245,165,36,0.7)]">
                  {r.num}
                </span>
                <r.icon className="h-5 w-5 text-ink-faint transition-colors duration-300 group-hover:text-pulse-cyan" />
              </div>
              <h3 className="mt-5 text-lg font-bold text-ink-primary">{r.title}</h3>
              <p className="mt-3 text-[13px] leading-[1.75] text-ink-secondary">{r.body}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
