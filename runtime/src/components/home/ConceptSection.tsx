import { memo } from 'react'
import { motion } from 'framer-motion'
import { Fingerprint, Wrench, Brain, BadgeDollarSign, ShieldCheck } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import SectionHeader from '@/components/SectionHeader'
import HudCorner from '@/components/HudCorner'

const CARDS: Array<{ icon: LucideIcon; title: string; desc: string }> = [
  { icon: Fingerprint, title: '独立身份', desc: '名称、头像、编号，像员工一样有档案。' },
  { icon: Wrench, title: '技能清单', desc: '封装老师傅的全部技能，清晰可查。' },
  { icon: Brain, title: '工作记忆', desc: '每次任务都被记住，越用越懂雇主。' },
  { icon: BadgeDollarSign, title: '雇佣价格', desc: '市场供需动态定价，经验即身价。' },
  { icon: ShieldCheck, title: '信用档案', desc: '雇主评价与历史记录沉淀为信用。' },
]

/** 3s cyan pulse halo, isolated + memoized so parent re-renders never reset it */
const PulseIcon = memo(function PulseIcon({ Icon }: { Icon: LucideIcon }) {
  return (
    <span className="relative inline-flex h-12 w-12 items-center justify-center rounded-xl border border-pulse-cyan/30 bg-pulse-cyan/5">
      <span className="pulse-halo absolute inset-0 rounded-xl border border-pulse-cyan/40" />
      <Icon className="h-5 w-5 text-pulse-cyan" />
    </span>
  )
})

export default function ConceptSection() {
  return (
    <section className="relative overflow-hidden bg-void py-[72px] md:py-[120px]">
      <div
        className="pointer-events-none absolute right-0 top-1/2 h-[480px] w-[60%] -translate-y-1/2 opacity-40"
        style={{
          backgroundImage: 'url(/nebula-band.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          maskImage: 'linear-gradient(to left, black, transparent)',
          WebkitMaskImage: 'linear-gradient(to left, black, transparent)',
        }}
      />
      <div className="relative mx-auto max-w-site px-5 md:px-12">
        <SectionHeader
          hud="CORE CONCEPT"
          title="经验，被封装成有身份的存在"
          subtitle="老师傅在技能工坊演示操作，系统捕获动作（V）与判断逻辑（U），自动孵化出一位数字工匠。"
        />

        <div className="mt-14 flex snap-x gap-6 overflow-x-auto pb-4 lg:grid lg:grid-cols-5 lg:overflow-visible">
          {CARDS.map((card, i) => (
            <motion.div
              key={card.title}
              initial={{ opacity: 0, y: 50, rotate: 1.5 }}
              whileInView={{ opacity: 1, y: 0, rotate: 0 }}
              viewport={{ once: true, margin: '-60px' }}
              transition={{ duration: 0.7, delay: i * 0.1, ease: [0.16, 1, 0.3, 1] }}
              whileHover={{ y: -8 }}
              className="group relative w-[220px] shrink-0 snap-start rounded-2xl glass-panel p-7 transition-shadow duration-300 hover:shadow-[0_0_24px_rgba(124,92,255,0.4)] lg:w-auto"
            >
              <HudCorner />
              <motion.span
                whileHover={{ rotate: 8 }}
                transition={{ type: 'spring', stiffness: 300, damping: 15 }}
                className="inline-block"
              >
                <PulseIcon Icon={card.icon} />
              </motion.span>
              <h3 className="mt-5 text-lg font-bold text-ink-primary md:text-[22px]">{card.title}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{card.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
