import { useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, Loader2, ShieldOff, Star } from 'lucide-react'
import { trpcRecruitLoop } from '@/lib/trpcRecruitLoop'
import type { RecruitLoopOutputs } from '@/lib/trpcRecruitLoop'
import { cn } from '@/lib/utils'

type RiskAgent = RecruitLoopOutputs['review']['pendingQueue']['risk'][number]

const STATUS_LABEL: Record<string, string> = {
  active: '上架中',
  pending: '待审核',
  suspended: '已下架',
  rejected: '已驳回',
}

/** 下架风险 Agent 卡：delistRisk 标记 + 一键下架 */
export default function RiskAgentCard({ agent, index }: { agent: RiskAgent; index: number }) {
  const utils = trpcRecruitLoop.useUtils()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const delist = trpcRecruitLoop.review.delistAgent.useMutation({
    onSuccess: async () => {
      setDone(true)
      await Promise.all([utils.review.pendingQueue.invalidate(), utils.review.stats.invalidate()])
    },
    onError: (e) => setError(e.message || '下架失败，请稍后重试。'),
  })

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.05, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        'flex items-center gap-4 rounded-2xl border p-4',
        done ? 'border-line-subtle bg-panel/40 opacity-60' : 'border-ember-red/30 bg-ember-red/5',
      )}
    >
      <img src={agent.avatar} alt={agent.name} className="h-12 w-12 shrink-0 rounded-[10px] border border-line-subtle object-cover" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium text-ink-primary">
          <span className="truncate">{agent.name}</span>
          <span className="font-mono text-[11px] text-ink-faint">{agent.code}</span>
          {agent.delistRisk && (
            <span className="inline-flex items-center gap-1 rounded-full border border-ember-red/50 bg-ember-red/10 px-2 py-0.5 text-[10px] text-ember-red">
              <AlertTriangle className="h-3 w-3" /> 下架风险
            </span>
          )}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-ink-faint">
          <span className="inline-flex items-center gap-1">
            <Star className="h-3 w-3 text-forge-amber" /> {agent.avgRating.toFixed(1)}（{agent.ratingCount} 条评价）
          </span>
          <span>{STATUS_LABEL[agent.status] ?? agent.status}</span>
          <span>{agent.masterSignature ?? agent.masterName ?? ''}</span>
        </p>
        {error && <p className="mt-1.5 text-[11px] text-ember-red">{error}</p>}
      </div>
      {done ? (
        <span className="shrink-0 rounded-full border border-line-subtle px-3 py-1 text-[11px] text-ink-faint">已下架</span>
      ) : (
        <button
          onClick={() => { setError(null); delist.mutate({ agentId: agent.id }) }}
          disabled={delist.isPending || agent.status === 'suspended'}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[10px] border border-ember-red/50 bg-ember-red/10 px-4 py-2 text-xs text-ember-red transition-colors hover:bg-ember-red/20 disabled:opacity-50"
        >
          {delist.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
          {agent.status === 'suspended' ? '已下架' : '执行下架'}
        </button>
      )}
    </motion.div>
  )
}
