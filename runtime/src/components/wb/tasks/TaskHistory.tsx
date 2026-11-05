import { motion } from 'framer-motion'
import { ChevronRight, RefreshCcw } from 'lucide-react'
import GlowButton from '@/components/GlowButton'
import { cn } from '@/lib/utils'
import type { WorkTask } from '@/components/wb/tasks/types'
import { formatDateTime, formatNum } from '@/components/wb/tasks/types'

interface TaskHistoryProps {
  tasks: WorkTask[] | undefined
  isLoading: boolean
  isError: boolean
  onRetry: () => void
  activeTaskId: number | null
  onReplay: (task: WorkTask) => void
}

export default function TaskHistory({ tasks, isLoading, isError, onRetry, activeTaskId, onReplay }: TaskHistoryProps) {
  return (
    <section className="bg-deep py-16 md:py-20">
      <div className="mx-auto max-w-site px-5 md:px-12">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        >
          <p className="hud-label text-pulse-cyan/80">TASK ARCHIVE</p>
          <h2 className="mt-2 font-display text-[22px] font-bold text-ink-primary md:text-2xl">历史任务 · 报告回看</h2>
        </motion.div>

        {isLoading && (
          <div className="mt-8 space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="glass-panel h-[72px] animate-pulse rounded-2xl" />
            ))}
          </div>
        )}

        {isError && !isLoading && (
          <div className="glass-panel mt-8 flex flex-col items-center gap-4 rounded-2xl px-6 py-10 text-center">
            <p className="text-sm text-ink-secondary">历史任务加载失败。</p>
            <GlowButton variant="secondary" onClick={onRetry} className="px-4 py-2 text-xs">
              <RefreshCcw className="h-3.5 w-3.5" /> 重新加载
            </GlowButton>
          </div>
        )}

        {!isLoading && !isError && (tasks ?? []).length === 0 && (
          <p className="mt-8 rounded-2xl border border-dashed border-line-subtle px-6 py-10 text-center text-sm text-ink-faint">
            暂无历史任务。下达第一条任务后，报告会沉淀在这里。
          </p>
        )}

        {!isLoading && !isError && (tasks ?? []).length > 0 && (
          <ul className="mt-8 space-y-3">
            {tasks!.map((t, i) => (
              <motion.li
                key={t.id}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-40px' }}
                transition={{ delay: 0.06 * i, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              >
                <button
                  type="button"
                  onClick={() => onReplay(t)}
                  className={cn(
                    'glass-panel group flex w-full items-center gap-4 rounded-2xl px-5 py-4 text-left transition-all duration-300 hover:border-nebula-violet/50 hover:shadow-[0_0_20px_rgba(124,92,255,0.25)]',
                    activeTaskId === t.id && 'border-pulse-cyan/50',
                  )}
                >
                  {t.agentAvatar && (
                    <img src={t.agentAvatar} alt="" className="h-11 w-11 shrink-0 rounded-xl border border-line-subtle object-cover" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink-primary">{t.instruction}</span>
                    <span className="mt-1 block truncate font-mono text-[11px] text-ink-faint">
                      #{t.id} · {t.agentName ?? '工匠'} · {formatDateTime(t.createdAt)} · {formatNum(t.tokenCost)} Token
                    </span>
                  </span>
                  <span
                    className={cn(
                      'hidden shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px] sm:inline-flex',
                      t.status === 'completed'
                        ? 'border-jade-green/40 bg-jade-green/10 text-jade-green'
                        : 'border-ember-red/40 bg-ember-red/10 text-ember-red',
                    )}
                  >
                    {t.status === 'completed' ? `置信度 ${Math.round(t.confidence * 100)}` : '失败'}
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-pulse-cyan">
                    回看报告
                    <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
                  </span>
                </button>
              </motion.li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
