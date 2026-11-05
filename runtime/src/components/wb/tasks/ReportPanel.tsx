import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, CheckCircle2, Download, FileCheck2, Star } from 'lucide-react'
import GlowButton from '@/components/GlowButton'
import HudCorner from '@/components/HudCorner'
import { cn } from '@/lib/utils'
import type { WorkTask } from '@/components/wb/tasks/types'
import { formatDateTime, formatNum } from '@/components/wb/tasks/types'

/** 打字机效果（逐字 30ms） */
function Typewriter({ text, className }: { text: string; className?: string }) {
  const [n, setN] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => {
      setN((v) => {
        if (v >= text.length) {
          clearInterval(timer)
          return v
        }
        return v + 1
      })
    }, 30)
    return () => clearInterval(timer)
  }, [text])
  return (
    <span className={className}>
      {text.slice(0, n)}
      {n < text.length && <span className="animate-caret-blink">▌</span>}
    </span>
  )
}

function TaskStars() {
  const [hover, setHover] = useState(0)
  const [rated, setRated] = useState(0)
  return (
    <span className="inline-flex items-center gap-1" onMouseLeave={() => setHover(0)}>
      <span className="mr-1 text-xs text-ink-faint">{rated ? '感谢评价' : '评价本次任务'}</span>
      {Array.from({ length: 5 }).map((_, i) => (
        <button
          key={i}
          type="button"
          aria-label={`${i + 1} 星`}
          onMouseEnter={() => setHover(i + 1)}
          onClick={() => setRated(i + 1)}
          className="transition-transform hover:scale-125"
        >
          <Star
            className={cn(
              'h-4 w-4',
              i < (hover || rated) ? 'fill-forge-amber text-forge-amber' : 'text-ink-faint/50',
            )}
          />
        </button>
      ))}
    </span>
  )
}

interface ReportPanelProps {
  task: WorkTask
  agentName: string | null
  /** 任务前的记忆条目数（用于 N → N+1 展示） */
  memoryBase: number | null
  runKey: number
}

export default function ReportPanel({ task, agentName, memoryBase, runKey }: ReportPanelProps) {
  const [adopted, setAdopted] = useState(false)
  const [exported, setExported] = useState(false)
  const report = task.report
  const confidencePct = Math.round(report.confidence * 100)

  const memoryText = task.memoryWritten
    ? `已写入${agentName ?? '工匠'}的工作记忆${memoryBase != null ? ` · 记忆条目 ${formatNum(memoryBase)} → ${formatNum(memoryBase + 1)}` : ''}`
    : '本次任务未产生新记忆'

  return (
    <section className="bg-void py-16 md:py-24">
      <div className="mx-auto max-w-site px-5 md:px-12">
        <motion.div
          key={`report-${runKey}`}
          initial={{ opacity: 0, y: 80 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="glass-panel relative mx-auto max-w-[920px] overflow-hidden rounded-2xl"
        >
          <HudCorner />
          {/* 文件式顶条 */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-subtle bg-forge-amber/[0.06] px-7 py-4 md:px-9">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-forge-amber">
              REPORT · {task.targetDevice ?? '设备'} · {formatDateTime(task.createdAt)}
            </p>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-jade-green/40 bg-jade-green/10 px-3 py-1 text-[11px] text-jade-green">
              <CheckCircle2 className="h-3.5 w-3.5" /> 任务完成
            </span>
          </div>

          <div className="p-7 md:p-9">
            {/* 标题 + 置信度徽章 */}
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15, duration: 0.6 }}
              className="flex flex-wrap items-start justify-between gap-5"
            >
              <div>
                <p className="hud-label text-pulse-cyan/80">STRUCTURED REPORT</p>
                <h2 className="mt-2 font-display text-[22px] font-bold leading-snug text-ink-primary md:text-[28px]">
                  {report.title}
                </h2>
                <p className="mt-2 text-sm text-ink-secondary">{task.intentSummary}</p>
              </div>
              <div className="flex flex-col items-center rounded-2xl border border-forge-amber/40 bg-forge-amber/[0.07] px-5 py-3.5">
                <span className="text-amber-gradient font-grotesk text-3xl font-bold leading-none">
                  {confidencePct} · {report.confidenceGrade}
                </span>
                <span className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-forge-amber/80">
                  confidence
                </span>
              </div>
            </motion.div>

            {/* 关键发现 */}
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3, duration: 0.6 }}
              className="mt-8"
            >
              <h3 className="flex items-center gap-2 text-sm font-bold text-ink-primary">
                <AlertTriangle className="h-4 w-4 text-forge-amber" /> 关键发现
              </h3>
              <ul className="mt-3 space-y-2.5">
                {report.findings.map((f, i) => (
                  <li key={i} className="flex gap-3 rounded-xl border border-line-subtle bg-void/40 px-4 py-3 text-sm leading-relaxed text-ink-secondary">
                    <span className="mt-0.5 font-grotesk text-xs font-bold text-forge-amber">{String(i + 1).padStart(2, '0')}</span>
                    {f}
                  </li>
                ))}
              </ul>
            </motion.div>

            {/* 执行过程摘要 */}
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.45, duration: 0.6 }}
              className="mt-8"
            >
              <h3 className="text-sm font-bold text-ink-primary">执行过程摘要</h3>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {report.skillChain.map((s, i) => (
                  <span key={s} className="flex items-center gap-2">
                    <span className="rounded-full border border-nebula-violet/40 bg-nebula-violet/10 px-3 py-1 text-xs text-nebula-violet">
                      {s}
                    </span>
                    {i < report.skillChain.length - 1 && <span className="text-ink-faint">→</span>}
                  </span>
                ))}
              </div>
              <p className="mt-3 font-mono text-xs text-ink-faint">
                耗时 {(report.durationMs / 1000).toFixed(1)}s · 调用费用 {formatNum(report.tokenCost)} Token
              </p>
            </motion.div>

            {/* 建议措施 */}
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.6, duration: 0.6 }}
              className="mt-8"
            >
              <h3 className="flex items-center gap-2 text-sm font-bold text-ink-primary">
                <FileCheck2 className="h-4 w-4 text-jade-green" /> 建议措施
              </h3>
              <ol className="mt-3 space-y-2.5">
                {report.suggestions.map((s, i) => (
                  <li key={i} className="flex gap-3 rounded-xl border border-jade-green/20 bg-jade-green/[0.04] px-4 py-3 text-sm leading-relaxed text-ink-secondary">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-jade-green/50 font-grotesk text-[10px] font-bold text-jade-green">
                      {i + 1}
                    </span>
                    {s}
                  </li>
                ))}
              </ol>
            </motion.div>

            {/* 操作行 */}
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.75, duration: 0.6 }}
              className="mt-9 flex flex-wrap items-center gap-4 border-t border-line-subtle pt-6"
            >
              {adopted ? (
                <span className="inline-flex items-center gap-2 rounded-[10px] border border-jade-green/40 bg-jade-green/10 px-6 py-3 text-sm text-jade-green">
                  <CheckCircle2 className="h-4 w-4" /> 工单已生成并派发
                </span>
              ) : (
                <GlowButton variant="primary" onClick={() => setAdopted(true)}>
                  采纳并生成工单
                </GlowButton>
              )}
              <GlowButton variant="secondary" onClick={() => setExported(true)}>
                <Download className="h-4 w-4" /> {exported ? 'PDF 已加入导出队列' : '导出 PDF'}
              </GlowButton>
              <span className="ml-auto">
                <TaskStars />
              </span>
            </motion.div>

            {/* 记忆写入提示 */}
            <div className="mt-5 text-right">
              <AnimatePresence>
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.9 }}
                  className="font-mono text-xs text-pulse-cyan"
                >
                  <Typewriter key={memoryText} text={memoryText} />
                </motion.p>
              </AnimatePresence>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  )
}
