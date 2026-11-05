import { useState } from 'react'
import type { FormEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { BadgeCheck, CheckCircle2, Loader2, Send, X } from 'lucide-react'
import { trpc } from '@/providers/trpc'
import { trpcRecruitLoop } from '@/lib/trpcRecruitLoop'
import { cn } from '@/lib/utils'

interface ApplyTarget {
  id: number
  title: string
  budgetMonthly: number
  periodMonths: number
}

const inputCls =
  'w-full rounded-[10px] border border-line-subtle bg-void/60 px-4 py-2.5 text-sm text-ink-primary placeholder:text-ink-faint outline-none transition-colors focus:border-pulse-cyan/60 focus:bg-void/80'

/** 应征弹窗：选择平台 Agent + 留言，提交后进入「待企业确认」状态 */
export default function ApplyDialog({
  recruitment,
  open,
  onOpenChange,
}: {
  recruitment: ApplyTarget | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const utils = trpcRecruitLoop.useUtils()
  const agentsQuery = trpc.agents.list.useQuery({ status: 'active', limit: 100, sort: 'rating' })
  const agentItems = agentsQuery.data?.items ?? []

  const [agentId, setAgentId] = useState<number | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const submitApp = trpcRecruitLoop.applications.submit.useMutation({
    onSuccess: async () => {
      setDone(true)
      setError(null)
      await Promise.all([
        utils.applications.mine.invalidate(),
        utils.applications.listForRecruitment.invalidate(),
      ])
    },
    onError: (e) => setError(e.message || '提交失败，请稍后重试。'),
  })

  const close = (v: boolean) => {
    onOpenChange(v)
    if (!v) {
      // 关闭后重置，下次打开是干净的表单
      setTimeout(() => {
        setAgentId(null)
        setMessage('')
        setError(null)
        setDone(false)
      }, 200)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!recruitment) return
    if (!agentId) return setError('请选择一位应征的数字工匠。')
    submitApp.mutate({
      recruitmentId: recruitment.id,
      agentId,
      message: message.trim(),
    })
  }

  return (
    <AnimatePresence>
      {open && recruitment && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-void/80 p-5 backdrop-blur-sm"
          onClick={() => close(false)}
        >
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.97 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="glass-panel relative max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl p-7"
          >
            <button
              aria-label="关闭"
              onClick={() => close(false)}
              className="absolute right-4 top-4 text-ink-faint transition-colors hover:text-ink-primary"
            >
              <X className="h-4 w-4" />
            </button>

            {done ? (
              <div className="py-6 text-center">
                <CheckCircle2 className="mx-auto h-10 w-10 text-jade-green" />
                <h3 className="mt-4 font-display text-lg font-bold text-ink-primary">应征已提交</h3>
                <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-ink-secondary">
                  你的应征已进入该招募单的候选列表，<span className="text-ink-primary">待发布企业确认</span>。
                  企业接受后才会生成智能合约并结算首月 Token，请留意「我的应征」状态更新。
                </p>
                <button
                  onClick={() => close(false)}
                  className="mt-6 rounded-[10px] bg-amber-gradient px-8 py-2.5 text-sm font-medium text-[#1A1206] transition-shadow hover:shadow-[0_0_28px_rgba(245,165,36,0.45)]"
                >
                  知道了
                </button>
              </div>
            ) : (
              <form onSubmit={submit} className="space-y-5">
                <div>
                  <p className="hud-label text-pulse-cyan/80">APPLY FOR RECRUITMENT</p>
                  <h3 className="mt-1.5 font-display text-lg font-bold leading-snug text-ink-primary">
                    应征「{recruitment.title}」
                  </h3>
                  <p className="mt-1.5 font-mono text-xs text-ink-faint">
                    预算 {recruitment.budgetMonthly.toLocaleString()} Token/月 · 周期 {recruitment.periodMonths} 个月
                  </p>
                </div>

                <div>
                  <p className="mb-2 text-[13px] font-medium text-ink-secondary">选择应征的数字工匠</p>
                  <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                    {agentsQuery.isLoading ? (
                      <p className="flex items-center gap-2 py-4 text-sm text-ink-faint">
                        <Loader2 className="h-4 w-4 animate-spin" /> 正在载入工匠列表…
                      </p>
                    ) : (
                      agentItems.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => setAgentId(a.id)}
                          className={cn(
                            'flex w-full items-center gap-3 rounded-[12px] border p-3 text-left transition-all',
                            agentId === a.id
                              ? 'border-pulse-cyan/60 bg-pulse-cyan/10 shadow-[0_0_16px_rgba(34,211,238,0.2)]'
                              : 'border-line-subtle bg-void/40 hover:border-pulse-cyan/30',
                          )}
                        >
                          <img src={a.avatar} alt={a.name} className="h-10 w-10 shrink-0 rounded-[8px] border border-line-subtle object-cover" />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5 text-sm font-medium text-ink-primary">
                              <span className="truncate">{a.name}</span>
                              <span className="font-mono text-[10px] text-ink-faint">{a.code}</span>
                              {a.certified && <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-pulse-cyan" />}
                            </span>
                            <span className="mt-0.5 block truncate font-mono text-[11px] text-ink-faint">
                              ★ {a.avgRating.toFixed(1)} · {a.monthlyPrice.toLocaleString()} Token/月 · {a.tasksCompleted} 任务
                            </span>
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </div>

                <label className="block">
                  <span className="mb-1.5 block text-[13px] font-medium text-ink-secondary">应征留言</span>
                  <textarea
                    required
                    minLength={2}
                    maxLength={1000}
                    rows={3}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="说明这位工匠的匹配点、到岗方式与交付承诺…"
                    className={cn(inputCls, 'resize-none leading-relaxed')}
                  />
                </label>

                <p className="rounded-[10px] border border-line-subtle bg-void/40 px-4 py-2.5 text-[12px] leading-relaxed text-ink-faint">
                  提交后应征状态为「待企业确认」，不会立即生效；企业接受并签约后，才会按招募预算生成智能合约与首月佣金流水。
                </p>

                {error && (
                  <p className="rounded-[10px] border border-ember-red/40 bg-ember-red/10 px-4 py-2.5 text-[13px] text-ember-red">
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={submitApp.isPending || agentItems.length === 0}
                  className={cn(
                    'flex w-full items-center justify-center gap-2 rounded-[10px] bg-amber-gradient px-6 py-3 text-sm font-medium text-[#1A1206] transition-shadow hover:shadow-[0_0_28px_rgba(245,165,36,0.45)]',
                    (submitApp.isPending || agentItems.length === 0) && 'cursor-not-allowed opacity-50',
                  )}
                >
                  {submitApp.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  提交应征
                </button>
              </form>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
