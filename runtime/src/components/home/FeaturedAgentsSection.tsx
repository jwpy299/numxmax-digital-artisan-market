import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { AGENTS } from '@/data/agents'
import AgentCard from '@/components/AgentCard'
import SectionHeader from '@/components/SectionHeader'

export default function FeaturedAgentsSection() {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragLimit, setDragLimit] = useState(0)

  useEffect(() => {
    const measure = () => {
      const el = trackRef.current
      if (!el) return
      setDragLimit(Math.max(0, el.scrollWidth - el.clientWidth))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  return (
    <section className="overflow-hidden bg-deep py-[72px] md:py-[120px]">
      <div className="mx-auto max-w-site px-5 md:px-12">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <SectionHeader
            align="left"
            hud="FEATURED ARTISANS"
            title="市场精选 · 明星数字工匠"
            subtitle="每一位都通过了 7 天沙箱实测，信用档案公开可查。"
          />
          <Link
            to="/market"
            className="group inline-flex items-center gap-2 text-sm text-pulse-cyan transition-colors hover:text-ink-primary"
          >
            查看全部
            <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
          </Link>
        </div>
      </div>

      {/* draggable card band, shows ~4.5 cards */}
      <div ref={trackRef} className="relative mt-12 overflow-hidden">
        <span className="animate-rec-badge pointer-events-none absolute left-2 top-1/2 z-10 hidden -translate-y-1/2 select-none rounded-full border border-forge-amber/50 bg-void/80 px-2 py-4 font-display text-sm font-bold tracking-[0.3em] text-forge-amber backdrop-blur md:block" style={{ writingMode: 'vertical-rl' }}>
          市场推荐
        </span>
        <motion.div
          initial={{ opacity: 0, x: 80 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto max-w-site px-5 md:px-12 md:pl-20"
        >
          <motion.div
            drag="x"
            dragConstraints={{ left: -dragLimit, right: 0 }}
            dragElastic={0.08}
            className="flex w-max cursor-grab gap-6 pb-4 active:cursor-grabbing"
          >
            {AGENTS.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </motion.div>
        </motion.div>
      </div>
    </section>
  )
}
