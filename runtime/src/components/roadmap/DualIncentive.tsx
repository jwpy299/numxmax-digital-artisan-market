import { useRef } from 'react'
import { motion, useInView } from 'framer-motion'
import { Trophy, RefreshCcw, Coins, Percent, Gift, FlaskConical, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import SectionHeader from '@/components/SectionHeader'
import { useCountUp } from '@/hooks/useCountUp'

interface IncentiveItem {
  icon: LucideIcon
  title: string
  text: string
  highlight?: boolean
}

const SUPPLY: IncentiveItem[] = [
  { icon: Coins, title: '市场定价引导', text: '平台建议价 + 老师傅确认，数据成熟后放开浮动。' },
  { icon: Trophy, title: 'Agent 雇佣排行榜', text: '定期公布排行榜，激励老师傅持续优化技能。' },
  { icon: RefreshCcw, title: '技能随时更新', text: '新技能自动生效——经验持续变现，越教越值钱。' },
]

const DEMAND: IncentiveItem[] = [
  { icon: Percent, title: '前 100 家首月 5 折', text: '前 100 家雇佣 Agent 的工厂，首月雇佣费半价优惠。', highlight: true },
  { icon: Gift, title: '评价赠 Token', text: '雇佣后提交真实评价的雇主，赠送额外 Token 奖励。' },
  { icon: FlaskConical, title: '7 天免费沙箱试用', text: '先验证再签约，零风险确认工匠与产线的适配度。' },
]

function Panel({
  side,
  hud,
  title,
  items,
  accent,
  inView,
}: {
  side: 'left' | 'right'
  hud: string
  title: string
  items: IncentiveItem[]
  accent: 'violet' | 'cyan'
  inView: boolean
}) {
  const isViolet = accent === 'violet'
  const discount = useCountUp(50, { duration: 1.2, delay: 0.9, started: inView && !isViolet })

  return (
    <motion.div
      initial={{ opacity: 0, x: side === 'left' ? -60 : 60 }}
      animate={inView ? { opacity: 1, x: 0 } : {}}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
      className={`glass-panel relative flex-1 rounded-2xl border-t-2 p-7 md:p-9 ${
        isViolet ? 'border-t-nebula-violet' : 'border-t-pulse-cyan'
      }`}
    >
      <p className={`hud-label ${isViolet ? 'text-nebula-violet' : 'text-pulse-cyan'}`}>{hud}</p>
      <h3 className="mt-2 font-display text-xl font-bold text-ink-primary md:text-2xl">{title}</h3>

      <div className="mt-7 space-y-6">
        {items.map((it, i) => (
          <motion.div
            key={it.title}
            initial={{ opacity: 0, y: 16 }}
            animate={inView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.5, delay: 0.3 + i * 0.08, ease: [0.16, 1, 0.3, 1] }}
            className="flex gap-4"
          >
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${
                isViolet ? 'border-nebula-violet/40 bg-nebula-violet/10' : 'border-pulse-cyan/40 bg-pulse-cyan/10'
              }`}
            >
              <it.icon className={`h-4 w-4 ${isViolet ? 'text-nebula-violet' : 'text-pulse-cyan'}`} />
            </span>
            <div className="flex-1">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <h4 className="text-sm font-bold text-ink-primary md:text-base">{it.title}</h4>
                {it.highlight && (
                  <motion.span
                    animate={inView ? { opacity: [1, 0.35, 1] } : {}}
                    transition={{ duration: 0.5, delay: 2.1, times: [0, 0.5, 1] }}
                    className="font-grotesk text-2xl font-bold text-amber-gradient md:text-3xl"
                  >
                    {discount}%
                    <span className="ml-1 font-sans text-xs font-normal text-forge-amber">OFF</span>
                  </motion.span>
                )}
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{it.text}</p>
            </div>
          </motion.div>
        ))}
      </div>
    </motion.div>
  )
}

export default function DualIncentive() {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, margin: '-120px' })

  return (
    <section className="relative bg-void">
      <div className="mx-auto max-w-site px-5 py-[72px] md:px-12 md:py-[120px]">
        <SectionHeader
          hud="DUAL-SIDED FLYWHEEL"
          title="双边激励 — 供给侧与需求侧"
          subtitle="供给侧让利换忠诚，需求侧让利换规模，中间的乘号，就是双边市场的飞轮。"
        />

        <div ref={ref} className="relative mt-14 flex flex-col items-stretch gap-6 lg:flex-row lg:items-center">
          <Panel side="left" hud="SUPPLY SIDE · 老师傅激励" title="让老师傅愿意来、留下来" items={SUPPLY} accent="violet" inView={inView} />

          {/* connector × */}
          <motion.div
            initial={{ scale: 0, rotate: -90 }}
            animate={inView ? { scale: 1, rotate: 0 } : {}}
            transition={{ type: 'spring', stiffness: 180, damping: 12, delay: 0.5 }}
            className="relative z-10 mx-auto flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-forge-amber/50 bg-void"
          >
            <motion.span
              animate={inView ? { rotate: 360 } : {}}
              transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
              className="absolute inset-0 rounded-full border border-dashed border-forge-amber/30"
            />
            <X className="h-6 w-6 text-forge-amber" strokeWidth={3} />
          </motion.div>

          <Panel side="right" hud="DEMAND SIDE · 雇主激励" title="让工厂敢试、敢雇、敢评" items={DEMAND} accent="cyan" inView={inView} />
        </div>
      </div>
    </section>
  )
}
