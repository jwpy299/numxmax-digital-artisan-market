import { Loader2, Send } from 'lucide-react'
import { trpcRecruitLoop } from '@/lib/trpcRecruitLoop'
import HudCorner from '@/components/HudCorner'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'

const APP_STATUS: Record<string, { label: string; cls: string; hint: string }> = {
  pending: {
    label: '待企业确认',
    cls: 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber',
    hint: '应征已送达发布企业，确认签约前不会产生任何费用与合约。',
  },
  accepted: {
    label: '已签约',
    cls: 'border-jade-green/40 bg-jade-green/10 text-jade-green',
    hint: '企业已接受应征，智能合约已生成并进入执行期。',
  },
  rejected: {
    label: '未入选',
    cls: 'border-line-subtle bg-panel/60 text-ink-faint',
    hint: '本次应征未被企业采纳，可继续应征其他招募单。',
  },
}

/** 我的应征：当前登录用户提交的应征及状态 */
export default function MyApplications() {
  const { isAuthenticated } = useAuth()
  const mine = trpcRecruitLoop.applications.mine.useQuery(undefined, {
    enabled: isAuthenticated,
    retry: false,
  })

  return (
    <div className="glass-panel relative rounded-2xl p-7">
      <HudCorner />
      <div className="mb-5 flex items-center justify-between">
        <div>
          <p className="hud-label text-pulse-cyan/80">MY APPLICATIONS</p>
          <h3 className="mt-1 font-display text-lg font-bold text-ink-primary">我的应征</h3>
        </div>
        <span className="rounded-full border border-line-subtle px-3 py-1 font-mono text-xs text-ink-faint">
          {isAuthenticated ? `${mine.data?.length ?? 0} 条` : '未登录'}
        </span>
      </div>

      {!isAuthenticated ? (
        <p className="rounded-[12px] border border-dashed border-line-subtle px-4 py-6 text-center text-sm text-ink-faint">
          登录后可查看你提交的应征与企业反馈
        </p>
      ) : mine.isLoading ? (
        <p className="flex items-center gap-2 py-6 text-sm text-ink-faint">
          <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
        </p>
      ) : (mine.data?.length ?? 0) === 0 ? (
        <p className="rounded-[12px] border border-dashed border-line-subtle px-4 py-6 text-center text-sm text-ink-faint">
          还没有应征记录 —— 去招募大厅为合适的招募单投递数字工匠
        </p>
      ) : (
        <ul className="space-y-3">
          {mine.data!.map((a) => {
            const st = APP_STATUS[a.status] ?? APP_STATUS.pending
            return (
              <li key={a.id} className="rounded-[12px] border border-line-subtle bg-void/40 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    {a.agentAvatar && (
                      <img src={a.agentAvatar} alt={a.agentName ?? ''} className="h-10 w-10 shrink-0 rounded-[8px] border border-line-subtle object-cover" />
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink-primary">
                        {a.agentName ?? `Agent #${a.agentId}`}
                        <Send className="mx-1.5 inline h-3 w-3 text-ink-faint" />
                        <span className="text-ink-secondary">{a.recruitmentTitle ?? `招募单 #${a.recruitmentId}`}</span>
                      </p>
                      <p className="mt-1 font-mono text-xs text-ink-faint">
                        {a.budgetMonthly != null && <>{a.budgetMonthly.toLocaleString()} Token/月 · {a.periodMonths} 个月 · </>}
                        {a.createdAt.toLocaleDateString('zh-CN')} 提交
                      </p>
                    </div>
                  </div>
                  <span className={cn('shrink-0 rounded-full border px-2.5 py-0.5 text-[11px]', st.cls)}>{st.label}</span>
                </div>
                <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-ink-faint">{a.message}</p>
                <p className="mt-2 text-[11px] leading-relaxed text-ink-faint/80">{st.hint}</p>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
