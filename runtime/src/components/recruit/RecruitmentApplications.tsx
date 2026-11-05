import { useState } from 'react'
import { CheckCircle2, Handshake, Loader2, X } from 'lucide-react'
import { trpcRecruitLoop } from '@/lib/trpcRecruitLoop'
import { cn } from '@/lib/utils'

const APP_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '待确认', cls: 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber' },
  accepted: { label: '已签约', cls: 'border-jade-green/40 bg-jade-green/10 text-jade-green' },
  rejected: { label: '未入选', cls: 'border-line-subtle bg-panel/60 text-ink-faint' },
}

/** 招募单的应征列表（发布企业视角）：接受并签约 / 拒绝 */
export default function RecruitmentApplications({
  recruitmentId,
  recruitmentOpen,
}: {
  recruitmentId: number
  recruitmentOpen: boolean
}) {
  const utils = trpcRecruitLoop.useUtils()
  const list = trpcRecruitLoop.applications.listForRecruitment.useQuery(
    { recruitmentId },
    { retry: false },
  )
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const decide = trpcRecruitLoop.applications.decide.useMutation({
    onSuccess: async (r) => {
      if (r.status === 'accepted' && 'record' in r && r.record) {
        setMsg({
          ok: true,
          text: `已接受应征并自动签约：智能合约 #${r.record.id}（${r.record.monthlyPrice.toLocaleString()} Token/月 × ${r.record.periodMonths} 个月）已生效，首月佣金流水 #${r.transaction?.id} 已记账，本招募单已招满。`,
        })
      } else {
        setMsg({ ok: true, text: '已拒绝该应征。' })
      }
      await Promise.all([
        utils.applications.listForRecruitment.invalidate(),
        utils.recruitments.mine.invalidate(),
        utils.recruitments.list.invalidate(),
      ])
    },
    onError: (e) => setMsg({ ok: false, text: e.message || '操作失败，请稍后重试。' }),
  })

  if (list.isLoading) {
    return (
      <p className="flex items-center gap-2 py-3 text-xs text-ink-faint">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在载入应征…
      </p>
    )
  }
  if (list.error) {
    return <p className="py-3 text-xs text-ember-red">{list.error.message}</p>
  }
  const items = list.data ?? []
  if (items.length === 0) {
    return (
      <p className="rounded-[10px] border border-dashed border-line-subtle px-3 py-3 text-center text-xs text-ink-faint">
        暂无应征 —— 招募单在大厅展示中，工匠与老师傅可随时投递
      </p>
    )
  }

  return (
    <div className="mt-3 space-y-2.5 border-t border-line-subtle pt-3">
      {items.map((a) => {
        const st = APP_STATUS[a.status] ?? APP_STATUS.pending
        return (
          <div key={a.id} className="rounded-[10px] border border-line-subtle bg-void/50 p-3">
            <div className="flex items-center gap-3">
              {a.agentAvatar && (
                <img src={a.agentAvatar} alt={a.agentName ?? ''} className="h-9 w-9 shrink-0 rounded-[8px] border border-line-subtle object-cover" />
              )}
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink-primary">
                  <span className="truncate">{a.agentName ?? `Agent #${a.agentId}`}</span>
                  {a.agentCode && <span className="font-mono text-[10px] text-ink-faint">{a.agentCode}</span>}
                </p>
                <p className="mt-0.5 font-mono text-[11px] text-ink-faint">
                  {a.agentAvgRating != null && <>★ {a.agentAvgRating.toFixed(1)} · </>}
                  {a.agentMonthlyPrice != null && <>{a.agentMonthlyPrice.toLocaleString()} Token/月</>}
                </p>
              </div>
              <span className={cn('shrink-0 rounded-full border px-2.5 py-0.5 text-[11px]', st.cls)}>{st.label}</span>
            </div>
            <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-ink-secondary">{a.message}</p>
            {a.status === 'pending' && recruitmentOpen && (
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  onClick={() => { setMsg(null); decide.mutate({ applicationId: a.id, action: 'accept' }) }}
                  disabled={decide.isPending}
                  className="inline-flex items-center gap-1.5 rounded-full border border-jade-green/50 bg-jade-green/10 px-3 py-1 text-[11px] text-jade-green transition-colors hover:bg-jade-green/20 disabled:opacity-50"
                >
                  <Handshake className="h-3 w-3" /> 接受并签约
                </button>
                <button
                  onClick={() => { setMsg(null); decide.mutate({ applicationId: a.id, action: 'reject' }) }}
                  disabled={decide.isPending}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line-subtle px-3 py-1 text-[11px] text-ink-faint transition-colors hover:border-ember-red/50 hover:text-ember-red disabled:opacity-50"
                >
                  <X className="h-3 w-3" /> 拒绝
                </button>
              </div>
            )}
          </div>
        )
      })}
      {msg && (
        <p
          className={cn(
            'flex items-start gap-2 rounded-[10px] border px-3 py-2.5 text-[12px] leading-relaxed',
            msg.ok ? 'border-jade-green/40 bg-jade-green/10 text-jade-green' : 'border-ember-red/40 bg-ember-red/10 text-ember-red',
          )}
        >
          {msg.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <X className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          {msg.text}
        </p>
      )}
    </div>
  )
}
