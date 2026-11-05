import { useRef } from 'react'
import { motion, useScroll, useTransform } from 'framer-motion'
import SectionHeader from '@/components/SectionHeader'
import type { MotionValue } from 'framer-motion'

function Bar({ scaleX, className, delay = 0 }: { scaleX: MotionValue<number>; className: string; delay?: number }) {
  const delayed = useTransform(scaleX, (v) => Math.max(0, Math.min(1, (v - delay) / (1 - delay))))
  return <motion.div className={className} style={{ scaleX: delayed, transformOrigin: 'left center' }} />
}

export default function RevenueComparison() {
  const ref = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 85%', 'end 55%'] })

  return (
    <section className="bg-deep py-20 md:py-28">
      <div className="mx-auto max-w-site px-5 md:px-12">
        <SectionHeader
          hud="VS TRADITIONAL"
          title="与传统模式的收入对比"
          subtitle="同样的老师傅、同样的技能——交易结构不同，平台的收入曲线完全不同。"
        />

        <div ref={ref} className="mx-auto mt-14 max-w-4xl space-y-10">
          {/* 传统 */}
          <div>
            <div className="mb-3 flex items-baseline justify-between">
              <span className="text-sm font-bold text-ink-secondary">纯技能交易市场</span>
              <span className="font-mono text-xs text-ink-faint">按次抽佣 ×1.0</span>
            </div>
            <div className="h-10 w-full overflow-hidden rounded-lg bg-muted/40">
              <Bar scaleX={scrollYProgress} className="h-full w-[29%] rounded-lg bg-ink-faint/70" />
            </div>
            <p className="mt-2 font-mono text-[10px] text-ink-faint">技能调用佣金 · 脉冲式收入</p>
          </div>

          {/* 数字劳动力市场 */}
          <div>
            <div className="mb-3 flex items-baseline justify-between">
              <span className="text-sm font-bold text-ink-primary">数字劳动力市场</span>
              <span className="font-mono text-xs text-pulse-cyan">按月抽佣 ×3.4</span>
            </div>
            <div className="flex h-10 w-full gap-1 overflow-hidden rounded-lg bg-muted/40">
              <Bar scaleX={scrollYProgress} delay={0.15} className="h-full w-[29%] rounded-l-lg bg-pulse-cyan/80" />
              <Bar scaleX={scrollYProgress} delay={0.3} className="h-full w-[43%] bg-nebula-violet/80" />
              <Bar scaleX={scrollYProgress} delay={0.45} className="h-full flex-1 rounded-r-lg bg-forge-amber/80" />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-5 font-mono text-[10px] text-ink-faint">
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-pulse-cyan/80" />技能调用</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-nebula-violet/80" />雇佣佣金</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-forge-amber/80" />试用调用</span>
            </div>
          </div>
        </div>

        <motion.p
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto mt-16 max-w-2xl text-center font-display text-lg font-bold leading-relaxed text-ink-primary md:text-2xl"
        >
          从按次抽佣到按月抽佣，收入曲线从<span className="text-amber-gradient">脉冲</span>变为<span className="text-brand-gradient">复利</span>。
        </motion.p>
      </div>
    </section>
  )
}
