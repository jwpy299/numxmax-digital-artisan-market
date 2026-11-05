import { motion } from 'framer-motion'
import { Link } from 'react-router'
import { ArrowUp, Sparkles } from 'lucide-react'
import type { MarketAgent } from '@/components/market/types'
import { formatToken } from '@/components/market/types'
import SectionHeader from '@/components/SectionHeader'
import HudCorner from '@/components/HudCorner'
import { cn } from '@/lib/utils'

interface LeaderboardProps {
  leaders: MarketAgent[]
  newcomer: MarketAgent | null
  loading: boolean
}

function MiniBars({ trend }: { trend: number[] }) {
  const data = trend.length === 7 ? trend : [2, 3, 2, 4, 3, 5, 4]
  const max = Math.max(...data, 1)
  return (
    <div className="flex h-8 items-end gap-1">
      {data.map((v, i) => (
        <motion.span
          key={i}
          initial={{ scaleY: 0 }}
          whileInView={{ scaleY: 1 }}
          viewport={{ once: true }}
          transition={{ delay: i * 0.04, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="w-1.5 origin-bottom rounded-sm bg-pulse-cyan/60"
          style={{ height: `${(v / max) * 100}%` }}
        />
      ))}
    </div>
  )
}

/** 本周雇佣榜 Top5 + 新晋工匠 side card */
export default function Leaderboard({ leaders, newcomer, loading }: LeaderboardProps) {
  return (
    <section className="mx-auto max-w-site px-5 py-[72px] md:px-12 md:py-[120px]">
      <SectionHeader
        hud="WEEKLY HIRE BOARD"
        title="市场排行榜"
        subtitle="本周被企业雇佣最多的数字工匠，以及刚刚上架的新面孔。"
      />

      <div className="mt-12 grid gap-6 lg:grid-cols-[65%_1fr]">
        {/* weekly hire board */}
        <div className="relative rounded-2xl glass-panel p-6 md:p-8">
          <HudCorner />
          <p className="hud-label text-pulse-cyan/80">TOP 5 · THIS WEEK</p>
          <h3 className="mt-2 font-display text-xl font-bold text-ink-primary">本周雇佣榜</h3>

          <div className="mt-6 space-y-3">
            {loading &&
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-[72px] animate-pulse rounded-xl bg-panel/60" />
              ))}
            {!loading &&
              leaders.map((a, i) => (
                <motion.div
                  key={a.routeId}
                  initial={{ opacity: 0, x: -40 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true, margin: '-60px' }}
                  transition={{ delay: i * 0.1, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                >
                  <Link
                    to={`/market/agent/${a.routeId}`}
                    className="group flex items-center gap-4 rounded-xl border border-transparent px-3 py-3 transition-colors hover:border-line-subtle hover:bg-panel/50"
                  >
                    <span
                      className={cn(
                        'w-9 text-center font-grotesk text-[28px] font-bold leading-none',
                        i < 3 ? 'text-amber-gradient' : 'text-ink-faint',
                      )}
                    >
                      {i + 1}
                    </span>
                    <img
                      src={a.avatar}
                      alt={a.name}
                      loading="lazy"
                      className="h-11 w-11 rounded-full border border-line-subtle object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-display text-[15px] font-bold text-ink-primary">{a.name}</p>
                      <p className="mt-0.5 text-[11px] text-ink-faint">{a.industry}</p>
                    </div>
                    <span className="hidden items-center gap-1 font-mono text-xs text-pulse-cyan sm:inline-flex">
                      <ArrowUp className="h-3.5 w-3.5" />+{a.weeklyHires} 雇佣
                    </span>
                    <MiniBars trend={a.weeklyHireTrend} />
                  </Link>
                </motion.div>
              ))}
            {!loading && leaders.length === 0 && (
              <p className="py-8 text-center text-sm text-ink-faint">榜单数据暂不可用</p>
            )}
          </div>
        </div>

        {/* newcomer card */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="relative flex flex-col rounded-2xl glass-panel p-6 md:p-8"
        >
          <HudCorner />
          <p className="hud-label flex items-center gap-1.5 text-forge-amber/90">
            <Sparkles className="h-3.5 w-3.5" /> NEW ARRIVAL
          </p>
          <h3 className="mt-2 font-display text-xl font-bold text-ink-primary">新晋工匠</h3>

          {loading ? (
            <div className="mt-6 h-40 animate-pulse rounded-xl bg-panel/60" />
          ) : newcomer ? (
            <Link to={`/market/agent/${newcomer.routeId}`} className="group mt-6 block">
              <div className="relative overflow-hidden rounded-xl">
                <div className="nebula-halo absolute inset-0" />
                <img
                  src={newcomer.avatar}
                  alt={newcomer.name}
                  loading="lazy"
                  className="aspect-square w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                />
                {newcomer.listedAt && (
                  <span className="absolute left-3 top-3 rounded-full bg-forge-amber/90 px-2.5 py-1 text-[11px] font-medium text-[#1A1206]">
                    上架 {Math.max(1, Math.floor((Date.now() - newcomer.listedAt.getTime()) / 86400_000))} 天
                  </span>
                )}
              </div>
              <div className="mt-4 flex items-baseline justify-between">
                <p className="font-display text-lg font-bold text-ink-primary">{newcomer.name}</p>
                <span className="font-mono text-[10px] tracking-widest text-ink-faint">{newcomer.code}</span>
              </div>
              <p className="mt-1 text-xs text-ink-secondary">{newcomer.masterLine}</p>
              <div className="mt-4 space-y-1.5 border-t border-line-subtle pt-3 font-mono text-[11px] text-ink-faint">
                <p className="flex justify-between">
                  <span>平台建议价</span>
                  <span className="text-pulse-cyan">
                    {newcomer.suggestedPrice ? `${formatToken(newcomer.suggestedPrice)} Token/月` : '—'}
                  </span>
                </p>
                <p className="flex justify-between">
                  <span>老师傅定价</span>
                  <span className="text-forge-amber">{formatToken(newcomer.monthlyPrice)} Token/月</span>
                </p>
              </div>
            </Link>
          ) : (
            <p className="mt-6 text-sm text-ink-faint">暂无新晋工匠数据</p>
          )}
        </motion.div>
      </div>
    </section>
  )
}
