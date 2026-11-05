import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Activity, Check, FileText, ListTree, Radar, RotateCcw, ScanSearch, ShieldCheck, Workflow,
} from 'lucide-react'
import HudCorner from '@/components/HudCorner'
import SpectrumChart from '@/components/wb/tasks/SpectrumChart'
import CountUp from '@/components/wb/tasks/CountUp'
import { cn } from '@/lib/utils'
import type { Playback } from '@/components/wb/tasks/types'

const KIND_ICON: Record<string, typeof Activity> = {
  intent: ScanSearch,
  decompose: ListTree,
  dispatch: Workflow,
  execute: Activity,
  verify: ShieldCheck,
  report: FileText,
}

interface ExecutionMonitorProps {
  playback: Playback
  agentName: string | null
  sectionRef: React.RefObject<HTMLElement | null>
  onReplay: () => void
}

function StandbyPanel({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line-subtle">
      <Radar className="h-6 w-6 animate-pulse text-ink-faint" />
      <p className="animate-pulse text-sm text-ink-faint">{label}</p>
    </div>
  )
}

export default function ExecutionMonitor({ playback, agentName, sectionRef, onReplay }: ExecutionMonitorProps) {
  const { task, status, stepPhases, logs, progress, runKey, stepDisplayMs } = playback
  const logBoxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = logBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs.length])

  const steps = task?.steps ?? []
  const dispatchSteps = steps.filter((s) => s.kind === 'dispatch')
  const dispatchDone = steps.filter((s, i) => s.kind === 'dispatch' && stepPhases[i] === 'done').length
  const verifyIdx = steps.findIndex((s) => s.kind === 'verify')
  const verifyDone = verifyIdx >= 0 && stepPhases[verifyIdx] === 'done'
  const confidence = task ? Math.round(task.confidence * 100) : 0

  const C = 2 * Math.PI * 52

  return (
    <section ref={sectionRef} className="bg-deep py-16 md:py-24">
      <div className="mx-auto max-w-site px-5 md:px-12">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-wrap items-end justify-between gap-3"
        >
          <div>
            <p className="hud-label text-pulse-cyan/80">LIVE EXECUTION MONITOR</p>
            <h2 className="mt-2 font-display text-[22px] font-bold text-ink-primary md:text-2xl">
              执行监控{status !== 'idle' && agentName ? ` · ${agentName} 正在工作` : ''}
            </h2>
          </div>
          {status === 'done' && (
            <button
              type="button"
              onClick={onReplay}
              className="inline-flex items-center gap-1.5 rounded-full border border-pulse-cyan/40 px-3.5 py-1.5 text-xs text-pulse-cyan transition-colors hover:bg-pulse-cyan/10"
            >
              <RotateCcw className="h-3.5 w-3.5" /> 重播执行过程
            </button>
          )}
        </motion.div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[55fr_45fr]">
          {/* 左栏 · 执行流水线 */}
          {status === 'idle' || !task ? (
            <StandbyPanel label="等待任务下达…" />
          ) : (
            <div className="glass-panel relative rounded-2xl p-6 md:p-7">
              <HudCorner />
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
                TASK #{task.id} · {task.intentSummary}
              </p>

              <ol className="mt-5 space-y-1">
                {steps.map((step, i) => {
                  const phase = stepPhases[i] ?? 'pending'
                  const Icon = KIND_ICON[step.kind] ?? Activity
                  const isExec = step.kind === 'execute' || step.kind === 'dispatch'
                  return (
                    <li key={step.order} className="relative flex gap-3.5 pb-4">
                      {/* 连接线 */}
                      {i < steps.length - 1 && (
                        <span
                          className={cn(
                            'absolute left-[13px] top-7 h-[calc(100%-20px)] w-px transition-colors duration-500',
                            phase === 'done' ? 'bg-jade-green/50' : 'bg-line-subtle',
                          )}
                        />
                      )}
                      {/* 节点 */}
                      <span
                        className={cn(
                          'relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors duration-300',
                          phase === 'done' && 'border-jade-green/60 bg-jade-green/15 text-jade-green',
                          phase === 'active' && 'border-pulse-cyan bg-pulse-cyan/15 text-pulse-cyan',
                          phase === 'pending' && 'border-line-subtle bg-void text-ink-faint',
                        )}
                      >
                        {phase === 'active' && (
                          <span className="absolute inset-0 animate-ping rounded-full bg-pulse-cyan/30" />
                        )}
                        {phase === 'done' ? (
                          <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 18 }}>
                            <Check className="h-3.5 w-3.5" />
                          </motion.span>
                        ) : (
                          <Icon className="h-3.5 w-3.5" />
                        )}
                      </span>
                      {/* 内容 */}
                      <div className="min-w-0 flex-1 pt-0.5">
                        <p
                          className={cn(
                            'text-sm transition-colors duration-300',
                            phase === 'active' ? 'font-medium text-ink-primary' : phase === 'done' ? 'text-ink-secondary' : 'text-ink-faint',
                          )}
                        >
                          {step.title}
                          {step.tokens != null && (
                            <span className="ml-2 font-mono text-[10px] text-forge-amber">{step.tokens} Token</span>
                          )}
                        </p>
                        <AnimatePresence>
                          {phase !== 'pending' && (
                            <motion.p
                              initial={{ opacity: 0, y: 6 }}
                              animate={{ opacity: 1, y: 0 }}
                              className="mt-1 text-xs leading-relaxed text-ink-faint"
                            >
                              {step.detail}
                            </motion.p>
                          )}
                        </AnimatePresence>
                        {/* 执行进度条 */}
                        {phase === 'active' && isExec && (
                          <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-void">
                            <motion.div
                              key={`${runKey}-${step.order}`}
                              initial={{ width: '0%' }}
                              animate={{ width: '100%' }}
                              transition={{ duration: Math.max(0.3, (stepDisplayMs[i] ?? 800) / 1000), ease: 'linear' }}
                              className="h-full rounded-full bg-gradient-to-r from-nebula-violet to-pulse-cyan"
                            />
                          </div>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ol>

              {/* 日志流 */}
              <div className="mt-2 rounded-xl border border-line-subtle bg-void/70 p-3">
                <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">RUNTIME LOG</p>
                <div ref={logBoxRef} className="h-28 overflow-y-auto pr-2 font-mono text-xs leading-6 text-pulse-cyan/85">
                  {logs.length === 0 && <p className="text-ink-faint">…</p>}
                  {logs.map((line, i) => (
                    <motion.p key={`${runKey}-${i}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
                      {line}
                    </motion.p>
                  ))}
                  {status === 'running' && <span className="inline-block h-3.5 w-2 animate-caret-blink bg-pulse-cyan/70" />}
                </div>
              </div>
            </div>
          )}

          {/* 右栏 · 实时数据 */}
          {status === 'idle' || !task ? (
            <StandbyPanel label="实时数据待机" />
          ) : (
            <div className="flex flex-col gap-6">
              <div className="glass-panel relative rounded-2xl p-6">
                <HudCorner />
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
                  SIGNAL · {task.targetDevice ?? '目标设备'}
                </p>
                <div className="mt-4">
                  <SpectrumChart progress={progress} showAnomaly={verifyDone} active />
                </div>
              </div>

              {/* 关键读数 */}
              <div className="grid grid-cols-3 gap-3">
                <div className="glass-panel rounded-xl px-3 py-3.5 text-center">
                  <p className="font-grotesk text-lg font-bold text-pulse-cyan">
                    {dispatchDone}
                    <span className="text-sm text-ink-faint">/{dispatchSteps.length}</span>
                  </p>
                  <p className="mt-1 text-[10px] text-ink-faint">技能链调度</p>
                </div>
                <div className="glass-panel rounded-xl px-3 py-3.5 text-center">
                  <p className={cn('font-grotesk text-lg font-bold', verifyDone ? 'text-jade-green' : 'text-ink-faint')}>
                    {verifyDone ? '通过' : '待验证'}
                  </p>
                  <p className="mt-1 text-[10px] text-ink-faint">交叉验证</p>
                </div>
                <div className="glass-panel rounded-xl px-3 py-3.5 text-center">
                  <p className={cn('font-grotesk text-lg font-bold', status === 'done' ? 'text-forge-amber' : 'text-ink-faint')}>
                    {status === 'done' ? `${task.report.findings.length} 项` : '—'}
                  </p>
                  <p className="mt-1 text-[10px] text-ink-faint">关键发现</p>
                </div>
              </div>

              {/* 置信度环 */}
              <div className="glass-panel flex items-center gap-5 rounded-2xl p-5">
                <div className="relative h-[120px] w-[120px] shrink-0">
                  <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
                    <circle cx={60} cy={60} r={52} fill="none" stroke="rgba(124,140,222,0.15)" strokeWidth={7} />
                    {status === 'done' ? (
                      <motion.circle
                        key={`ring-${runKey}`}
                        cx={60} cy={60} r={52} fill="none"
                        stroke="url(#confGrad)" strokeWidth={7} strokeLinecap="round"
                        strokeDasharray={C}
                        initial={{ strokeDashoffset: C }}
                        animate={{ strokeDashoffset: C * (1 - task.confidence) }}
                        transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
                      />
                    ) : (
                      <circle
                        cx={60} cy={60} r={52} fill="none"
                        stroke="#22D3EE" strokeOpacity={0.5} strokeWidth={7} strokeLinecap="round"
                        strokeDasharray={C}
                        strokeDashoffset={C * (1 - progress * 0.6)}
                      />
                    )}
                    <defs>
                      <linearGradient id="confGrad" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stopColor="#F5A524" />
                        <stop offset="100%" stopColor="#FCD34D" />
                      </linearGradient>
                    </defs>
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="font-grotesk text-2xl font-bold text-ink-primary">
                      {status === 'done' ? <CountUp value={confidence} duration={1.2} /> : Math.round(progress * 60)}
                    </span>
                    <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">confidence</span>
                  </div>
                </div>
                <div>
                  <p className="text-sm font-medium text-ink-primary">任务置信度</p>
                  <p className="mt-1.5 text-xs leading-relaxed text-ink-secondary">
                    {status === 'done'
                      ? `评级 ${task.report.confidenceGrade} · 基于 ${task.report.skillChain.length} 项技能链交叉验证`
                      : '执行结束后，系统将基于技能链交叉验证输出置信度评分。'}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
