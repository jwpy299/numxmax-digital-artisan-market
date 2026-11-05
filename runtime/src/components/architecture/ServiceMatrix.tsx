import { useEffect, useState } from 'react'
import { motion, useInView } from 'framer-motion'
import { useRef } from 'react'
import { Bot, Cog, Gauge, BrainCircuit, Coins } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import SectionHeader from '@/components/SectionHeader'
import HudCorner from '@/components/HudCorner'
import { cn } from '@/lib/utils'

interface Service {
  code: string
  name: string
  duty: string
  stack: string[]
  icon: LucideIcon
}

const SERVICES: Service[] = [
  {
    code: 'SVC-01',
    name: 'Agent 管理服务',
    duty: 'Agent 创建、上架、搜索、定价、雇佣管理',
    stack: ['FastAPI', 'PostgreSQL'],
    icon: Bot,
  },
  {
    code: 'SVC-02',
    name: 'Agent 执行引擎',
    duty: '任务解析、技能调度、执行监控',
    stack: ['OpenClaw 运行时', '工作流引擎'],
    icon: Cog,
  },
  {
    code: 'SVC-03',
    name: 'Agent 定价引擎',
    duty: '初始定价、动态调价、市场分析',
    stack: ['Python 定时任务', '规则引擎'],
    icon: Gauge,
  },
  {
    code: 'SVC-04',
    name: 'Agent 记忆服务',
    duty: '工作记忆存储、检索、更新',
    stack: ['向量数据库', 'HermesAgent 记忆系统'],
    icon: BrainCircuit,
  },
  {
    code: 'SVC-05',
    name: 'Agent 雇佣结算',
    duty: '雇佣费用结算、技能调用分账',
    stack: ['Token 经济引擎', '决策基因链'],
    icon: Coins,
  },
]

/** typewriter effect for the mono service code */
function Typewriter({ text, started, delay }: { text: string; started: boolean; delay: number }) {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!started) return
    let i = 0
    const timer = window.setTimeout(() => {
      const iv = window.setInterval(() => {
        i += 1
        setN(i)
        if (i >= text.length) window.clearInterval(iv)
      }, 40)
    }, delay * 1000)
    return () => window.clearTimeout(timer)
  }, [started, text, delay])
  return (
    <span className="font-mono text-xs tracking-[0.18em] text-ink-faint">
      {text.slice(0, n)}
      {started && n < text.length && <span className="text-pulse-cyan">▌</span>}
    </span>
  )
}

function ServiceCard({ svc, index }: { svc: Service; index: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, margin: '-80px' })
  const Icon = svc.icon

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 50 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.7, delay: index * 0.1, ease: [0.16, 1, 0.3, 1] }}
      whileHover={{ y: -6 }}
      className={cn(
        'group glass-panel relative rounded-2xl p-7 transition-shadow duration-300',
        'hover:shadow-[0_0_24px_rgba(34,211,238,0.22)]',
      )}
    >
      <HudCorner />
      <div className="flex items-start justify-between">
        <Typewriter text={svc.code} started={inView} delay={index * 0.1 + 0.3} />
        <span className="pulse-halo flex h-11 w-11 items-center justify-center rounded-xl border border-nebula-violet/40 bg-nebula-violet/10">
          <Icon className="h-5 w-5 text-nebula-violet" />
        </span>
      </div>
      <h3 className="mt-5 font-display text-lg font-bold tracking-[0.01em] text-ink-primary md:text-[22px]">
        {svc.name}
      </h3>
      <p className="mt-2.5 text-[13px] leading-relaxed text-ink-secondary md:text-sm">{svc.duty}</p>
      <div className="mt-5 flex flex-wrap gap-2">
        {svc.stack.map((t) => (
          <span
            key={t}
            className="rounded-full border border-forge-amber/40 px-2.5 py-1 font-mono text-[10px] tracking-wide text-forge-amber transition-colors duration-300 group-hover:bg-forge-amber/[0.08]"
          >
            {t}
          </span>
        ))}
      </div>
    </motion.div>
  )
}

export default function ServiceMatrix() {
  return (
    <section className="relative bg-deep">
      <div className="mx-auto max-w-site px-5 py-[72px] md:px-12 md:py-[120px]">
        <SectionHeader
          hud="CORE SERVICES"
          title="五大核心服务模块"
          subtitle="从孵化上架到执行结算，每个服务模块各司其职，共同支撑数字工匠的完整生命周期。"
        />
        {/* asymmetric grid: 3 + 2 */}
        <div className="mt-14 grid gap-6 md:grid-cols-2 lg:grid-cols-6">
          {SERVICES.map((svc, i) => (
            <div key={svc.code} className={i < 3 ? 'lg:col-span-2' : 'lg:col-span-3'}>
              <ServiceCard svc={svc} index={i} />
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
