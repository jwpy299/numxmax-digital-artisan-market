import { useState } from 'react'
import { motion } from 'framer-motion'
import { BadgeCheck, CheckCircle2, Coins, Layers, Loader2, UserRound, X, XCircle } from 'lucide-react'
import { trpcRecruitLoop } from '@/lib/trpcRecruitLoop'
import type { RecruitLoopOutputs } from '@/lib/trpcRecruitLoop'
import HudCorner from '@/components/HudCorner'
import TagChip from '@/components/TagChip'

type PendingAgent = RecruitLoopOutputs['review']['pendingQueue']['pending'][number]

/** 待审 Agent 详情卡：上架资料全览 + 通过 / 驳回（驳回需填原因） */
export default function PendingAgentCard({ agent, index }: { agent: PendingAgent; index: number }) {
  const utils = trpcRecruitLoop.useUtils()
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const decide = trpcRecruitLoop.review.decideAgent.useMutation({
    onSuccess: async (r) => {
      setMsg({
        ok: true,
        text: r.status === 'active' ? `已通过审核，「${agent.name}」正式上架数字匠市。` : `已驳回「${agent.name}」的上架申请。`,
      })
      setRejecting(false)
      await Promise.all([utils.review.pendingQueue.invalidate(), utils.review.stats.invalidate()])
    },
    onError: (e) => setMsg({ ok: false, text: e.message || '操作失败，请稍后重试。' }),
  })

  if (msg?.ok) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="glass-panel relative flex items-center gap-3 rounded-2xl p-6"
      >
        <CheckCircle2 className="h-5 w-5 shrink-0 text-jade-green" />
        <p className="text-sm text-ink-secondary">{msg.text}</p>
      </motion.div>
    )
  }

  return (
    <motion.article
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: index * 0.06, ease: [0.16, 1, 0.3, 1] }}
      className="glass-panel relative rounded-2xl p-6"
    >
      <HudCorner />
      <div className="flex flex-col gap-5 md:flex-row">
        <img src={agent.avatar} alt={agent.name} className="h-20 w-20 shrink-0 rounded-[14px] border border-line-subtle object-cover" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-lg font-bold text-ink-primary">{agent.name}</h3>
            <span className="font-mono text-xs text-ink-faint">{agent.code}</span>
            {agent.certified && <BadgeCheck className="h-4 w-4 text-pulse-cyan" />}
            <span className="rounded-full border border-forge-amber/40 bg-forge-amber/10 px-2.5 py-0.5 text-[11px] text-forge-amber">待审核</span>
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-faint">
            <span className="inline-flex items-center gap-1"><UserRound className="h-3.5 w-3.5" />{agent.masterSignature ?? agent.masterName ?? '未知老师傅'}</span>
            <span className="inline-flex items-center gap-1"><Coins className="h-3.5 w-3.5 text-forge-amber" /><span className="font-mono">{agent.monthlyPrice.toLocaleString()} Token/月</span></span>
            <span className="inline-flex items-center gap-1"><Layers className="h-3.5 w-3.5" />{agent.skills.length} 项技能</span>
            <span className="font-mono">提交于 {agent.createdAt.toLocaleString('zh-CN')}</span>
          </p>
          <p className="mt-1 text-xs text-ink-faint">{agent.industry}</p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {agent.capabilityTags.map((t) => <TagChip key={t} label={t} />)}
          </div>
          {agent.intro && (
            <p className="mt-3 rounded-[10px] border border-line-subtle bg-void/40 px-4 py-3 text-[13px] leading-relaxed text-ink-secondary">
              {agent.intro}
            </p>
          )}
          {agent.skills.length > 0 && (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {agent.skills.map((s) => (
                <div key={s.id} className="rounded-[10px] border border-line-subtle bg-void/30 px-3 py-2">
                  <p className="flex items-center justify-between gap-2 text-xs text-ink-primary">
                    <span className="truncate">{s.name}</span>
                    <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                      {s.type} · 复杂度{s.complexity} · {s.pricePerCall} Token
                    </span>
                  </p>
                  {s.description && <p className="mt-1 line-clamp-1 text-[11px] text-ink-faint">{s.description}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 border-t border-line-subtle pt-4">
        {rejecting ? (
          <div className="space-y-3">
            <textarea
              autoFocus
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="填写驳回原因（将写入该 Agent 的审核记录）…"
              className="w-full resize-none rounded-[10px] border border-line-subtle bg-void/60 px-4 py-2.5 text-sm text-ink-primary placeholder:text-ink-faint outline-none transition-colors focus:border-ember-red/60"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setMsg(null); decide.mutate({ agentId: agent.id, approve: false, reason: reason.trim() }) }}
                disabled={decide.isPending || !reason.trim()}
                className="inline-flex items-center gap-1.5 rounded-[10px] border border-ember-red/50 bg-ember-red/10 px-4 py-2 text-xs text-ember-red transition-colors hover:bg-ember-red/20 disabled:opacity-50"
              >
                {decide.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                确认驳回
              </button>
              <button
                onClick={() => { setRejecting(false); setReason('') }}
                className="rounded-[10px] border border-line-subtle px-4 py-2 text-xs text-ink-faint transition-colors hover:text-ink-secondary"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setMsg(null); decide.mutate({ agentId: agent.id, approve: true }) }}
              disabled={decide.isPending}
              className="inline-flex items-center gap-1.5 rounded-[10px] border border-jade-green/50 bg-jade-green/10 px-5 py-2 text-xs font-medium text-jade-green transition-colors hover:bg-jade-green/20 disabled:opacity-50"
            >
              {decide.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              通过上架
            </button>
            <button
              onClick={() => setRejecting(true)}
              disabled={decide.isPending}
              className="inline-flex items-center gap-1.5 rounded-[10px] border border-line-subtle px-5 py-2 text-xs text-ink-faint transition-colors hover:border-ember-red/50 hover:text-ember-red disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" /> 驳回
            </button>
          </div>
        )}
        {msg && !msg.ok && (
          <p className="mt-3 rounded-[10px] border border-ember-red/40 bg-ember-red/10 px-4 py-2.5 text-[13px] text-ember-red">{msg.text}</p>
        )}
      </div>
    </motion.article>
  )
}
