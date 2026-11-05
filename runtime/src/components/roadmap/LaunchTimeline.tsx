import { useRef, useState } from 'react'
import { motion, useInView } from 'framer-motion'
import { PenTool, Code2, Cable, Rocket } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import SectionHeader from '@/components/SectionHeader'
import { cn } from '@/lib/utils'

interface Week {
  id: string
  week: string
  stage: string
  icon: LucideIcon
  tasks: string[]
  launch?: boolean
}

const WEEKS: Week[] = [
  { id: 'w1', week: 'W1', stage: '设计', icon: PenTool, tasks: ['完成 Agent 全生命周期管理的前后端设计', '五大服务模块接口契约冻结'] },
  { id: 'w23', week: 'W2–W3', stage: '开发', icon: Code2, tasks: ['Agent 管理服务开发', '定价引擎与规则引擎开发', '雇佣结算服务开发'] },
  { id: 'w4', week: 'W4', stage: '联调', icon: Cable, tasks: ['前端 Agent 招聘页面联调', '后端服务联调测试', '种子数据与结算流水校验'] },
  { id: 'w5', week: 'W5', stage: '上线', icon: Rocket, launch: true, tasks: ['首批 Agent 上架', '启动「NumX Max·数字匠市」内测', '首批老师傅与工厂入驻'] },
]

function AxisNode({ w, index, inView }: { w: Week; index: number; inView: boolean }) {
  const [hover, setHover] = useState(false)
  const Icon = w.icon
  const delay = 0.3 + index * 0.35

  return (
    <div className="relative flex flex-col items-center" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {/* node dot */}
      <motion.div
        initial={{ scale: 0 }}
        animate={inView ? { scale: 1 } : {}}
        transition={{ type: 'spring', stiffness: 260, damping: 14, delay }}
        className={cn(
          'relative z-10 flex items-center justify-center rounded-full border bg-void',
          w.launch
            ? 'h-16 w-16 border-forge-amber/70 shadow-[0_0_24px_rgba(245,165,36,0.45)]'
            : 'h-11 w-11 border-nebula-violet/60 shadow-[0_0_14px_rgba(124,92,255,0.4)]',
        )}
      >
        {w.launch && (
          <motion.span
            animate={{ scale: [1, 1.5], opacity: [0.6, 0] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }}
            className="absolute inset-0 rounded-full border border-forge-amber/60"
          />
        )}
        <Icon className={cn(w.launch ? 'h-6 w-6 text-forge-amber' : 'h-4 w-4 text-nebula-violet')} />
      </motion.div>

      {/* card */}
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={inView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.5, delay: delay + 0.15, ease: [0.16, 1, 0.3, 1] }}
        className={cn(
          'glass-panel mt-5 w-full rounded-2xl p-5 text-center transition-shadow duration-300',
          w.launch && 'border-forge-amber/40 hover:shadow-[0_0_24px_rgba(245,165,36,0.3)]',
        )}
      >
        <p className={cn('font-grotesk text-xl font-bold', w.launch ? 'text-amber-gradient' : 'text-brand-gradient')}>{w.week}</p>
        <p className="mt-1 font-display text-base font-bold text-ink-primary">{w.stage}</p>
        {w.launch && (
          <span className="mt-2 inline-block rounded-full border border-forge-amber/50 bg-forge-amber/10 px-2.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-forge-amber">
            Launch
          </span>
        )}
        <p className="mt-2.5 text-[12px] leading-relaxed text-ink-secondary">{w.tasks[0]}</p>
      </motion.div>

      {/* hover tooltip */}
      {hover && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="glass-panel pointer-events-none absolute -top-8 z-20 w-52 -translate-y-full rounded-xl p-3.5 text-left"
        >
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-pulse-cyan">{w.week} · {w.stage}</p>
          <ul className="mt-2 space-y-1.5">
            {w.tasks.map((t) => (
              <li key={t} className="flex gap-1.5 text-[11px] leading-relaxed text-ink-secondary">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-pulse-cyan" />
                {t}
              </li>
            ))}
          </ul>
        </motion.div>
      )}
    </div>
  )
}

export default function LaunchTimeline() {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, margin: '-120px' })

  return (
    <section className="relative bg-void">
      <div className="mx-auto max-w-site px-5 py-[72px] md:px-12 md:py-[120px]">
        <SectionHeader
          hud="LAUNCH TIMELINE"
          title="五周上线时间轴"
          subtitle="从设计冻结到内测上线，五周走完一个数字劳动力市场的从 0 到 1。"
        />

        {/* desktop: horizontal */}
        <div ref={ref} className="relative mt-20 hidden md:block">
          {/* axis */}
          <div className="absolute left-[10%] right-[10%] top-[22px] h-px bg-panel lg:top-[22px]" />
          <motion.div
            initial={{ scaleX: 0 }}
            animate={inView ? { scaleX: 1 } : {}}
            transition={{ duration: 1.8, ease: 'easeInOut' }}
            className="absolute left-[10%] right-[10%] top-[22px] h-px origin-left bg-gradient-to-r from-nebula-violet via-nebula-magenta to-pulse-cyan"
            style={{ boxShadow: '0 0 8px rgba(124,92,255,0.5)' }}
          />
          {/* W5 axis special offset: launch node taller, so axis passes at same 22px for all */}
          <div className="relative grid grid-cols-4 gap-6">
            {WEEKS.map((w, i) => (
              <div key={w.id} className={cn(w.launch && '-mt-[10px]')}>
                <AxisNode w={w} index={i} inView={inView} />
              </div>
            ))}
          </div>
        </div>

        {/* mobile: vertical */}
        <div className="relative mt-14 md:hidden">
          <motion.div
            initial={{ scaleY: 0 }}
            whileInView={{ scaleY: 1 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 1.6, ease: 'easeInOut' }}
            className="absolute bottom-8 left-[21px] top-2 w-px origin-top bg-gradient-to-b from-nebula-violet via-nebula-magenta to-forge-amber"
          />
          <div className="space-y-10">
            {WEEKS.map((w, i) => (
              <motion.div
                key={w.id}
                initial={{ opacity: 0, x: 30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ duration: 0.6, delay: i * 0.1, ease: [0.16, 1, 0.3, 1] }}
                className="relative flex gap-5 pl-1"
              >
                <span
                  className={cn(
                    'relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-void',
                    w.launch ? 'border-forge-amber/70' : 'border-nebula-violet/60',
                  )}
                >
                  <w.icon className={cn('h-4 w-4', w.launch ? 'text-forge-amber' : 'text-nebula-violet')} />
                </span>
                <div className="glass-panel flex-1 rounded-2xl p-4">
                  <div className="flex items-baseline gap-2">
                    <span className={cn('font-grotesk text-lg font-bold', w.launch ? 'text-amber-gradient' : 'text-brand-gradient')}>{w.week}</span>
                    <span className="font-display text-sm font-bold text-ink-primary">{w.stage}</span>
                    {w.launch && (
                      <span className="rounded-full border border-forge-amber/50 bg-forge-amber/10 px-2 py-0.5 font-mono text-[8px] uppercase tracking-[0.18em] text-forge-amber">
                        Launch
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">{w.tasks[0]}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
