import { useState } from 'react'
import { Link } from 'react-router'
import { motion } from 'framer-motion'
import { ArrowRight, Loader2, RefreshCcw, Star } from 'lucide-react'
import GlowButton from '@/components/GlowButton'
import { cn } from '@/lib/utils'
import type { HireItem } from '@/components/wb/tasks/types'
import { formatDate, formatNum, trialDaysLeft } from '@/components/wb/tasks/types'

interface EmployeeCardsProps {
  hires: HireItem[] | undefined
  isLoading: boolean
  isError: boolean
  onRetry: () => void
  executingAgentId: number | null
  onDispatch: (hire: HireItem) => void
  onCancel: (hire: HireItem) => void
  cancellingId: number | null
  onReview: (hire: HireItem, rating: number) => void
  reviewingId: number | null
}

/** 可点击五星评价 */
function StarInput({ onRate, disabled }: { onRate: (n: number) => void; disabled: boolean }) {
  const [hover, setHover] = useState(0)
  const [rated, setRated] = useState(0)
  if (rated > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-forge-amber">
        {Array.from({ length: 5 }).map((_, i) => (
          <Star key={i} className={cn('h-3.5 w-3.5', i < rated ? 'fill-forge-amber text-forge-amber' : 'text-ink-faint/50')} />
        ))}
        <span className="ml-1 text-ink-secondary">已评价</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-0.5" onMouseLeave={() => setHover(0)}>
      {Array.from({ length: 5 }).map((_, i) => (
        <button
          key={i}
          type="button"
          aria-label={`评 ${i + 1} 星`}
          disabled={disabled}
          onMouseEnter={() => setHover(i + 1)}
          onClick={() => {
            setRated(i + 1)
            onRate(i + 1)
          }}
          className="transition-transform hover:scale-125 disabled:opacity-40"
        >
          <Star className={cn('h-3.5 w-3.5', i < hover ? 'fill-forge-amber text-forge-amber' : 'text-ink-faint/60')} />
        </button>
      ))}
      <span className="ml-1 text-[11px] text-ink-faint">{disabled ? '提交中…' : '点击评分'}</span>
    </span>
  )
}

function StatusBadge({ hire, executing }: { hire: HireItem; executing: boolean }) {
  if (hire.status === 'trial') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-forge-amber/40 bg-forge-amber/10 px-2.5 py-0.5 text-[11px] text-forge-amber">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-forge-amber" />
        试用 D-{trialDaysLeft(hire.endsAt)}
      </span>
    )
  }
  if (executing) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-pulse-cyan/40 bg-pulse-cyan/10 px-2.5 py-0.5 text-[11px] text-pulse-cyan">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-pulse-cyan opacity-70" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-pulse-cyan" />
        </span>
        执行中
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-jade-green/40 bg-jade-green/10 px-2.5 py-0.5 text-[11px] text-jade-green">
      <span className="h-1.5 w-1.5 rounded-full bg-jade-green" />
      待命
    </span>
  )
}

export default function EmployeeCards(props: EmployeeCardsProps) {
  const { hires, isLoading, isError, onRetry, executingAgentId, onDispatch, onCancel, cancellingId, onReview, reviewingId } = props
  const [confirmCancelId, setConfirmCancelId] = useState<number | null>(null)

  const visible = (hires ?? []).filter((h) => h.status === 'active' || h.status === 'trial')

  return (
    <section className="bg-deep py-16 md:py-20">
      <div className="mx-auto max-w-site px-5 md:px-12">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-wrap items-end justify-between gap-4"
        >
          <div>
            <p className="hud-label text-pulse-cyan/80">MY DIGITAL WORKFORCE</p>
            <h2 className="mt-2 font-display text-[22px] font-bold text-ink-primary md:text-2xl">我的数字员工</h2>
          </div>
          <Link
            to="/market"
            className="group inline-flex items-center gap-1.5 text-sm text-pulse-cyan transition-colors hover:text-ink-primary"
          >
            去市场再雇一位
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Link>
        </motion.div>

        {/* 加载骨架 */}
        {isLoading && (
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="glass-panel animate-pulse rounded-2xl p-7">
                <div className="flex items-center gap-4">
                  <div className="h-20 w-20 rounded-2xl bg-panel" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-24 rounded bg-panel" />
                    <div className="h-3 w-16 rounded bg-panel" />
                  </div>
                </div>
                <div className="mt-6 space-y-2">
                  <div className="h-3 w-full rounded bg-panel" />
                  <div className="h-3 w-2/3 rounded bg-panel" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 失败降级 */}
        {isError && !isLoading && (
          <div className="glass-panel mt-8 flex flex-col items-center gap-4 rounded-2xl border-ember-red/30 px-6 py-12 text-center">
            <p className="text-sm text-ink-secondary">数字员工列表加载失败，请检查网络后重试。</p>
            <GlowButton variant="secondary" onClick={onRetry} className="px-4 py-2 text-xs">
              <RefreshCcw className="h-3.5 w-3.5" /> 重新加载
            </GlowButton>
          </div>
        )}

        {/* 空状态 */}
        {!isLoading && !isError && visible.length === 0 && (
          <div className="glass-panel mt-8 flex flex-col items-center gap-4 rounded-2xl px-6 py-12 text-center">
            <p className="text-sm text-ink-secondary">你还没有雇佣数字工匠。前往数字匠市，挑选你的第一位数字员工。</p>
            <GlowButton to="/market" variant="primary" className="px-4 py-2 text-xs">
              前往数字匠市
            </GlowButton>
          </div>
        )}

        {/* 员工卡 */}
        {!isLoading && !isError && visible.length > 0 && (
          <div className="mt-8 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((hire, i) => {
              const agent = hire.agent
              if (!agent) return null
              const executing = executingAgentId === agent.id
              return (
                <motion.article
                  key={hire.id}
                  initial={{ opacity: 0, y: 40 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: '-60px' }}
                  transition={{ delay: 0.12 * i, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                  whileHover={{ y: -4 }}
                  className="glass-panel group relative flex flex-col rounded-2xl p-7 transition-shadow duration-300 hover:shadow-[0_0_24px_rgba(124,92,255,0.35)]"
                >
                  <div className="flex items-start gap-4">
                    <img
                      src={agent.avatar}
                      alt={agent.name}
                      className="h-20 w-20 shrink-0 rounded-2xl border border-line-subtle object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="truncate text-lg font-bold text-ink-primary">{agent.name}</h3>
                        <StatusBadge hire={hire} executing={executing} />
                      </div>
                      <p className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">{agent.code}</p>
                      <p className="mt-1.5 truncate text-xs text-ink-secondary">{agent.capabilityTags.join(' · ')}</p>
                    </div>
                  </div>

                  <div className="mt-5 rounded-xl border border-line-subtle bg-void/40 px-4 py-3 font-mono text-[11px] leading-relaxed text-ink-secondary">
                    合约至 {formatDate(hire.endsAt)} · 月薪 {formatNum(hire.monthlyPrice)} Token
                  </div>

                  <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="font-grotesk text-lg font-bold text-ink-primary">
                        {formatNum(hire.tasksCompleted)}
                      </p>
                      <p className="mt-0.5 text-[11px] text-ink-faint">合约任务</p>
                    </div>
                    <div>
                      <p className="font-grotesk text-lg font-bold text-jade-green">{agent.successRate.toFixed(1)}%</p>
                      <p className="mt-0.5 text-[11px] text-ink-faint">成功率</p>
                    </div>
                    <div className="flex flex-col items-center">
                      <StarInput disabled={reviewingId === hire.id} onRate={(n) => onReview(hire, n)} />
                      <p className="mt-1 text-[11px] text-ink-faint">综合 {agent.avgRating.toFixed(1)}</p>
                    </div>
                  </div>

                  <div className="mt-6 flex items-center gap-3 border-t border-line-subtle pt-5">
                    <GlowButton variant="primary" onClick={() => onDispatch(hire)} className="flex-1 px-4 py-2 text-xs">
                      下达任务
                    </GlowButton>
                    <Link
                      to={`/market/agent/${agent.id}`}
                      className="text-xs text-ink-secondary transition-colors hover:text-pulse-cyan"
                    >
                      续约
                    </Link>
                    {confirmCancelId === hire.id ? (
                      <button
                        type="button"
                        disabled={cancellingId === hire.id}
                        onClick={() => {
                          onCancel(hire)
                          setConfirmCancelId(null)
                        }}
                        className="inline-flex items-center gap-1 text-xs text-ember-red transition-colors hover:text-ember-red/80"
                      >
                        {cancellingId === hire.id && <Loader2 className="h-3 w-3 animate-spin" />}
                        确认解约?
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmCancelId(hire.id)}
                        className="text-xs text-ink-faint transition-colors hover:text-ember-red"
                      >
                        解约
                      </button>
                    )}
                  </div>
                </motion.article>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
