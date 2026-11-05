import { motion } from 'framer-motion'
import AgentIpImage from '@/components/market/AgentIpImage'
import type { MarketAgent } from '@/components/market/types'
import { formatToken } from '@/components/market/types'
import TagChip from '@/components/TagChip'
import RatingStars from '@/components/RatingStars'
import HudCorner from '@/components/HudCorner'
import { cn } from '@/lib/utils'
import { CertBadge, HireCtas } from '@/components/market/WorkcardBits'

// iter96 熊猫 IP 3D 形象：角色化渲染图替代通用 three.js 数字人，首屏不再背 three
const STATUS_META: Record<string, { label: string; dot: string }> = {
  active: { label: '可雇佣', dot: 'bg-jade-green' },
  pending: { label: '试用中', dot: 'bg-forge-amber' },
  suspended: { label: '执行中', dot: 'bg-pulse-cyan' },
}

interface MarketAgentCardProps {
  agent: MarketAgent
  className?: string
}

/** Rich marketplace card: avatar, badges, stats triplet, price, hover overlay */
export default function MarketAgentCard({ agent, className }: MarketAgentCardProps) {
  const status = STATUS_META[agent.status] ?? STATUS_META.active
  const extraTags = Math.max(0, agent.tags.length - 3)

  return (
    <motion.div
      layout="position"
      whileHover={{ y: -6 }}
      transition={{ type: 'spring', stiffness: 260, damping: 26 }}
      className={cn(
        'cyber-glow-card group relative flex h-full flex-col overflow-hidden rounded-2xl glass-panel',
        className,
      )}
    >
      <HudCorner />

      {/* iter96 熊猫 IP 3D 形象（角色化渲染图）；原 avatar 兜底 */}
      <div className="relative aspect-[16/10] overflow-hidden">
        <div className="nebula-halo absolute inset-0" />
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-b from-[#101a2e] to-[#0A0F1E] transition-transform duration-500 group-hover:scale-[1.05]">
          <AgentIpImage
            tags={agent.tags}
            code={agent.code}
            alt={agent.name}
            fallback={agent.avatar}
            className="h-full w-auto object-contain drop-shadow-[0_8px_24px_rgba(56,225,255,0.25)]"
          />
        </div>
        <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-[#0A0F1E] to-transparent" />
        <span className="absolute left-4 top-3 rounded-full glass-panel px-2 py-0.5 font-mono text-[10px] tracking-widest text-pulse-cyan">
          {agent.code}
        </span>
        <span className="absolute right-4 top-3 inline-flex items-center gap-1.5 rounded-full glass-panel px-2.5 py-1 text-[11px] text-ink-secondary">
          <span className={cn('h-1.5 w-1.5 rounded-full', status.dot)} />
          {status.label}
        </span>
      </div>

      <div className="relative flex flex-1 flex-col p-6 pt-3">
        {/* name row */}
        <div className="flex items-center gap-2">
          <h3 className="font-display text-[22px] font-bold text-ink-primary">{agent.name}</h3>
          {agent.recommended && (
            <span className="animate-rec-badge rounded-full border border-forge-amber/50 bg-forge-amber/10 px-2 py-0.5 text-[10px] font-medium text-forge-amber">
              市场推荐
            </span>
          )}
          <CertBadge certified={agent.certified} />
        </div>
        <p className="mt-1 text-[13px] text-ink-secondary">{agent.masterLine}</p>

        {/* capability tags */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {agent.tags.slice(0, 3).map((t) => (
            <TagChip key={t} label={t} className="px-2 py-0.5 text-[11px]" />
          ))}
          {extraTags > 0 && (
            <span className="rounded-full border border-line-subtle px-2 py-0.5 font-mono text-[11px] text-ink-faint">
              +{extraTags}
            </span>
          )}
        </div>

        {/* stats triplet */}
        <div className="mt-4 grid grid-cols-3 gap-2 border-t border-line-subtle pt-4">
          <div>
            <p className="font-grotesk text-lg font-bold text-ink-primary">{agent.skillCount}</p>
            <p className="mt-0.5 text-[11px] text-ink-faint">项技能</p>
          </div>
          <div>
            <p className="font-grotesk text-lg font-bold text-ink-primary">
              {agent.tasksCompleted.toLocaleString('zh-CN')}
            </p>
            <p className="mt-0.5 text-[11px] text-ink-faint">累计任务</p>
          </div>
          <div>
            <p className="font-grotesk text-lg font-bold text-jade-green">
              {agent.successRate > 0 ? `${agent.successRate.toFixed(1)}%` : '—'}
            </p>
            <p className="mt-0.5 text-[11px] text-ink-faint">成功率</p>
          </div>
        </div>

        {/* price + rating */}
        <div className="mt-4 flex items-end justify-between">
          <div>
            <p className="font-grotesk text-2xl font-bold text-forge-amber">
              {formatToken(agent.monthlyPrice)}
              <span className="ml-1 text-xs font-normal text-ink-faint">Token/月</span>
            </p>
          </div>
          {agent.avgRating > 0 ? (
            <RatingStars rating={agent.avgRating} />
          ) : (
            <span className="text-[11px] text-ink-faint">评分待验证</span>
          )}
        </div>

        {/* 波二工牌卡 v2：认证标已上名行；雇佣/试岗双钮常驻卡底（hover overlay 时代退役） */}
        <HireCtas routeId={agent.routeId} />
      </div>

</motion.div>
  )
}
