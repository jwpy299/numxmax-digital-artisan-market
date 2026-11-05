import { motion } from 'framer-motion'
import { Hammer, KeyRound, FileCheck2 } from 'lucide-react'
import SectionHeader from '@/components/SectionHeader'
import HudCorner from '@/components/HudCorner'

const STEPS = [
  {
    icon: Hammer,
    num: '01',
    title: '在市场雇佣数字工匠',
    desc: '在数字匠市搜索、试用并按月雇佣适合产线的数字工匠，签订智能合约。',
    badge: null as string | null,
  },
  {
    icon: KeyRound,
    num: '02',
    title: '跳转智能工作台',
    desc: '从市场一键跳转至星云智能工作台，两段式 SSO 免密登录已打通：一次性 ticket 即签即跳，无需二次认证。',
    badge: 'SSO 已打通',
  },
  {
    icon: FileCheck2,
    num: '03',
    title: '下达任务并收回报告',
    desc: '用自然语言下达任务，实时追踪执行过程，收回带置信度评级的结构化报告。',
    badge: null as string | null,
  },
]

/** 三步衔接流程：市场雇佣 → 跳转工作台 → 执行任务 */
export default function FlowSteps() {
  return (
    <section className="relative bg-void">
      <div className="mx-auto max-w-site px-5 py-16 md:px-12 md:py-24">
        <SectionHeader
          hud="HOW IT CONNECTS"
          title="从雇佣到执行，三步衔接"
          subtitle="市场与工作台各司其职，串联起数字劳动力的完整使用链路。"
        />

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {STEPS.map((step, i) => (
            <motion.div
              key={step.num}
              initial={{ opacity: 0, y: 40 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-80px' }}
              transition={{ duration: 0.7, delay: i * 0.1, ease: [0.16, 1, 0.3, 1] }}
              whileHover={{ y: -6 }}
              className="glass-panel group relative rounded-2xl p-7 transition-shadow duration-300 hover:shadow-[0_0_24px_rgba(124,92,255,0.35)]"
            >
              <HudCorner />
              <div className="flex items-center justify-between">
                <div className="pulse-halo flex h-12 w-12 items-center justify-center rounded-xl border border-pulse-cyan/30 bg-pulse-cyan/10">
                  <step.icon className="h-6 w-6 text-pulse-cyan" />
                </div>
                <span className="font-grotesk text-4xl font-bold text-ink-faint/60">{step.num}</span>
              </div>

              <h3 className="mt-5 text-lg font-bold text-ink-primary">{step.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-ink-secondary">{step.desc}</p>

              {step.badge && (
                <span className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-jade-green/40 bg-jade-green/10 px-3 py-1 text-xs text-jade-green">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-jade-green opacity-60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-jade-green" />
                  </span>
                  {step.badge}
                </span>
              )}
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
