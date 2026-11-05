import { useState } from 'react'
import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import SectionHeader from '@/components/SectionHeader'
import HudCorner from '@/components/HudCorner'
import { cn } from '@/lib/utils'

const ROWS: Array<{ dim: string; legacy: string; nebula: ReactNode }> = [
  {
    dim: '交互方式',
    legacy: '按次调用，每次指定具体技能',
    nebula: (
      <>
        长期雇佣，只需告诉 Agent <strong className="text-pulse-cyan">「做什么」</strong>
      </>
    ),
  },
  {
    dim: '定价方式',
    legacy: '按次付费',
    nebula: (
      <>
        <strong className="text-nebula-violet">按月/按年付费</strong>，价格由市场供需决定
      </>
    ),
  },
  {
    dim: '学习能力',
    legacy: '无记忆，每次独立调用',
    nebula: (
      <>
        有<strong className="text-pulse-cyan">工作记忆</strong>，越用越懂雇主
      </>
    ),
  },
  {
    dim: '责任归属',
    legacy: '单次技能的责任',
    nebula: (
      <>
        <strong className="text-nebula-violet">Agent 整体表现</strong>的责任
      </>
    ),
  },
  {
    dim: '价值积累',
    legacy: '技能本身不会增值',
    nebula: (
      <>
        Agent 经验越丰富，<strong className="text-pulse-cyan">身价越高</strong>
      </>
    ),
  },
]

type Side = 'legacy' | 'nebula'

export default function ParadigmSection() {
  const [side, setSide] = useState<Side>('nebula')

  return (
    <section className="bg-deep py-[72px] md:py-[120px]">
      <div className="mx-auto grid max-w-site gap-12 px-5 md:px-12 lg:grid-cols-[2fr_3fr] lg:gap-16">
        <div className="flex flex-col justify-center">
          <SectionHeader align="left" hud="PARADIGM SHIFT" title="一次范式升级" />
          <motion.p
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.7, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="mt-6 text-[15px] leading-[1.75] text-ink-secondary"
          >
            过去的工业软件把老师傅的经验拆成一个个孤立技能，按次售卖。NumX Max·数字匠市把经验重新组装成「人」——一位有身份、有记忆、有信用、能为你持续工作的数字工匠。
          </motion.p>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="relative rounded-2xl glass-panel p-6 md:p-8"
        >
          <HudCorner />
          {/* segmented control */}
          <div className="relative mx-auto grid w-full max-w-md grid-cols-2 rounded-full border border-line-subtle p-1">
            {(['legacy', 'nebula'] as Side[]).map((s) => (
              <button
                key={s}
                onClick={() => setSide(s)}
                className={cn(
                  'relative z-10 rounded-full py-2 text-sm transition-colors duration-300',
                  side === s ? 'text-ink-primary' : 'text-ink-faint hover:text-ink-secondary',
                )}
              >
                {side === s && (
                  <motion.span
                    layoutId="paradigm-pill"
                    className="absolute inset-0 -z-10 rounded-full bg-brand-gradient opacity-80"
                    transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                  />
                )}
                {s === 'legacy' ? '传统技能调用' : 'NumX Max·数字匠市'}
              </button>
            ))}
          </div>

          {/* comparison table */}
          <div className="mt-8">
            <div className="grid grid-cols-[76px_1fr_1fr] gap-x-3 pb-3 md:grid-cols-[96px_1fr_1fr]">
              <span className="text-[13px] text-ink-faint">维度</span>
              <span className="text-[13px] text-ink-faint">传统技能调用</span>
              <span className="text-[13px] text-ink-faint">NumX Max·数字匠市</span>
            </div>
            {ROWS.map((row, i) => (
              <motion.div
                key={row.dim}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ duration: 0.6, delay: i * 0.12, ease: [0.16, 1, 0.3, 1] }}
                className="relative grid grid-cols-[76px_1fr_1fr] items-center gap-x-3 py-4 md:grid-cols-[96px_1fr_1fr]"
              >
                <motion.span
                  initial={{ scaleX: 0 }}
                  whileInView={{ scaleX: 1 }}
                  viewport={{ once: true, margin: '-60px' }}
                  transition={{ duration: 0.6, delay: i * 0.12 }}
                  style={{ transformOrigin: 'left' }}
                  className="absolute inset-x-0 top-0 h-px bg-line-subtle"
                />
                <span className="text-[13px] text-ink-faint">{row.dim}</span>
                <span
                  className={cn(
                    'text-sm leading-relaxed transition-all duration-500',
                    side === 'legacy' ? 'text-ink-secondary blur-0 opacity-100' : 'text-ink-secondary/60 opacity-35 blur-[2px] line-through decoration-ink-faint/40',
                  )}
                >
                  {row.legacy}
                </span>
                <span
                  className={cn(
                    'relative text-sm leading-relaxed text-ink-primary transition-all duration-500',
                    side === 'nebula' ? 'blur-0 opacity-100' : 'opacity-35 blur-[2px]',
                  )}
                >
                  {side === 'nebula' && (
                    <motion.span
                      initial={{ x: '-100%', opacity: 0 }}
                      animate={{ x: '100%', opacity: [0, 1, 0] }}
                      transition={{ duration: 0.8, ease: 'easeInOut' }}
                      className="pointer-events-none absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent via-pulse-cyan/15 to-transparent"
                    />
                  )}
                  {row.nebula}
                </span>
              </motion.div>
            ))}
          </div>

          <p className="mt-8 border-t border-line-subtle pt-6 text-center font-display text-lg text-ink-primary md:text-[22px]">
            你买的不再是一次回答，而是一位<span className="text-brand-gradient">会持续成长的员工</span>。
          </p>
        </motion.div>
      </div>
    </section>
  )
}
