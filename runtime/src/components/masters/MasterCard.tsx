import { motion } from 'framer-motion'
import { Link } from 'react-router'
import { ArrowRight, Bot, Coins, Medal } from 'lucide-react'
import HudCorner from '@/components/HudCorner'
import RatingStars from '@/components/RatingStars'
import ReputationBar from '@/components/masters/ReputationBar'
import type { MasterListItem } from '@/components/masters/masters-trpc'

/** 老师傅列表卡片：署名 / 行业 / 工匠数 / 均分 / 累计收益 / 声望条 */
export default function MasterCard({ master, index = 0 }: { master: MasterListItem; index?: number }) {
  return (
    <motion.article
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.55, delay: (index % 3) * 0.08, ease: [0.16, 1, 0.3, 1] }}
      whileHover={{ y: -6 }}
      className="glass-panel group relative flex flex-col rounded-2xl p-6 transition-shadow duration-300 hover:shadow-[0_0_24px_rgba(124,92,255,0.35)]"
    >
      <HudCorner />
      {/* 署名区 */}
      <div className="flex items-start gap-4">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-nebula-violet/40 bg-nebula-violet/10 font-display text-xl font-bold text-nebula-violet">
          {master.name.slice(0, 1)}
        </span>
        <div className="min-w-0">
          <p className="hud-label text-[9px] text-pulse-cyan/70">MASTER #{String(master.id).padStart(3, '0')}</p>
          <h3 className="mt-1 font-display text-lg font-bold leading-snug text-ink-primary">{master.signature}</h3>
          <p className="mt-1 truncate text-xs text-ink-faint">
            {master.title ?? master.specialty} · {master.yearsExperience} 年经验
          </p>
        </div>
      </div>

      {/* 指标区 */}
      <div className="mt-5 grid grid-cols-3 gap-3 border-t border-line-subtle pt-4">
        <div>
          <p className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            <Bot className="h-3 w-3" /> 工匠
          </p>
          <p className="mt-1 font-grotesk text-lg font-bold text-ink-primary">
            {master.agentCount}
            <span className="ml-1 text-[11px] font-normal text-jade-green">{master.activeAgentCount} 在岗</span>
          </p>
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">均分</p>
          <p className="mt-1.5">
            <RatingStars rating={master.avgRating} showValue />
          </p>
        </div>
        <div>
          <p className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            <Coins className="h-3 w-3" /> 累计收益
          </p>
          <p className="mt-1 font-grotesk text-lg font-bold text-forge-amber">
            {master.totalEarnings.toLocaleString()}
            <span className="ml-1 text-[11px] font-normal text-ink-faint">Token</span>
          </p>
        </div>
      </div>

      {/* 声望 + CTA */}
      <div className="mt-4 flex items-center justify-between border-t border-line-subtle pt-4">
        <span className="flex items-center gap-2">
          <Medal className="h-3.5 w-3.5 text-nebula-violet" />
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">声望</span>
          <ReputationBar value={master.reputation} />
        </span>
        <Link
          to={`/masters/${master.id}`}
          className="inline-flex items-center gap-1 text-xs text-pulse-cyan transition-all group-hover:gap-2 hover:text-ink-primary"
        >
          进入看板 <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </motion.article>
  )
}
