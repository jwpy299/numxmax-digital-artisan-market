import { motion } from 'framer-motion'
import { Link } from 'react-router'
import { ArrowRight, BadgeCheck, Brain, Wrench } from 'lucide-react'
import HudCorner from '@/components/HudCorner'
import RatingStars from '@/components/RatingStars'
import TagChip from '@/components/TagChip'
import { cn } from '@/lib/utils'
import type { MasterAgentItem } from '@/components/masters/masters-trpc'

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '待审核', cls: 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber' },
  active: { label: '上架中', cls: 'border-jade-green/40 bg-jade-green/10 text-jade-green' },
  suspended: { label: '已下架', cls: 'border-ember-red/40 bg-ember-red/10 text-ember-red' },
}

/** 老师傅名下 Agent 卡片：头像 / 状态徽章 / 月薪 / 评分 / 任务数，点击进 Agent 详情 */
export default function MasterAgentCard({ agent, index = 0 }: { agent: MasterAgentItem; index?: number }) {
  const st = STATUS[agent.status] ?? STATUS.pending
  return (
    <motion.article
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.55, delay: (index % 3) * 0.08, ease: [0.16, 1, 0.3, 1] }}
      className="glass-panel group relative flex h-full flex-col overflow-hidden rounded-2xl transition-all duration-300 hover:-translate-y-1.5 hover:shadow-[0_0_24px_rgba(124,92,255,0.35)]"
    >
      <HudCorner />
      {/* 头像 */}
      <div className="relative h-36 overflow-hidden">
        <div className="nebula-halo absolute inset-0" />
        <img
          src={agent.avatar}
          alt={agent.name}
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.06]"
        />
        <div className="absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-[#0A0F1E] to-transparent" />
        <span className="glass-panel absolute left-3 top-3 rounded-full px-2 py-0.5 font-mono text-[10px] tracking-widest text-pulse-cyan">
          {agent.code}
        </span>
        <span className={cn('absolute right-3 top-3 rounded-full border px-2.5 py-0.5 text-[11px]', st.cls)}>
          {st.label}
        </span>
      </div>

      <div className="flex flex-1 flex-col p-5 pt-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="flex items-center gap-1.5 font-display text-lg font-bold text-ink-primary">
            {agent.name}
            {agent.certified && <BadgeCheck className="h-4 w-4 text-pulse-cyan" />}
          </h3>
          <RatingStars rating={agent.avgRating} />
        </div>
        <p className="mt-0.5 text-xs text-ink-faint">{agent.industry}</p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {agent.capabilityTags.slice(0, 3).map((t) => (
            <TagChip key={t} label={t} className="px-2 py-0.5 text-[11px]" />
          ))}
        </div>

        <div className="mt-3 flex items-center gap-4 font-mono text-[11px] text-ink-faint">
          <span className="flex items-center gap-1">
            <Wrench className="h-3 w-3" /> {agent.skillCount} 技能
          </span>
          <span className="flex items-center gap-1">
            <Brain className="h-3 w-3" /> {agent.memoryCount.toLocaleString()} 记忆
          </span>
          <span>{agent.tasksCompleted.toLocaleString()} 任务</span>
        </div>

        <div className="mt-4 flex items-end justify-between border-t border-line-subtle pt-3">
          <p className="font-grotesk text-lg font-bold text-forge-amber">
            {agent.monthlyPrice.toLocaleString()}
            <span className="ml-1 font-mono text-[10px] font-normal text-ink-faint">TOKEN / 月</span>
          </p>
          <Link
            to={`/market/agent/${agent.slug}`}
            className="inline-flex items-center gap-1 text-xs text-pulse-cyan transition-all hover:gap-2 hover:text-ink-primary"
          >
            查看工匠 <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </motion.article>
  )
}
