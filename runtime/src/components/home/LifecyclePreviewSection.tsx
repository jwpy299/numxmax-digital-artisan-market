import { useRef } from 'react'
import { Link } from 'react-router'
import { motion, useScroll, useTransform } from 'framer-motion'
import SectionHeader from '@/components/SectionHeader'

const STEPS = [
  { name: '孵化', desc: '技能工坊捕获老师傅的动作与判断逻辑，自动封装 Agent。', anchor: 'hatch' },
  { name: '上架', desc: '自动进入市场，展示技能、价格与档案。', anchor: 'list' },
  { name: '定价', desc: '供需驱动，每月浮动上限 ±20%。', anchor: 'pricing' },
  { name: '雇佣', desc: '7 天沙箱试用，满意后签订智能合约。', anchor: 'hire' },
  { name: '执行', desc: '自然语言下达任务，自动拆解并实时反馈。', anchor: 'execute' },
  { name: '进化', desc: '工作记忆沉淀，经验越多身价越高。', anchor: 'evolve' },
]

export default function LifecyclePreviewSection() {
  const lineRef = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({
    target: lineRef,
    offset: ['start 80%', 'end 45%'],
  })
  const pathLength = useTransform(scrollYProgress, [0, 1], [0, 1])

  return (
    <section className="bg-void py-[72px] md:py-[120px]">
      <div className="mx-auto max-w-site px-5 md:px-12">
        <SectionHeader hud="AGENT LIFECYCLE" title="一位数字工匠的一生" />

        <div ref={lineRef} className="relative mt-16">
          {/* connecting dashed line (desktop) */}
          <svg
            viewBox="0 0 1000 4"
            preserveAspectRatio="none"
            className="absolute left-0 top-[9px] hidden h-1 w-full lg:block"
            aria-hidden
          >
            <motion.line
              x1="0"
              y1="2"
              x2="1000"
              y2="2"
              stroke="#7C5CFF"
              strokeWidth="2"
              strokeDasharray="6 8"
              strokeOpacity="0.5"
              style={{ pathLength }}
            />
          </svg>

          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-6 lg:gap-6">
            {STEPS.map((step, i) => (
              <motion.div
                key={step.name}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ duration: 0.5, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] }}
                className="group relative"
              >
                <motion.span
                  initial={{ scale: 0 }}
                  whileInView={{ scale: 1 }}
                  viewport={{ once: true, margin: '-60px' }}
                  transition={{ type: 'spring', stiffness: 260, damping: 14, delay: i * 0.08 }}
                  className="relative block h-[18px] w-[18px] rounded-full bg-nebula-violet shadow-[0_0_12px_rgba(124,92,255,0.8)] transition-shadow duration-300 group-hover:shadow-[0_0_28px_rgba(124,92,255,1)]"
                >
                  <span className="absolute inset-0 rounded-full bg-nebula-violet/40 transition-transform duration-300 group-hover:scale-[2.2] group-hover:opacity-0" />
                </motion.span>
                <div className="mt-4 transition-transform duration-300 group-hover:-translate-y-1">
                  <h3 className="font-display text-lg font-bold text-ink-primary">
                    <span className="mr-2 font-mono text-xs text-ink-faint">0{i + 1}</span>
                    {step.name}
                  </h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{step.desc}</p>
                  <Link
                    to={`/lifecycle#${step.anchor}`}
                    className="mt-2 inline-block font-mono text-[11px] tracking-wider text-pulse-cyan/80 transition-colors hover:text-pulse-cyan"
                  >
                    查看详情 →
                  </Link>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
