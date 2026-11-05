import { useRef } from 'react'
import { motion, useInView } from 'framer-motion'
import { Zap, Handshake, FlaskConical } from 'lucide-react'
import SectionHeader from '@/components/SectionHeader'
import HudCorner from '@/components/HudCorner'
import { useCountUp } from '@/hooks/useCountUp'

const MODELS = [
  {
    icon: Zap,
    color: '#22D3EE',
    colorClass: 'text-pulse-cyan',
    title: '技能调用费',
    value: 20,
    suffix: '%',
    desc: 'Agent 内部技能调用，每次计收；试用期技能调用照常收费。',
    note: '每次调用抽取佣金',
  },
  {
    icon: Handshake,
    color: '#7C5CFF',
    colorClass: 'text-nebula-violet',
    title: 'Agent 雇佣费',
    value: 15,
    suffix: '%',
    desc: 'Agent 被雇佣期间按月结算，雇主与平台每月清算一次。',
    note: '月薪抽取佣金',
  },
  {
    icon: FlaskConical,
    color: '#F5A524',
    colorClass: 'text-forge-amber',
    title: 'Agent 试用费',
    value: 7,
    suffix: '天',
    desc: '7 天免费试用，但试用期内技能调用费照常收取——试用本身也是收入场景。',
    note: '免费试用 · 调用照收',
  },
]

function ModelCard({ m, index }: { m: (typeof MODELS)[number]; index: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, margin: '-80px' })
  const num = useCountUp(m.value, { duration: 1.4, started: inView })

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 60 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.7, delay: index * 0.15, ease: [0.16, 1, 0.3, 1] }}
      className="glass-panel group relative overflow-hidden rounded-2xl p-8"
    >
      <HudCorner />
      {/* hover 顶部光条 */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-[2px] origin-left scale-x-0 transition-transform duration-500 ease-out group-hover:scale-x-100"
        style={{ background: `linear-gradient(90deg, ${m.color}, transparent)` }}
      />
      <m.icon className={`h-7 w-7 ${m.colorClass}`} />
      <h3 className="mt-5 text-lg font-bold text-ink-primary">{m.title}</h3>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">{m.note}</p>
      <p className="mt-6 font-grotesk text-[64px] font-bold leading-none" style={{ color: m.color }}>
        {num}
        <span className="text-[32px]">{m.suffix}</span>
      </p>
      <p className="mt-5 border-t border-line-subtle pt-4 text-[13px] leading-[1.75] text-ink-secondary">{m.desc}</p>
    </motion.div>
  )
}

export default function RevenueModel() {
  return (
    <section className="bg-deep py-20 md:py-28">
      <div className="mx-auto max-w-site px-5 md:px-12">
        <SectionHeader
          hud="REVENUE MODEL"
          title="平台的三层收入"
          subtitle="技能调用、长期雇佣、试用场景——每一层都在为平台与老师傅创造持续现金流。"
        />
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {MODELS.map((m, i) => (
            <ModelCard key={m.title} m={m} index={i} />
          ))}
        </div>
      </div>
    </section>
  )
}
