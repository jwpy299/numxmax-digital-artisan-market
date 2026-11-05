/**
 * AdminTopups（/admin/topups，充值处理，迭代 34）—— Token 充值申请的人工处理队列。
 *
 * 契约（API-CONTRACT-v10，wbBilling 路由，admin token 在请求体）：
 * - wbBilling.topupList({status?})：充值申请列表（admin 视角为全企业；数组兜底 []，items/rows 回退）
 * - wbBilling.billingConfirm({topupId})：确认入账（确认后给企业钱包入账，全程写审计）
 * - wbBilling.billingReject({topupId, reason})：拒绝（必填原因，不加余额）
 *
 * 字段 camelCase/snake_case 双兼容；日期一律
 * new Date(String(v)).toLocaleString('zh-CN',{hour12:false}) 防 superjson Date 直渲（React#31）。
 */
import { useMemo, useState } from 'react'
import {
  CheckCircle2,
  ClipboardList,
  RefreshCw,
  X,
  XCircle,
} from 'lucide-react'
import { callWb, useWbQuery, useWbSession, wbErrorMessage } from '@/lib/wbSession'
import {
  WbButton,
  WbEmpty,
  WbError,
  WbField,
  WbLoading,
  WbNotice,
  WbPageHeader,
  WbPanel,
} from '@/components/wb/ui'
import { cn } from '@/lib/utils'

// ─── 类型（双字段兼容）───────────────────────────────────────────────────────

interface TopupItem {
  id?: number
  topupId?: number
  topup_id?: number
  factoryId?: number
  factory_id?: number
  factoryName?: string
  factory_name?: string
  amount?: number
  priceCny?: number
  price_cny?: number
  status?: string
  remark?: string
  proof?: string
  reason?: string
  confirmedBy?: string
  confirmed_by?: string
  confirmedAt?: unknown
  confirmed_at?: unknown
  createdAt?: unknown
  created_at?: unknown
  [key: string]: unknown
}

type ListResp = TopupItem[] | { items?: TopupItem[]; rows?: TopupItem[]; total?: number } | null

function listOf(res: ListResp): TopupItem[] {
  if (Array.isArray(res)) return res
  return res?.items ?? res?.rows ?? []
}

function pick<T, K extends keyof T>(obj: T, ...keys: K[]): T[K] | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (v !== undefined && v !== null) return v
  }
  return undefined
}

function fmt(v: unknown): string {
  return v ? new Date(String(v)).toLocaleString('zh-CN', { hour12: false }) : '—'
}

function topupIdOf(t: TopupItem): number | undefined {
  const n = Number(t.id ?? t.topupId ?? t.topup_id)
  return Number.isFinite(n) ? n : undefined
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: '待确认', cls: 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber' },
  confirmed: { label: '已入账', cls: 'border-jade-green/40 bg-jade-green/10 text-jade-green' },
  rejected: { label: '已拒绝', cls: 'border-ember-red/40 bg-ember-red/10 text-ember-red' },
}

// ─── 拒绝弹窗（必填原因）─────────────────────────────────────────────────────

function RejectModal({
  topup,
  busy,
  onClose,
  onConfirm,
}: {
  topup: TopupItem
  busy: boolean
  onClose: () => void
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | null>(null)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-void/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-line-subtle bg-panel p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="拒绝充值申请"
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-bold text-ink-primary">
            <XCircle className="h-4 w-4 text-ember-red" />
            拒绝充值申请 #{topupIdOf(topup) ?? '—'}
          </h3>
          <button type="button" onClick={onClose} className="text-ink-faint transition-colors hover:text-ink-primary">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-ink-faint">
          拒绝后不会入账，申请企业可在其记录中看到拒绝原因。
        </p>
        <WbField label="拒绝原因（必填）">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="例如：未收到对应款项 / 凭证信息不符……"
            className="w-full rounded-[10px] border border-line-subtle bg-void/60 px-3 py-2 text-sm text-ink-primary outline-none transition-colors focus:border-ember-red/50"
          />
        </WbField>
        <WbError message={err} className="mt-3" />
        <div className="mt-4 flex justify-end gap-2">
          <WbButton variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </WbButton>
          <WbButton
            variant="danger"
            loading={busy}
            onClick={() => {
              if (!reason.trim()) {
                setErr('请填写拒绝原因')
                return
              }
              onConfirm(reason.trim())
            }}
          >
            确认拒绝
          </WbButton>
        </div>
      </div>
    </div>
  )
}

// ─── 页面 ────────────────────────────────────────────────────────────────────

export default function AdminTopups() {
  const { session } = useWbSession()
  // admin 视角必须走 wbBilling.billingList（requireAdmin）；topupList 是企业主口径（requireOwnerToken），admin 调用会拿到空数组
  const qPending = useWbQuery<ListResp>('wbBilling.billingList', session, { status: 'pending' }, { enabled: !!session?.token })
  const qConfirmed = useWbQuery<ListResp>('wbBilling.billingList', session, { status: 'confirmed' }, { enabled: !!session?.token })
  const qRejected = useWbQuery<ListResp>('wbBilling.billingList', session, { status: 'rejected' }, { enabled: !!session?.token })
  const query = useMemo(() => {
    const data = {
      items: [...listOf(qPending.data), ...listOf(qConfirmed.data), ...listOf(qRejected.data)],
    }
    const hasData = !!(qPending.data || qConfirmed.data || qRejected.data)
    return {
      data: hasData ? data : undefined,
      error: qPending.error || qConfirmed.error || qRejected.error,
      loading: qPending.loading || qConfirmed.loading || qRejected.loading,
      refetch: () => { qPending.refetch(); qConfirmed.refetch(); qRejected.refetch() },
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qPending.data, qConfirmed.data, qRejected.data, qPending.error, qConfirmed.error, qRejected.error, qPending.loading, qConfirmed.loading, qRejected.loading])

  const [busyId, setBusyId] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [rejectTarget, setRejectTarget] = useState<TopupItem | null>(null)

  const items = useMemo(() => query.data?.items ?? [], [query.data])
  const pending = items
    .filter((t) => String(t.status ?? 'pending') === 'pending')
    .sort(
      (a, b) =>
        new Date(String(pick(a, 'createdAt', 'created_at') ?? 0)).getTime() -
        new Date(String(pick(b, 'createdAt', 'created_at') ?? 0)).getTime(),
    )
  const handled = items
    .filter((t) => String(t.status ?? 'pending') !== 'pending')
    .sort(
      (a, b) =>
        new Date(String(pick(b, 'confirmedAt', 'confirmed_at') ?? pick(b, 'createdAt', 'created_at') ?? 0)).getTime() -
        new Date(String(pick(a, 'confirmedAt', 'confirmed_at') ?? pick(a, 'createdAt', 'created_at') ?? 0)).getTime(),
    )

  async function handleConfirm(t: TopupItem) {
    const id = topupIdOf(t)
    if (id == null) return
    setBusyId(id)
    setErr(null)
    setOk(null)
    try {
      await callWb('mutation', 'wbBilling.billingConfirm', session, { topupId: id })
      setOk(`申请 #${id}（${Number(t.amount ?? 0)} Token）已确认并入账，审计已留痕。`)
      query.refetch()
    } catch (e) {
      setErr(wbErrorMessage(e))
    } finally {
      setBusyId(null)
    }
  }

  async function handleRejectConfirm(reason: string) {
    const t = rejectTarget
    const id = t ? topupIdOf(t) : undefined
    if (id == null) return
    setBusyId(id)
    setErr(null)
    setOk(null)
    try {
      await callWb('mutation', 'wbBilling.billingReject', session, { topupId: id, reason })
      setRejectTarget(null)
      setOk(`申请 #${id} 已拒绝（原因：${reason}），未入账。`)
      query.refetch()
    } catch (e) {
      setErr(wbErrorMessage(e))
    } finally {
      setBusyId(null)
    }
  }

  function rowCells(t: TopupItem) {
    const status = String(t.status ?? 'pending')
    const meta = STATUS_META[status] ?? { label: status, cls: 'border-line-subtle text-ink-secondary' }
    return (
      <>
        <td className="py-2.5 pr-3 font-mono text-xs text-ink-faint">{topupIdOf(t) ?? '—'}</td>
        <td className="py-2.5 pr-3 font-mono text-xs text-ink-secondary">
          #{pick(t, 'factoryId', 'factory_id') ?? '—'}
          {pick(t, 'factoryName', 'factory_name') ? ` · ${pick(t, 'factoryName', 'factory_name')}` : ''}
        </td>
        <td className="py-2.5 pr-3 font-grotesk text-sm font-bold text-ink-primary">
          {Number(t.amount ?? 0)}
          <span className="ml-1 font-mono text-[10px] font-normal text-ink-faint">Token</span>
        </td>
        <td className="py-2.5 pr-3 font-mono text-xs text-ink-secondary">
          {pick(t, 'priceCny', 'price_cny') != null ? `¥${Number(pick(t, 'priceCny', 'price_cny'))}` : '—'}
        </td>
        <td className="py-2.5 pr-3">
          <span className={cn('inline-flex rounded-full border px-2 py-0.5 font-mono text-[10px]', meta.cls)}>
            {meta.label}
          </span>
        </td>
        <td className="max-w-[220px] truncate py-2.5 pr-3 text-xs text-ink-faint">
          {String(t.remark ?? t.proof ?? t.reason ?? '') || '—'}
        </td>
        <td className="py-2.5 pr-3 font-mono text-[11px] text-ink-faint">
          {fmt(pick(t, 'createdAt', 'created_at'))}
        </td>
      </>
    )
  }

  return (
    <div>
      <WbPageHeader
        hud="TOKEN TOPUPS"
        title="充值处理"
        desc="企业 Token 充值申请的人工确认队列：确认后入账并写审计；拒绝须填原因、不入账。Token 为平台内结算点数，结算兑换通道未来开放。"
      />

      <WbError message={err} className="mb-4" />
      <WbNotice message={ok} className="mb-4" />

      {/* 待处理队列 */}
      <WbPanel
        hud="PENDING"
        title={`待确认（${pending.length}）`}
        className="mb-6"
        actions={
          (query.data || query.error) && (
            <button
              type="button"
              onClick={() => query.refetch()}
              className="flex items-center gap-1 text-xs text-ink-faint transition-colors hover:text-pulse-cyan"
            >
              <RefreshCw className="h-3 w-3" />
              刷新
            </button>
          )
        }
      >
        {query.loading && !query.data ? (
          <WbLoading text="充值申请加载中…" />
        ) : query.error ? (
          <WbError message={query.error} />
        ) : pending.length === 0 ? (
          <WbEmpty text="没有待确认的充值申请" hint="企业主在 /wb/topup 提交申请后会出现在这里" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead>
                <tr className="border-b border-line-subtle text-xs text-ink-faint">
                  <th className="pb-2 pr-3 font-medium">#</th>
                  <th className="pb-2 pr-3 font-medium">企业</th>
                  <th className="pb-2 pr-3 font-medium">数量</th>
                  <th className="pb-2 pr-3 font-medium">应付</th>
                  <th className="pb-2 pr-3 font-medium">状态</th>
                  <th className="pb-2 pr-3 font-medium">备注/凭证</th>
                  <th className="pb-2 pr-3 font-medium">申请时间</th>
                  <th className="pb-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((t, i) => {
                  const id = topupIdOf(t)
                  return (
                    <tr key={String(id ?? i)} className="border-b border-line-subtle/60 last:border-0">
                      {rowCells(t)}
                      <td className="py-2.5">
                        <div className="flex items-center gap-1.5">
                          <WbButton
                            variant="secondary"
                            className="px-2.5 py-1 text-[11px]"
                            loading={busyId === id}
                            onClick={() => void handleConfirm(t)}
                          >
                            <CheckCircle2 className="h-3 w-3" />
                            确认入账
                          </WbButton>
                          <WbButton
                            variant="danger"
                            className="px-2.5 py-1 text-[11px]"
                            disabled={busyId === id}
                            onClick={() => setRejectTarget(t)}
                          >
                            <XCircle className="h-3 w-3" />
                            拒绝
                          </WbButton>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </WbPanel>

      {/* 已处理记录 */}
      <WbPanel
        hud="HANDLED"
        title={`已处理记录（${handled.length}）`}
        actions={
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-ink-faint">
            <ClipboardList className="h-3.5 w-3.5" />
            确认 / 拒绝均留痕
          </span>
        }
      >
        {handled.length === 0 ? (
          <WbEmpty text="暂无已处理记录" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead>
                <tr className="border-b border-line-subtle text-xs text-ink-faint">
                  <th className="pb-2 pr-3 font-medium">#</th>
                  <th className="pb-2 pr-3 font-medium">企业</th>
                  <th className="pb-2 pr-3 font-medium">数量</th>
                  <th className="pb-2 pr-3 font-medium">应付</th>
                  <th className="pb-2 pr-3 font-medium">状态</th>
                  <th className="pb-2 pr-3 font-medium">备注/原因</th>
                  <th className="pb-2 pr-3 font-medium">申请时间</th>
                  <th className="pb-2 font-medium">处理信息</th>
                </tr>
              </thead>
              <tbody>
                {handled.map((t, i) => (
                  <tr key={String(topupIdOf(t) ?? i)} className="border-b border-line-subtle/60 last:border-0">
                    {rowCells(t)}
                    <td className="py-2.5 font-mono text-[11px] text-ink-faint">
                      {pick(t, 'confirmedBy', 'confirmed_by') ? `${pick(t, 'confirmedBy', 'confirmed_by')} · ` : ''}
                      {fmt(pick(t, 'confirmedAt', 'confirmed_at'))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </WbPanel>

      {rejectTarget && (
        <RejectModal
          topup={rejectTarget}
          busy={busyId === topupIdOf(rejectTarget)}
          onClose={() => setRejectTarget(null)}
          onConfirm={(reason) => void handleRejectConfirm(reason)}
        />
      )}
    </div>
  )
}
