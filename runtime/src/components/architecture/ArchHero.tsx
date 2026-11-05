import { useRef } from 'react'
import { motion } from 'framer-motion'
import { skipToken } from '@tanstack/react-query'
import { trpc } from '@/providers/trpc'
import { useCountUp } from '@/hooks/useCountUp'
import HudCorner from '@/components/HudCorner'

const TECH_CHIPS = [
  'FastAPI',
  'PostgreSQL',
  'OpenClaw Runtime',
  '工作流引擎',
  '向量数据库',
  'HermesAgent',
  'Token 经济引擎',
  '决策基因链',
]

/** 设计稿静态降级数据（接口不可用时） */
const FALLBACK = {
  agentCount: 6,
  hireTotal: 11,
  platformRevenue: 173520,
  totalVolume: 1084200,
  live: false,
}

const TITLE_WORDS = ['技术', '架构']

function LiveStat({
  label,
  value,
  suffix,
  live,
  delay,
}: {
  label: string
  value: number
  suffix: string
  live: boolean
  delay: number
}) {
  const text = useCountUp(value, { duration: 1.4, delay })
  return (
    <div className="relative px-5 py-4 md:px-7">
      <p className="hud-label text-[10px] text-ink-faint">{label}</p>
      <p className="mt-2 font-grotesk text-2xl font-bold tabular-nums text-ink-primary md:text-3xl">
        {text}
        <span className="ml-1 font-mono text-xs font-normal text-ink-faint">{suffix}</span>
      </p>
      {live && (
        <span className="absolute right-3 top-3 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-jade-green">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-jade-green" />
          Live
        </span>
      )}
    </div>
  )
}

export default function ArchHero() {
  const panelRef = useRef<HTMLDivElement>(null)
  // settlement.overview 自 sec-wave2 起为管理员专用（.input(tokenInput) + requireAdmin），
  // 本页是门户公开页、无管理员会话 → 供不出合法 input。用 skipToken 显式声明「不发起调用」
  // （此前传 undefined：类型不合法且请求必被 zod 拒绝，结果同样是取不到 data 而走 FALLBACK，渲染输出不变）。
  const { data, isError } = trpc.settlement.overview.useQuery(skipToken, {
    retry: 1,
    refetchOnWindowFocus: false,
  })

  const stats = data && !isError
    ? {
        agentCount: data.agentCount,
        hireTotal: data.hireTotal,
        platformRevenue: data.platformRevenue,
        totalVolume: data.totalVolume,
        live: true,
      }
    : FALLBACK

  const onMouseMove = (e: React.MouseEvent) => {
    const el = panelRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width - 0.5) * 12
    const y = ((e.clientY - r.top) / r.height - 0.5) * 12
    el.style.transform = `translate(${x}px, ${y}px)`
  }
  const onMouseLeave = () => {
    if (panelRef.current) panelRef.current.style.transform = 'translate(0,0)'
  }

  return (
    <section
      className="relative overflow-hidden bg-void"
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      {/* intensified blueprint grid (opacity 0.07), mouse parallax */}
      <div
        ref={panelRef}
        aria-hidden
        className="pointer-events-none absolute -inset-6 transition-transform duration-300 ease-out"
        style={{
          backgroundImage:
            'linear-gradient(rgba(124,140,222,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(124,140,222,0.07) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />
      <div className="nebula-halo pointer-events-none absolute -top-40 left-1/2 h-96 w-[900px] -translate-x-1/2" />

      <div className="relative mx-auto max-w-site px-5 pb-16 pt-20 md:px-12 md:pb-20 md:pt-24">
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6 }}
          className="hud-label text-pulse-cyan/80"
        >
          SYSTEM ARCHITECTURE · BLUEPRINT
        </motion.p>

        <h1 className="mt-4 font-display text-[32px] font-bold leading-[1.2] tracking-[0.02em] text-ink-primary md:text-5xl">
          {TITLE_WORDS.map((w, i) => (
            <motion.span
              key={w}
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.1 + i * 0.08, ease: [0.16, 1, 0.3, 1] }}
              className="mr-2 inline-block last:mr-0"
            >
              {w}
            </motion.span>
          ))}
        </h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="mt-5 max-w-xl text-[15px] leading-relaxed text-ink-secondary md:text-base"
        >
          五大服务模块，支撑一位数字工匠从孵化到进化的完整生命。
        </motion.p>

        {/* tech chips */}
        <div className="mt-8 flex flex-wrap gap-2.5">
          {TECH_CHIPS.map((chip, i) => (
            <motion.span
              key={chip}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, delay: 0.5 + i * 0.04, ease: [0.16, 1, 0.3, 1] }}
              className="rounded-full border border-line-subtle bg-panel/40 px-3.5 py-1.5 font-mono text-[11px] tracking-wide text-ink-secondary"
            >
              {chip}
            </motion.span>
          ))}
        </div>

        {/* live operations pulse (settlement.overview, static fallback) */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.85, ease: [0.16, 1, 0.3, 1] }}
          className="glass-panel relative mt-12 grid grid-cols-2 divide-line-subtle rounded-2xl md:grid-cols-4 md:divide-x"
        >
          <HudCorner />
          <LiveStat label="在线数字工匠" value={stats.agentCount} suffix="位" live={stats.live} delay={1.0} />
          <LiveStat label="累计雇佣合约" value={stats.hireTotal} suffix="份" live={stats.live} delay={1.1} />
          <LiveStat label="平台佣金" value={stats.platformRevenue} suffix="Token" live={stats.live} delay={1.2} />
          <LiveStat label="Token 流水规模" value={stats.totalVolume} suffix="Token" live={stats.live} delay={1.3} />
        </motion.div>
      </div>
    </section>
  )
}
