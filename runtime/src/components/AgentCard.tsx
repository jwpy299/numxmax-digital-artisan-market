import { motion } from 'framer-motion'
import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import type { Agent } from '@/data/agents'
import TagChip from '@/components/TagChip'
import PriceTicker from '@/components/PriceTicker'
import RatingStars from '@/components/RatingStars'
import HudCorner from '@/components/HudCorner'

interface AgentCardProps {
  agent: Agent
  className?: string
}

export default function AgentCard({ agent, className }: AgentCardProps) {
  return (
    <motion.div
      whileHover={{ y: -6 }}
      transition={{ type: 'spring', stiffness: 300, damping: 22 }}
      className={`group relative w-[280px] shrink-0 overflow-hidden rounded-2xl glass-panel transition-shadow duration-300 hover:shadow-[0_0_24px_rgba(124,92,255,0.35)] ${className ?? ''}`}
    >
      <HudCorner />
      {/* avatar with nebula halo */}
      <div className="relative h-[200px] overflow-hidden">
        <div className="nebula-halo absolute inset-0" />
        <img
          src={agent.avatar}
          alt={agent.name}
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.06]"
        />
        <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[#0A0F1E] to-transparent" />
        <span className="absolute left-4 top-3 rounded-full glass-panel px-2 py-0.5 font-mono text-[10px] tracking-widest text-pulse-cyan">
          {agent.code}
        </span>
      </div>

      <div className="relative p-5 pt-3">
        <div className="flex items-baseline justify-between">
          <h3 className="font-display text-xl font-bold text-ink-primary">{agent.name}</h3>
          <RatingStars rating={agent.rating} />
        </div>
        <p className="mt-1 text-xs text-ink-faint">{agent.master}</p>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {agent.tags.slice(0, 3).map((t) => (
            <TagChip key={t} label={t} className="px-2 py-0.5 text-[11px]" />
          ))}
        </div>

        <div className="mt-4 flex items-end justify-between border-t border-line-subtle pt-3">
          <div>
            <PriceTicker value={agent.price} className="text-lg" />
            <p className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              {agent.skills} SKILLS · {agent.tasks.toLocaleString()} TASKS
            </p>
          </div>
        </div>

        {/* hover reveal CTA */}
        <div className="absolute inset-x-0 bottom-0 translate-y-full transition-transform duration-300 ease-out group-hover:translate-y-0">
          <Link
            to={`/market/agent/${agent.id}`}
            className="flex h-11 items-center justify-center gap-2 bg-brand-gradient text-sm font-medium text-white"
          >
            查看详情 <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </motion.div>
  )
}
