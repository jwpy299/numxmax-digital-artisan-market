import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Quote } from 'lucide-react'
import type { DetailData } from '@/components/agent-detail/detail-data'
import SectionHeader from '@/components/SectionHeader'
import RatingStars from '@/components/RatingStars'
import HudCorner from '@/components/HudCorner'
import { cn } from '@/lib/utils'

type TabKey = 'all' | 'current' | 'history'

interface ReviewsSectionProps {
  reviews: DetailData['reviews']
  distribution: DetailData['ratingDistribution']
  avgRating: number
  ratingCount: number
}

/** 雇佣记录与雇主评价：汇总条 + 分布 + 评价卡（Tabs） */
export default function ReviewsSection({ reviews, distribution, avgRating, ratingCount }: ReviewsSectionProps) {
  const [tab, setTab] = useState<TabKey>('all')

  const counts = useMemo(
    () => ({
      all: reviews.length,
      current: reviews.filter((r) => r.hireStatus === 'current').length,
      history: reviews.filter((r) => r.hireStatus === 'history').length,
    }),
    [reviews],
  )
  const filtered = tab === 'all' ? reviews : reviews.filter((r) => r.hireStatus === tab)
  const totalDist = distribution.reduce((a, d) => a + d.count, 0) || ratingCount || 1

  const TABS: { key: TabKey; label: string }[] = [
    { key: 'all', label: `全部评价 ${counts.all}` },
    { key: 'current', label: `当前雇主 ${counts.current}` },
    { key: 'history', label: `历史雇主 ${counts.history}` },
  ]

  return (
    <section className="bg-deep py-[72px] md:py-[120px]">
      <div className="mx-auto max-w-site px-5 md:px-12">
        <SectionHeader
          hud="EMPLOYER REVIEWS"
          title="雇佣记录与雇主评价"
          subtitle="每一条评价都来自真实的月度雇佣合约。"
        />

        {/* summary bar */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="relative mt-12 flex flex-col gap-8 rounded-2xl glass-panel p-8 md:flex-row md:items-center"
        >
          <HudCorner />
          <div className="flex items-center gap-5 md:w-56">
            <p className="font-grotesk text-5xl font-bold leading-none text-forge-amber">
              {avgRating.toFixed(1)}
            </p>
            <div>
              <RatingStars rating={avgRating} showValue={false} className="[&_svg]:h-4 [&_svg]:w-4" />
              <p className="mt-1.5 text-xs text-ink-faint">{ratingCount} 条雇主评价</p>
            </div>
          </div>
          <div className="flex-1 space-y-2">
            {distribution.map((d, i) => (
              <div key={d.star} className="flex items-center gap-3">
                <span className="w-7 font-mono text-[11px] text-ink-faint">{d.star}★</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-panel/80">
                  <motion.div
                    initial={{ scaleX: 0 }}
                    whileInView={{ scaleX: 1 }}
                    viewport={{ once: true }}
                    transition={{ delay: i * 0.08, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                    className="h-full origin-left rounded-full bg-amber-gradient"
                    style={{ width: `${Math.max(d.pct, d.count > 0 ? 2 : 0)}%` }}
                  />
                </div>
                <span className="w-9 text-right font-mono text-[11px] text-ink-secondary">{d.pct}%</span>
              </div>
            ))}
            {totalDist <= 1 && ratingCount === 0 && (
              <p className="text-xs text-ink-faint">评分分布数据暂不可用</p>
            )}
          </div>
        </motion.div>

        {/* tabs */}
        <div className="mt-10 flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                'rounded-full border px-4 py-1.5 text-sm transition-colors',
                tab === t.key
                  ? 'border-pulse-cyan bg-pulse-cyan/15 text-pulse-cyan'
                  : 'border-line-subtle text-ink-secondary hover:border-pulse-cyan/40 hover:text-ink-primary',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* review cards */}
        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
            className="mt-6 grid gap-5 md:grid-cols-2"
          >
            {filtered.length === 0 && (
              <p className="col-span-full py-10 text-center text-sm text-ink-faint">该分类下暂无评价</p>
            )}
            {filtered.slice(0, 6).map((r, i) => (
              <motion.figure
                key={r.id}
                initial={{ opacity: 0, y: 40 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ delay: i * 0.12, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                className="relative flex flex-col rounded-2xl glass-panel p-6"
              >
                <Quote className="h-5 w-5 text-nebula-violet/60" />
                <blockquote className="mt-3 flex-1 text-[14px] leading-relaxed text-ink-secondary">
                  {r.content}
                </blockquote>
                <figcaption className="mt-5 border-t border-line-subtle pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-ink-primary">
                        {r.enterpriseName ?? '匿名雇主'}
                        {r.employerTitle && <span className="text-ink-faint"> · {r.employerTitle}</span>}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {r.enterpriseIndustry && (
                          <span className="rounded-full border border-line-subtle px-2 py-0.5 text-[10px] text-ink-faint">
                            {r.enterpriseIndustry}
                          </span>
                        )}
                        {r.hireMonths != null && (
                          <span className="rounded-full border border-pulse-cyan/40 px-2 py-0.5 text-[10px] text-pulse-cyan">
                            雇佣 {r.hireMonths} 个月
                          </span>
                        )}
                      </div>
                    </div>
                    <RatingStars rating={r.rating} showValue={false} />
                  </div>
                </figcaption>
              </motion.figure>
            ))}
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  )
}
