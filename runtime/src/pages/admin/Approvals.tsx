/**
 * Approvals（/admin/approvals）—— 统一审批中心：龙虾操作单 + Token 充值申请统一收件箱。
 * 批准/驳回走 approvals.decide，复用各领域共享 helper（行为与原端点一致）。
 */
import { CheckCircle2, Inbox, RefreshCw, XCircle } from 'lucide-react'
import { useState } from 'react'
import { useWbSession, useWbQuery, wbMutation } from '@/lib/wbSession'
import { WbError, WbLoading, WbPageHeader, WbPanel, WbButton } from '@/components/wb/ui'
import { cn } from '@/lib/utils'

interface InboxItem {
  kind: 'claw' | 'topup'
  refId: string
  title: string
  summary: string
  actor: string
  createdAt: string | null
}
interface InboxResp {
  items: InboxItem[]
  counts: { claw: number; topup: number }
}

const KIND_LABEL: Record<string, { label: string; cls: string }> = {
  claw: { label: '龙虾任务', cls: 'text-sky-300' },
  topup: { label: '充值确认', cls: 'text-forge-amber' },
}

export default function AdminApprovals() {
  const { session } = useWbSession()
  const { data, error, loading, refetch } = useWbQuery<InboxResp>('approvals.inbox', session)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [mutErr, setMutErr] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({})

  async function decide(item: InboxItem, action: 'approve' | 'reject') {
    if (!session) return
    const key = `${item.kind}-${item.refId}`
    setBusy(key)
    setMutErr(null)
    setNotice(null)
    try {
      const reason = rejectReason[key]?.trim()
      const res = await wbMutation<{ ok: boolean; message: string }>('approvals.decide', {
        token: session.token,
        kind: item.kind,
        refId: item.refId,
        action,
        ...(reason ? { reason } : {}),
      })
      setNotice(res.message)
      refetch()
    } catch (e) {
      setMutErr(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(null)
    }
  }

  const items = data?.items ?? []
  return (
    <div>
      <WbPageHeader
        hud="APPROVALS INBOX"
        title="统一审批中心"
        desc="跨域待办收口：龙虾操作单与 Token 充值申请在此统一批准/驳回，处理逻辑与原入口完全一致（含审计留痕）。"
      />
      <WbPanel
        title="待办收件箱"
        hud="INBOX"
        actions={
          <WbButton variant="secondary" loading={loading} onClick={refetch}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </WbButton>
        }
      >
        <WbError message={error ?? mutErr} className="mb-3" />
        {notice && (
          <p className="mb-3 rounded-lg border border-jade-green/30 bg-jade-green/10 px-3 py-2 text-xs text-jade-green">
            {notice}
          </p>
        )}
        {data && (
          <div className="mb-4 flex gap-3 text-xs">
            <span className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sky-300">
              龙虾任务待审批 {data.counts.claw}
            </span>
            <span className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-forge-amber">
              充值待确认 {data.counts.topup}
            </span>
          </div>
        )}
        {loading && !data && <WbLoading text="待办加载中…" />}
        {data && items.length === 0 && (
          <p className="flex items-center gap-2 text-xs text-ink-faint">
            <Inbox className="h-4 w-4" />
            收件箱已清空，没有待审批事项。
          </p>
        )}
        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-white/10 text-ink-faint">
                  <th className="px-3 py-2">来源</th>
                  <th className="px-3 py-2">事项</th>
                  <th className="px-3 py-2">发起人</th>
                  <th className="px-3 py-2">时间</th>
                  <th className="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const k = KIND_LABEL[it.kind] ?? { label: it.kind, cls: 'text-ink-faint' }
                  const key = `${it.kind}-${it.refId}`
                  return (
                    <tr key={key} className="border-b border-white/5 align-top">
                      <td className={cn('px-3 py-2 whitespace-nowrap', k.cls)}>{k.label}</td>
                      <td className="max-w-[360px] px-3 py-2">
                        <p className="text-ink-primary">{it.title}</p>
                        <p className="mt-1 line-clamp-2 text-ink-secondary">{it.summary}</p>
                        {it.kind === 'topup' && (
                          <input
                            value={rejectReason[key] ?? ''}
                            onChange={(e) => setRejectReason({ ...rejectReason, [key]: e.target.value })}
                            placeholder="驳回理由（驳回时必填）"
                            className="mt-2 w-64 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-ink-primary placeholder:text-ink-faint focus:outline-none"
                          />
                        )}
                      </td>
                      <td className="px-3 py-2 text-ink-secondary">{it.actor}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-ink-faint">{it.createdAt ?? '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="flex gap-2">
                          <WbButton
                            variant="secondary"
                            loading={busy === key}
                            onClick={() => void decide(it, 'approve')}
                          >
                            <CheckCircle2 className="h-4 w-4" />
                            批准
                          </WbButton>
                          <WbButton
                            variant="danger"
                            loading={busy === `${key}`}
                            disabled={it.kind === 'topup' && !(rejectReason[key]?.trim()) && false}
                            onClick={() => void decide(it, 'reject')}
                          >
                            <XCircle className="h-4 w-4" />
                            驳回
                          </WbButton>
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </WbPanel>
    </div>
  )
}
