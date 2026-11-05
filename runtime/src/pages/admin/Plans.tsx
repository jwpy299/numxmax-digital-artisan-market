/**
 * Plans（/admin/plans）—— 套餐管理（iter92）。
 *
 * admin.planList {items}：全厂套餐 + 用量（企业名/档位/编制/LLM 限额与今日用量/到期/状态）。
 * 每行：档位下拉 + 天数输入 +「续费/调整」→ admin.planSet {factoryId, planCode, days}
 * （adminConfirm 二次确认；expire_at = NOW() + days）。
 */
import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useWbSession, useWbQuery, wbMutation, wbErrorMessage } from '@/lib/wbSession'
import {
  WbBadge,
  WbButton,
  WbEmpty,
  WbError,
  WbLoading,
  WbNotice,
  WbPageHeader,
  WbPanel,
  wbInputCls,
} from '@/components/wb/ui'
import { AdminTable, adminTdCls, adminConfirm, fmtTime } from './shared'

interface PlanRow {
  factoryId: number
  enterpriseName: string | null
  planCode: string
  seatLimit: number
  llmDailyLimit: number
  llmUsedToday: number
  expireAt: unknown
  status: 'active' | 'past_due' | 'suspended' | string
  updatedAt?: unknown
}

const PLAN_OPTIONS = [
  { value: 'basic', label: '基础版（3 熊猫 · 200/日）' },
  { value: 'pro', label: '专业版（8 熊猫 · 1000/日）' },
  { value: 'flagship', label: '旗舰版（不限编制 · 5000/日 + L3 资格）' },
]

const STATUS_BADGE: Record<string, { status: string; label: string }> = {
  active: { status: 'active', label: '生效中' },
  past_due: { status: 'pending', label: '已欠费' },
  suspended: { status: 'rejected', label: '已暂停' },
}

export default function AdminPlans() {
  const { session } = useWbSession()
  const { data, error, loading, refetch } = useWbQuery<{ items: PlanRow[] }>('admin.planList', session)

  const [notice, setNotice] = useState<string | null>(null)
  const [opErr, setOpErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  // 每行编辑态：档位 + 天数
  const [planDraft, setPlanDraft] = useState<Record<number, string>>({})
  const [daysDraft, setDaysDraft] = useState<Record<number, string>>({})

  // 列表加载后按当前档位初始化下拉
  useEffect(() => {
    if (!data?.items) return
    setPlanDraft((prev) => {
      const next = { ...prev }
      for (const r of data.items) {
        if (!(r.factoryId in next)) next[r.factoryId] = r.planCode
      }
      return next
    })
  }, [data])

  async function handleSet(row: PlanRow) {
    if (!session?.token || busy != null) return
    const planCode = planDraft[row.factoryId] ?? row.planCode
    const days = Number(daysDraft[row.factoryId] ?? '')
    if (!Number.isFinite(days) || days <= 0) {
      setOpErr(`企业 #${row.factoryId}：请输入有效续费天数（正整数）。`)
      return
    }
    const name = row.enterpriseName ?? `FACTORY #${row.factoryId}`
    if (!adminConfirm(`将「${name}」套餐调整为 ${planCode} 并续费 ${Math.floor(days)} 天`)) return
    setBusy(row.factoryId)
    setOpErr(null)
    setNotice(null)
    try {
      await wbMutation('admin.planSet', {
        token: session.token,
        factoryId: row.factoryId,
        planCode,
        days: Math.floor(days),
      })
      setNotice(`「${name}」套餐已提交调整：${planCode} / ${Math.floor(days)} 天。`)
      refetch()
    } catch (e) {
      setOpErr(wbErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const items = data?.items ?? []

  return (
    <div>
      <WbPageHeader
        hud="PLAN ADMIN"
        title="套餐管理"
        desc="全平台企业套餐档位与 LLM 日限额：调整档位 + 续费天数提交后由系统执行（expire_at = 当前时间 + 天数），到期自动降权。"
      />
      <WbNotice message={notice} className="mb-4" />
      <WbError message={opErr} className="mb-4" />

      <WbPanel
        title={`企业套餐（${items.length}）`}
        hud="FACTORY PLANS"
        actions={
          <WbButton variant="secondary" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </WbButton>
        }
      >
        <WbError message={error} className="mb-3" />
        {loading && <WbLoading />}
        {!loading && data && items.length === 0 && <WbEmpty text="暂无企业套餐数据" />}
        {!loading && items.length > 0 && (
          <AdminTable head={['企业', '当前档位', '用量（今日 LLM）', '编制上限', '到期时间', '状态', '续费/调整']}>
            {items.map((r) => {
              const badge = STATUS_BADGE[r.status] ?? { status: 'expired', label: r.status }
              const daysVal = daysDraft[r.factoryId] ?? ''
              const daysValid = Number.isFinite(Number(daysVal)) && Number(daysVal) > 0
              return (
                <tr key={r.factoryId}>
                  <td className={adminTdCls}>
                    <p className="text-ink-primary">{r.enterpriseName ?? `FACTORY #${r.factoryId}`}</p>
                    <p className="font-mono text-[10px] text-ink-faint">#{r.factoryId}</p>
                  </td>
                  <td className={adminTdCls + ' font-mono text-xs'}>{r.planCode}</td>
                  <td className={adminTdCls + ' font-mono text-xs'}>
                    {r.llmUsedToday} / {r.llmDailyLimit}
                  </td>
                  <td className={adminTdCls + ' font-mono text-xs'}>{r.seatLimit}</td>
                  <td className={adminTdCls + ' text-xs'}>{fmtTime(r.expireAt)}</td>
                  <td className={adminTdCls}>
                    <WbBadge status={badge.status} label={badge.label} />
                  </td>
                  <td className={adminTdCls}>
                    <div className="flex items-center gap-2">
                      <select
                        className={wbInputCls + ' w-44 shrink-0 py-1.5 text-xs'}
                        value={planDraft[r.factoryId] ?? r.planCode}
                        onChange={(e) => setPlanDraft((prev) => ({ ...prev, [r.factoryId]: e.target.value }))}
                      >
                        {PLAN_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <input
                        className={wbInputCls + ' w-20 shrink-0 py-1.5 text-xs'}
                        type="number"
                        min={1}
                        step={1}
                        placeholder="天数"
                        value={daysVal}
                        onChange={(e) => setDaysDraft((prev) => ({ ...prev, [r.factoryId]: e.target.value }))}
                      />
                      <WbButton
                        variant="secondary"
                        className="shrink-0 px-3 py-1.5 text-xs"
                        onClick={() => void handleSet(r)}
                        loading={busy === r.factoryId}
                        disabled={!daysValid}
                      >
                        续费/调整
                      </WbButton>
                    </div>
                  </td>
                </tr>
              )
            })}
          </AdminTable>
        )}
      </WbPanel>

      {/* 死端点处置类一·4：套餐订单管理（packages.adminList/adminSetStatus/adminSeed） */}
      <PackageOrdersSection session={session} />
    </div>
  )
}

// ─── 类一·4：套餐订单（pkg_orders 全量 + 人工调状态 + 空档 seed）───────────────
interface PkgOrderRow {
  id: number
  orderNo: string
  buyerName: string
  buyerPhone: string
  companyName: string
  amountYuan: number
  status: string
  packageName: string
  packageKey: string
  factoryId: number | null
  createdAt: string | null
  paidAt: string | null
}

const ORDER_STATUS: Record<string, { label: string; cls: string }> = {
  paid: { label: '已支付', cls: 'text-jade-green' },
  pending: { label: '待支付', cls: 'text-forge-amber' },
  cancelled: { label: '已取消', cls: 'text-ink-faint' },
}

function PackageOrdersSection({ session }: { session: import('@/lib/wbSession').WbSession | null }) {
  const { data, error, loading, refetch } = useWbQuery<{ items?: PkgOrderRow[] } | PkgOrderRow[]>('packages.adminList', session)
  const [busyNo, setBusyNo] = useState<string | null>(null)
  const [opErr, setOpErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const rows: PkgOrderRow[] = Array.isArray(data) ? data : (data?.items ?? [])

  const setStatus = async (orderNo: string, status: 'paid' | 'pending' | 'cancelled') => {
    if (!session?.token || busyNo) return
    setBusyNo(orderNo)
    setOpErr(null)
    setNotice(null)
    try {
      await wbMutation('packages.adminSetStatus', { token: session.token, orderNo, status })
      setNotice(`订单 ${orderNo} 已调整为「${ORDER_STATUS[status]?.label ?? status}」。`)
      refetch()
    } catch (e) {
      setOpErr(wbErrorMessage(e))
    } finally {
      setBusyNo(null)
    }
  }

  const seed = async () => {
    if (!session?.token || busyNo) return
    setBusyNo('seed')
    setOpErr(null)
    try {
      await wbMutation('packages.adminSeed', { token: session.token })
      setNotice('五档套餐定义已幂等写入。')
      refetch()
    } catch (e) {
      setOpErr(wbErrorMessage(e))
    } finally {
      setBusyNo(null)
    }
  }

  return (
    <WbPanel
      title={`套餐订单（${rows.length}）`}
      hud="PACKAGE ORDERS"
      className="mt-6"
      actions={
        <span className="flex items-center gap-2">
          {rows.length === 0 && !loading && (
            <WbButton variant="secondary" loading={busyNo === 'seed'} onClick={() => void seed()}>
              初始化五档套餐
            </WbButton>
          )}
          <WbButton variant="secondary" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </WbButton>
        </span>
      }
    >
      <WbNotice message={notice} className="mb-3" />
      <WbError message={opErr ?? error} className="mb-3" />
      {loading && <WbLoading />}
      {!loading && rows.length === 0 && <WbEmpty text="暂无套餐订单" hint="企业购买套餐后订单会出现在这里；如套餐定义为空，先点右上「初始化五档套餐」" />}
      {rows.length > 0 && (
        <AdminTable head={['订单号', '买家', '套餐', '金额', '状态', '创建时间', '调整状态']}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className={adminTdCls + ' font-mono text-xs'}>{r.orderNo}</td>
              <td className={adminTdCls}>
                <p className="text-ink-primary">{r.buyerName}</p>
                <p className="font-mono text-[10px] text-ink-faint">{r.companyName} · {r.buyerPhone}</p>
              </td>
              <td className={adminTdCls + ' text-xs'}>{r.packageName}<span className="ml-1 font-mono text-[10px] text-ink-faint">{r.packageKey}</span></td>
              <td className={adminTdCls + ' font-mono text-xs'}>¥{r.amountYuan}</td>
              <td className={adminTdCls + ' text-xs ' + (ORDER_STATUS[r.status]?.cls ?? '')}>{ORDER_STATUS[r.status]?.label ?? r.status}</td>
              <td className={adminTdCls + ' text-xs'}>{fmtTime(r.createdAt)}</td>
              <td className={adminTdCls}>
                <select
                  className={wbInputCls + ' w-28 shrink-0 py-1 text-xs'}
                  value={r.status}
                  disabled={busyNo === r.orderNo}
                  onChange={(e) => void setStatus(r.orderNo, e.target.value as 'paid' | 'pending' | 'cancelled')}
                >
                  <option value="paid">已支付</option>
                  <option value="pending">待支付</option>
                  <option value="cancelled">已取消</option>
                </select>
              </td>
            </tr>
          ))}
        </AdminTable>
      )}
    </WbPanel>
  )
}
