/**
 * AdminBeta（/admin/beta）—— 超终内测申请审批页（彭总 2026-10-01 令：审批放超终）。
 *
 * 批准=签 iv_ 内测码（HQ 厂 d1·staff·168h，beta-check 现成认）+码明文本次出示（复制钮人工发客户——
 * 短信通知挂账 P-SMS-TPL：阿里云通知模板审批在途）；驳回=落 reason，台账留痕全程。
 * 数据：betaApply.adminList/review（requireAdmin 闸）；空态友好。
 */
import { useState } from 'react'
import { ShieldCheck, XCircle, CheckCircle2, Copy, Check, Loader2, Inbox } from 'lucide-react'
import { useWbSession, useWbQuery, wbMutation } from '@/lib/wbSession'
import { WbPanel, WbPageHeader } from '@/components/wb/ui'
import HudCorner from '@/components/HudCorner'

const TAB_LABELS: Record<'pending' | 'approved' | 'rejected', string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已驳回',
}

interface BetaRow {
  id: number
  enterprise_name: string
  contact_name: string
  phone: string
  industry: string
  headcount: string
  need: string
  status: 'pending' | 'approved' | 'rejected'
  created_at: string
}

export default function AdminBeta() {
  const { session } = useWbSession()
  const [tab, setTab] = useState<'pending' | 'approved' | 'rejected'>('pending')
  const list = useWbQuery<{ rows: BetaRow[] }>('betaApply.adminList', session, { status: tab }, { enabled: !!session?.token })
  const [busyId, setBusyId] = useState<number | null>(null)
  const [issued, setIssued] = useState<Array<{ id: number; code: string }>>([])
  const [copied, setCopied] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function decide(id: number, approve: boolean) {
    if (!session?.token || busyId !== null) return
    let reason: string | undefined
    if (!approve) {
      const r = window.prompt('驳回原因（台账留痕，可留空）：')
      if (r === null) return // 取消=不动作
      reason = r.trim() || undefined
    }
    setBusyId(id)
    setErr(null)
    try {
      const res = await wbMutation<{ ok: boolean; approved: boolean; inviteCode?: string }>('betaApply.review', {
        token: session.token, id, approve, ...(reason ? { reason } : {}),
      })
      if (res.approved && res.inviteCode) setIssued((prev) => [...prev, { id, code: res.inviteCode! }])
      await list.refetch()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusyId(null)
    }
  }

  const rows = list.data?.rows ?? []

  return (
    <div className="mx-auto max-w-5xl px-1">
      <WbPageHeader
        hud="BETA GATE"
        title="内测申请审批"
        desc="首批 100 家工厂内测通道——批准即签 iv_ 邀请码（168h 有效），码复制人工发客户（短信模板在途 P-SMS-TPL）"
      />

      <div className="mb-4 flex gap-2">
        {(['pending', 'approved', 'rejected'] as const).map((k) => (
          <button key={k} onClick={() => setTab(k)}
            className={`rounded-full border px-4 py-1.5 text-xs transition-colors ${tab === k ? 'border-forge-amber/50 bg-forge-amber/10 text-forge-amber' : 'border-line-subtle text-ink-secondary hover:text-ink-primary'}`}>
            {TAB_LABELS[k]}
          </button>
        ))}
      </div>

      {err && <p className="mb-4 rounded-xl border border-ember-red/30 bg-ember-red/[0.06] px-4 py-3 text-sm text-ember-red">{err}</p>}

      {issued.length > 0 && (
        <div className="mb-4 space-y-2">
          {issued.map((it) => (
            <div key={it.id} className="rounded-xl border border-jade-green/40 bg-jade-green/[0.08] p-4">
              <p className="text-sm font-semibold text-jade-green">✓ 申请 #{it.id} 已批准——内测码（仅本次显示）：</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 truncate rounded-lg bg-black/50 px-3 py-2 font-mono text-sm text-jade-green">{it.code}</code>
                <button
                  onClick={() => { void navigator.clipboard?.writeText(it.code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {}) }}
                  className="flex items-center gap-1.5 rounded-lg border border-jade-green/40 px-3 py-2 text-xs text-jade-green hover:bg-jade-green/10"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? '已复制' : '复制'}
                </button>
              </div>
            </div>
          ))}
          <p className="text-[11px] text-ink-faint">客户到门户下载页输码即放行 · 168h 有效 · 一次性 · 码只本次显示（台账仅存指纹）</p>
        </div>
      )}

      <WbPanel hud="QUEUE" title={`申请队列 · ${rows.length}`}>
        {list.loading && <div className="h-24 animate-pulse rounded-xl bg-panel/60" />}
        {!list.loading && rows.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Inbox className="h-8 w-8 text-ink-faint" />
            <p className="text-sm text-ink-faint">该队列是空的</p>
          </div>
        )}
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.id} className="relative rounded-xl border border-line-subtle bg-panel/40 p-4">
              <HudCorner />
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink-primary">
                    {r.enterprise_name}
                    <span className="ml-2 font-mono text-[10px] text-ink-faint">#{r.id} · {r.industry} · {r.headcount}</span>
                  </p>
                  <p className="mt-1 text-xs text-ink-secondary">{r.contact_name} · {r.phone}</p>
                  <p className="mt-2 rounded-lg bg-black/30 px-3 py-2 text-xs leading-relaxed text-ink-secondary">「{r.need}」</p>
                  <p className="mt-1.5 font-mono text-[10px] text-ink-faint">{new Date(r.created_at).toLocaleString('zh-CN')}</p>
                </div>
                {r.status === 'pending' && (
                  <div className="flex shrink-0 flex-col gap-2">
                    <button
                      onClick={() => void decide(r.id, true)}
                      disabled={busyId === r.id}
                      className="flex items-center gap-1.5 rounded-lg bg-jade-green/15 px-3.5 py-2 text-xs font-semibold text-jade-green transition-colors hover:bg-jade-green/25 disabled:opacity-40"
                    >
                      {busyId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      批准发码
                    </button>
                    <button
                      onClick={() => void decide(r.id, false)}
                      disabled={busyId === r.id}
                      className="flex items-center gap-1.5 rounded-lg border border-ember-red/40 px-3.5 py-2 text-xs text-ember-red transition-colors hover:bg-ember-red/10 disabled:opacity-40"
                    >
                      <XCircle className="h-3.5 w-3.5" /> 驳回
                    </button>
                  </div>
                )}
                {r.status !== 'pending' && (
                  <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] ${r.status === 'approved' ? 'border-jade-green/40 bg-jade-green/10 text-jade-green' : 'border-ember-red/40 bg-ember-red/10 text-ember-red'}`}>
                    {r.status === 'approved' ? '已批准' : '已驳回'}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </WbPanel>

      <p className="mt-4 flex items-center gap-1.5 text-[11px] text-ink-faint">
        <ShieldCheck className="h-3.5 w-3.5" /> 批准即签发 iv_ 一次性内测码（HQ 厂签发·168h）· 驳回不落码 · 全程台账留痕
      </p>
    </div>
  )
}
