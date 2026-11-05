/**
 * AgentReview（/admin/agent-review）—— M32 数字员工考核列编。
 * 数据：agentReview.board（近 90 天真实台账：任务量/产出/采纳率/评级/末位预警）。
 * 呼应闭环：Agent 越进化 → 考核数据越厚 → 系统授权越精准。
 */
import { AlertTriangle, Award, RefreshCw } from 'lucide-react'
import { useWbSession, useWbQuery } from '@/lib/wbSession'
import { WbError, WbLoading, WbPageHeader, WbPanel, WbEmpty } from '@/components/wb/ui'
import { cn } from '@/lib/utils'

interface ReviewRow {
  agentCode: string
  name: string
  title: string
  deptCode: string
  tasks90d: number
  artifacts90d: number
  adopted: number
  rejected: number
  adoptionRate: number | null
  grade: 'A' | 'B' | 'C' | '观察中'
  warn: boolean
}

interface BoardResp {
  window: string
  formula: string
  agents: ReviewRow[]
}

const GRADE_STYLE: Record<string, string> = {
  A: 'bg-jade-green/15 text-jade-green',
  B: 'bg-pulse-cyan/15 text-pulse-cyan',
  C: 'bg-forge-amber/15 text-forge-amber',
  观察中: 'bg-ink-faint/15 text-ink-faint',
}

export default function AdminAgentReview() {
  const { session } = useWbSession()
  const q = useWbQuery<BoardResp>('agentReview.board', session)

  if (q.loading) return <WbLoading text="读取考核列编…" />
  if (q.error) return <WbError message={q.error} />
  if (!q.data) return <WbLoading text="读取考核列编…" />
  const rows = q.data.agents
  const warnCount = rows.filter((r) => r.warn).length

  return (
    <div className="space-y-6 p-6">
      <WbPageHeader
        hud="AGENT REVIEW"
        title="数字员工考核列编"
        desc={`近 90 天真实台账聚合（对话任务 / 产出物 / 采纳反馈）。评级公式：${q.data.formula}`}
      />
      <div className="mb-4 flex justify-end">
        <button
          className="flex items-center gap-1.5 rounded-lg border border-line-subtle px-3 py-1.5 text-xs text-ink-secondary hover:bg-pulse-cyan/[0.06] hover:text-ink-primary"
          onClick={() => q.refetch()}
        >
          <RefreshCw className="h-3.5 w-3.5" /> 刷新
        </button>
      </div>

      {warnCount > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-ember-red/30 bg-ember-red/10 px-4 py-3 text-sm text-ember-red">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {warnCount} 位数字员工触发末位预警（反馈样本≥3 且采纳率＜40%），建议复核其技能配置或降权。
        </div>
      )}

      <WbPanel
        title={`在役数字员工（${rows.length}）`}
      >
        {rows.length === 0 ? (
          <WbEmpty text="没有在役数字员工" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line-subtle text-left text-xs text-ink-faint">
                  <th className="px-3 py-2">数字员工</th>
                  <th className="px-3 py-2">部门</th>
                  <th className="px-3 py-2">任务量</th>
                  <th className="px-3 py-2">产出物</th>
                  <th className="px-3 py-2">采纳 / 驳回</th>
                  <th className="px-3 py-2">采纳率</th>
                  <th className="px-3 py-2">评级</th>
                  <th className="px-3 py-2">预警</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.agentCode} className="border-b border-line-subtle/50">
                    <td className="px-3 py-2.5">
                      <p className="font-medium text-ink-primary">{r.name}</p>
                      <p className="text-[11px] text-ink-faint">{r.title}</p>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-ink-secondary">{r.deptCode}</td>
                    <td className="px-3 py-2.5 font-mono text-ink-primary">{r.tasks90d}</td>
                    <td className="px-3 py-2.5 font-mono text-ink-primary">{r.artifacts90d}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-ink-secondary">
                      {r.adopted} / {r.rejected}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-ink-primary">
                      {r.adoptionRate == null ? '样本不足' : `${Math.round(r.adoptionRate * 100)}%`}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={cn('flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', GRADE_STYLE[r.grade])}>
                        <Award className="h-3 w-3" />
                        {r.grade}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {r.warn ? (
                        <span className="flex items-center gap-1 text-[11px] text-ember-red">
                          <AlertTriangle className="h-3 w-3" /> 末位
                        </span>
                      ) : (
                        <span className="text-[11px] text-ink-faint">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </WbPanel>
    </div>
  )
}
