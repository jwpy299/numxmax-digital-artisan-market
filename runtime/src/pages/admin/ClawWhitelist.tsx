/**
 * ClawWhitelist（/admin/claw-whitelist）—— 龙虾域名白名单审批队列（iter91）。
 * 数据：admin.clawWhitelistPending（企业名/域名/提交人/时间）+
 *       admin.clawWhitelistApprove { id, approve }（批准/驳回）。
 */
import { useState } from 'react'
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react'
import { useWbSession, useWbQuery, wbMutation, wbErrorMessage } from '@/lib/wbSession'
import {
  WbButton,
  WbEmpty,
  WbError,
  WbLoading,
  WbNotice,
  WbPageHeader,
  WbPanel,
} from '@/components/wb/ui'
import { adminConfirm, fmtTime } from './shared'

interface PendingItem {
  id: number
  factoryId: number | null
  enterpriseName: string | null
  domain: string
  submittedBy: string | null
  createdAt: unknown
}

export default function AdminClawWhitelist() {
  const { session } = useWbSession()
  const { data, error, loading, refetch } = useWbQuery<{ items: PendingItem[] }>(
    'admin.clawWhitelistPending',
    session,
  )
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  function handle(item: PendingItem, approve: boolean) {
    const actionText = approve ? '批准' : '驳回'
    if (
      !adminConfirm(
        `${actionText}企业「${item.enterpriseName ?? `#${item.factoryId}`}」的白名单域名 ${item.domain}`,
      )
    )
      return
    setNotice(null)
    setActionError(null)
    setPending(true)
    wbMutation('admin.clawWhitelistApprove', { token: session!.token, id: item.id, approve })
      .then(() => {
        setNotice(`已${actionText}域名 ${item.domain}，提交后由系统执行，页面刷新后生效。`)
        refetch()
      })
      .catch((err) => setActionError(wbErrorMessage(err)))
      .finally(() => setPending(false))
  }

  const items = data?.items ?? []

  return (
    <div>
      <WbPageHeader
        hud="CLAW WHITELIST"
        title="白名单审批"
        desc="企业提交的龙虾域名白名单审批队列：批准后域名对该企业生效（平台基础白名单 ∪ 本厂已批白名单）。"
      />
      <WbPanel
        title={`待审批（${items.length}）`}
        hud="PENDING QUEUE"
        actions={
          <WbButton variant="secondary" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </WbButton>
        }
      >
        <WbNotice message={notice} className="mb-3" />
        <WbError message={actionError ?? error} className="mb-3" />
        {loading && <WbLoading />}
        {!loading && data && items.length === 0 && (
          <WbEmpty text="暂无待审批域名" hint="企业在工作台提交白名单域名后会出现在这里。" />
        )}
        <div className="space-y-2">
          {items.map((w) => (
            <div key={w.id} className="rounded-[10px] border border-line-subtle bg-void/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-ink-primary">{w.domain}</span>
                <span className="rounded-full border border-forge-amber/40 bg-forge-amber/10 px-2 py-0.5 font-mono text-[10px] text-forge-amber">
                  待审批
                </span>
                <span className="ml-auto font-mono text-[10px] text-ink-faint">#{w.id}</span>
              </div>
              <p className="mt-1 text-xs text-ink-faint">
                企业：{w.enterpriseName ?? `FACTORY #${w.factoryId ?? '—'}`} · 提交人：
                {w.submittedBy ?? '—'} · {fmtTime(w.createdAt)}
              </p>
              <div className="mt-2 flex gap-2">
                <WbButton disabled={pending} onClick={() => handle(w, true)}>
                  <CheckCircle2 className="h-4 w-4" />
                  批准
                </WbButton>
                <WbButton variant="danger" disabled={pending} onClick={() => handle(w, false)}>
                  <XCircle className="h-4 w-4" />
                  驳回
                </WbButton>
              </div>
            </div>
          ))}
        </div>
      </WbPanel>
    </div>
  )
}
