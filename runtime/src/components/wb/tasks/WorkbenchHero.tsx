import { motion } from 'framer-motion'
import { Activity, CheckCircle2, Coins, Users } from 'lucide-react'
import CountUp from '@/components/wb/tasks/CountUp'

interface WorkbenchHeroProps {
  onlineCount: number | null
  runningCount: number
  todayCompleted: number | null
  monthlyTokens: number | null
}

const TITLE = '智能工作台'

export default function WorkbenchHero({ onlineCount, runningCount, todayCompleted, monthlyTokens }: WorkbenchHeroProps) {
  const metrics = [
    { icon: Users, label: '在线工匠', value: onlineCount, suffix: '' },
    { icon: Activity, label: '执行中任务', value: runningCount, suffix: '' },
    { icon: CheckCircle2, label: '累计完成任务', value: todayCompleted, suffix: '' },
    { icon: Coins, label: '任务消耗 Token', value: monthlyTokens, suffix: '' },
  ]

  return (
    <section className="relative overflow-hidden bg-void">
      {/* 背景数据流光效 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{
          backgroundImage: 'url(/workbench-glow.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          maskImage: 'linear-gradient(to bottom, black 30%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, black 30%, transparent 100%)',
        }}
      />
      <div aria-hidden className="nebula-halo pointer-events-none absolute -top-32 left-1/2 h-96 w-[720px] -translate-x-1/2" />

      <div className="relative mx-auto max-w-site px-5 pb-14 pt-16 md:px-12 md:pb-16 md:pt-20">
        <p className="hud-label text-pulse-cyan/80">SMART WORKBENCH · EMPLOYER CONSOLE</p>

        <div className="mt-4 flex flex-wrap items-center gap-4">
          <h1 className="font-display text-[32px] font-bold tracking-[0.02em] text-ink-primary md:text-[42px]">
            {TITLE.split('').map((ch, i) => (
              <motion.span
                key={i}
                className="inline-block"
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.08 * i, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              >
                {ch}
              </motion.span>
            ))}
          </h1>
          <span className="inline-flex items-center gap-2 rounded-full border border-pulse-cyan/40 bg-pulse-cyan/10 px-3 py-1 text-xs text-pulse-cyan">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-pulse-cyan opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-pulse-cyan" />
            </span>
            运行中
          </span>
        </div>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35, duration: 0.6 }}
          className="mt-4 max-w-xl text-[15px] leading-relaxed text-ink-secondary"
        >
          在这里向你的数字工匠下达任务。你只需说「做什么」，剩下的交给它。
        </motion.p>

        {/* 仪表条 */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, duration: 0.6 }}
          className="glass-panel mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-2xl lg:grid-cols-4"
        >
          {metrics.map((m) => (
            <div key={m.label} className="flex items-center gap-4 bg-panel/40 px-6 py-5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line-subtle bg-void/60 text-pulse-cyan">
                <m.icon className="h-[18px] w-[18px]" />
              </span>
              <span>
                <span className="block font-grotesk text-2xl font-bold leading-none text-ink-primary">
                  {m.value === null ? (
                    <span className="text-ink-faint">—</span>
                  ) : (
                    <CountUp value={m.value} />
                  )}
                  {m.suffix}
                </span>
                <span className="mt-1.5 block text-xs text-ink-faint">{m.label}</span>
              </span>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}
