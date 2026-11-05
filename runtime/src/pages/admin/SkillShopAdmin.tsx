/**
 * SkillShopAdmin（/admin/skill-shop）—— 技能商店管理（迭代 31：技能商店 + 三方分账）。
 * 3 Tab：
 *  1. 上架审核（skillShop.reviewList 默认 pending_review，脱敏报告可展开，通过/驳回——驳回需填 note）
 *  2. 商品管理（listed 列表 + 下架 skillShop.review action=delisted）
 *  3. 分账总览（skillShop.incomeOverview：平台/企业/员工三张大卡 + 明细表，accrued 标注「结算兑换通道未来开放」）
 */
import { useState, type FormEvent } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Coins,
  FileText,
  PackageCheck,
  PieChart,
  ShieldCheck,
  Store,
  XCircle,
} from 'lucide-react'
import { callWb, useWbSession, useWbQuery } from '@/lib/wbSession'
import { WbError, WbLoading, WbNotice, WbPageHeader, WbPanel, wbInputCls } from '@/components/wb/ui'
import { cn } from '@/lib/utils'

// ─── 类型（兼容 snake_case / camelCase）──────────────────────────────────────

interface PackRow {
  id?: number
  packKey?: string
  pack_key?: string
  title?: string
  description?: string | null
  layer?: string
  track?: string
  creatorType?: string
  creator_type?: string
  priceTokens?: number
  price_tokens?: number
  salesCount?: number
  sales_count?: number
  sanitizeReport?: string | null
  sanitize_report?: string | null
  reviewNote?: string | null
  review_note?: string | null
  applicantType?: string
  applicant_type?: string
  applicantId?: number
  applicant_id?: number
  factoryId?: number | null
  factory_id?: number | null
  listedAt?: string | null
  listed_at?: string | null
  createdAt?: string
  created_at?: string
  status?: string
}

interface IncomeRow {
  id?: number
  period?: string
  ownerType?: string
  owner_type?: string
  ownerId?: number | null
  owner_id?: number | null
  amount?: number
  status?: string
  createdAt?: string
  created_at?: string
}

interface IncomeOverview {
  summary?: IncomeRow[]
  rows?: IncomeRow[]
}

function packKeyOf(p: PackRow): string {
  return String(p.packKey ?? p.pack_key ?? '')
}
function priceOf(p: PackRow): number {
  return Number(p.priceTokens ?? p.price_tokens ?? 0)
}
function salesOf(p: PackRow): number {
  return Number(p.salesCount ?? p.sales_count ?? 0)
}
function reportOf(p: PackRow): string | null {
  return (p.sanitizeReport ?? p.sanitize_report ?? null) as string | null
}
function listedAtOf(p: PackRow): string | null {
  return (p.listedAt ?? p.listed_at ?? null) as string | null
}
function ownerTypeOf(r: IncomeRow): string {
  return String(r.ownerType ?? r.owner_type ?? '')
}

const LAYER_LABEL: Record<string, string> = {
  general: '通用办公',
  professional: '岗位专业',
  industry: '行业技能',
}
const TRACK_LABEL: Record<string, string> = { A: '岗位共创（A）', B: '个人创作（B）' }
const CREATOR_LABEL: Record<string, string> = { platform: '平台官方', factory: '企业', staff: '员工' }
const OWNER_LABEL: Record<string, string> = { platform: '平台', factory: '企业', staff: '员工' }

type TabKey = 'review' | 'manage' | 'income'
const TABS: { key: TabKey; label: string; icon: typeof Store }[] = [
  { key: 'review', label: '上架审核', icon: ShieldCheck },
  { key: 'manage', label: '商品管理', icon: PackageCheck },
  { key: 'income', label: '分账总览', icon: PieChart },
]

// ─── Tab 1：上架审核 ─────────────────────────────────────────────────────────

function ReviewTab({ session }: { session: { token: string } | null }) {
  const [status, setStatus] = useState<'pending_review' | 'rejected' | 'draft'>('pending_review')
  const query = useWbQuery<PackRow[] | { rows: PackRow[] }>(
    'skillShop.reviewList',
    session,
    { status },
    { enabled: !!session?.token },
  )
  const rows: PackRow[] = Array.isArray(query.data) ? query.data : (query.data?.rows ?? [])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [rejectTarget, setRejectTarget] = useState<PackRow | null>(null)
  const [rejectNote, setRejectNote] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const review = async (packKey: string, action: 'listed' | 'rejected', note?: string) => {
    setBusyKey(packKey)
    setActionError(null)
    setNotice(null)
    try {
      await callWb('mutation', 'skillShop.review', session, { packKey, action, ...(note ? { note } : {}) })
      setNotice(action === 'listed' ? `「${packKey}」已通过上架。` : `「${packKey}」已驳回。`)
      setRejectTarget(null)
      setRejectNote('')
      query.refetch()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyKey(null)
    }
  }

  const STATUS_FILTERS = [
    { key: 'pending_review', label: '待审核' },
    { key: 'rejected', label: '已驳回' },
    { key: 'draft', label: '草稿（待确权）' },
  ] as const

  return (
    <WbPanel
      hud="REVIEW QUEUE"
      title="上架审核"
      actions={
        <div className="flex gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setStatus(f.key)}
              className={cn(
                'rounded-lg border px-3 py-1 text-xs transition-colors duration-300',
                status === f.key
                  ? 'border-forge-amber/50 bg-forge-amber/10 text-forge-amber'
                  : 'border-line-subtle text-ink-secondary hover:border-pulse-cyan/50 hover:text-ink-primary',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      }
    >
      {actionError && <WbError message={actionError} className="mb-3" />}
      {notice && <WbNotice message={notice} className="mb-3" />}
      {query.loading && !query.data ? (
        <WbLoading text="审核队列加载中…" />
      ) : query.error ? (
        <WbError message={query.error} />
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-faint">当前状态下暂无技能包。</p>
      ) : (
        <div className="space-y-4">
          {rows.map((p) => {
            const key = packKeyOf(p)
            const report = reportOf(p)
            const isOpen = expanded === key
            const applicant =
              p.applicantType || p.applicant_type
                ? `${CREATOR_LABEL[String(p.applicantType ?? p.applicant_type)] ?? String(p.applicantType ?? p.applicant_type)} #${p.applicantId ?? p.applicant_id ?? '—'}`
                : (CREATOR_LABEL[String(p.creatorType ?? p.creator_type ?? '')] ?? '—')
            return (
              <div key={key} className="rounded-xl border border-line-subtle bg-void/40 px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Store className="h-4 w-4 shrink-0 text-pulse-cyan" />
                  <p className="text-sm font-medium text-ink-primary">{p.title ?? key}</p>
                  <span className="inline-flex items-center rounded-full border border-pulse-cyan/40 bg-pulse-cyan/10 px-2 py-0.5 font-mono text-[10px] text-pulse-cyan">
                    {TRACK_LABEL[String(p.track)] ?? p.track ?? '—'}
                  </span>
                  <span className="inline-flex items-center rounded-full border border-line-subtle px-2 py-0.5 font-mono text-[10px] text-ink-secondary">
                    {LAYER_LABEL[String(p.layer)] ?? p.layer ?? '—'}
                  </span>
                  <span className="ml-auto font-mono text-[11px] text-ink-faint">{key}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-secondary">
                  <p>
                    价格：<span className="font-mono text-forge-amber">{priceOf(p)}</span> Token
                  </p>
                  <p>申请方：{applicant}</p>
                  {p.factoryId != null || p.factory_id != null ? <p>来源企业：#{p.factoryId ?? p.factory_id}</p> : null}
                </div>
                {p.description && <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-ink-faint">{p.description}</p>}
                {p.reviewNote || p.review_note ? (
                  <p className="mt-2 text-[11px] text-ember-red">审核备注：{p.reviewNote ?? p.review_note}</p>
                ) : null}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {report && (
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : key)}
                      className="flex items-center gap-1 rounded-md border border-line-subtle px-2.5 py-1 text-[11px] text-ink-secondary transition-colors hover:border-pulse-cyan/50 hover:text-ink-primary"
                    >
                      <FileText className="h-3 w-3" />
                      脱敏报告 {isOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    </button>
                  )}
                  {status === 'pending_review' && (
                    <>
                      <button
                        type="button"
                        disabled={busyKey === key}
                        onClick={() => void review(key, 'listed')}
                        className="flex items-center gap-1.5 rounded-md border border-jade-green/40 px-3 py-1.5 text-xs text-jade-green transition-colors hover:bg-jade-green/[0.08] disabled:opacity-50"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        通过上架
                      </button>
                      <button
                        type="button"
                        disabled={busyKey === key}
                        onClick={() => {
                          setRejectTarget(p)
                          setRejectNote('')
                        }}
                        className="flex items-center gap-1.5 rounded-md border border-ember-red/40 px-3 py-1.5 text-xs text-ember-red transition-colors hover:bg-ember-red/[0.08] disabled:opacity-50"
                      >
                        <XCircle className="h-3.5 w-3.5" />
                        驳回
                      </button>
                    </>
                  )}
                </div>
                {isOpen && report && (
                  <div className="mt-3 rounded-lg border border-line-subtle bg-panel/40 px-3.5 py-2.5">
                    <p className="mb-1 text-[11px] font-medium text-ink-faint">脱敏蒸馏报告</p>
                    <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink-secondary">{report}</p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 驳回弹窗（note 必填） */}
      {rejectTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-void/70 px-4">
          <div className="w-full max-w-sm rounded-2xl border border-line-subtle bg-deep p-6">
            <h3 className="text-sm font-bold text-ink-primary">驳回「{rejectTarget.title ?? packKeyOf(rejectTarget)}」</h3>
            <p className="mt-1 text-xs text-ink-faint">驳回必须填写原因（写入 review_note 留痕）。</p>
            <form
              onSubmit={(e: FormEvent) => {
                e.preventDefault()
                if (!rejectNote.trim()) {
                  setActionError('请填写驳回原因')
                  return
                }
                void review(packKeyOf(rejectTarget), 'rejected', rejectNote.trim())
              }}
              className="mt-4 space-y-4"
            >
              <textarea
                className={cn(wbInputCls, 'min-h-[80px]')}
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                placeholder="驳回原因（必填）"
                required
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={busyKey != null || !rejectNote.trim()}
                  className="flex-1 rounded-[10px] border border-ember-red/40 bg-ember-red/10 px-4 py-2 text-sm text-ember-red transition-colors hover:bg-ember-red/20 disabled:opacity-50"
                >
                  确认驳回
                </button>
                <button
                  type="button"
                  onClick={() => setRejectTarget(null)}
                  className="rounded-[10px] border border-line-subtle px-4 py-2 text-sm text-ink-secondary hover:text-ink-primary"
                >
                  取消
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </WbPanel>
  )
}

// ─── Tab 2：商品管理 ─────────────────────────────────────────────────────────

function ManageTab({ session }: { session: { token: string } | null }) {
  const query = useWbQuery<PackRow[] | { rows: PackRow[] }>(
    'skillShop.reviewList',
    session,
    { status: 'listed' },
    { enabled: !!session?.token },
  )
  const rows: PackRow[] = Array.isArray(query.data) ? query.data : (query.data?.rows ?? [])
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const delist = async (packKey: string) => {
    setBusyKey(packKey)
    setActionError(null)
    setNotice(null)
    try {
      await callWb('mutation', 'skillShop.review', session, { packKey, action: 'delisted', note: '运营下架' })
      setNotice(`「${packKey}」已下架。`)
      query.refetch()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <WbPanel hud="LISTED GOODS" title="商品管理（已上架）">
      {actionError && <WbError message={actionError} className="mb-3" />}
      {notice && <WbNotice message={notice} className="mb-3" />}
      {query.loading && !query.data ? (
        <WbLoading text="商品列表加载中…" />
      ) : query.error ? (
        <WbError message={query.error} />
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-faint">暂无已上架商品，可先执行 skillShop.seedShop 种子或通过审核上架。</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead>
              <tr className="border-b border-line-subtle text-xs text-ink-faint">
                <th className="pb-2 pr-3 font-medium">商品</th>
                <th className="pb-2 pr-3 font-medium">赛道</th>
                <th className="pb-2 pr-3 font-medium">创作者</th>
                <th className="pb-2 pr-3 font-medium">价格（Token）</th>
                <th className="pb-2 pr-3 font-medium">销量</th>
                <th className="pb-2 pr-3 font-medium">上架时间</th>
                <th className="pb-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const key = packKeyOf(p)
                const listedAt = listedAtOf(p)
                return (
                  <tr key={key} className="border-b border-line-subtle/60 last:border-0">
                    <td className="py-2.5 pr-3">
                      <p className="text-ink-primary">{p.title ?? key}</p>
                      <p className="font-mono text-[11px] text-ink-faint">{key}</p>
                    </td>
                    <td className="py-2.5 pr-3 text-ink-secondary">{TRACK_LABEL[String(p.track)] ?? p.track ?? '—'}</td>
                    <td className="py-2.5 pr-3 text-ink-secondary">
                      {CREATOR_LABEL[String(p.creatorType ?? p.creator_type ?? '')] ?? '—'}
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-forge-amber">{priceOf(p)}</td>
                    <td className="py-2.5 pr-3 font-mono text-ink-secondary">{salesOf(p)}</td>
                    <td className="py-2.5 pr-3 font-mono text-[11px] text-ink-faint">
                      {listedAt ? new Date(String(listedAt)).toLocaleString('zh-CN', { hour12: false }) : '—'}
                    </td>
                    <td className="py-2.5">
                      <button
                        type="button"
                        disabled={busyKey === key}
                        onClick={() => void delist(key)}
                        className="flex items-center gap-1 rounded-md border border-ember-red/40 px-2.5 py-1 text-[11px] text-ember-red transition-colors hover:bg-ember-red/[0.08] disabled:opacity-50"
                      >
                        <XCircle className="h-3 w-3" />
                        下架
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </WbPanel>
  )
}

// ─── Tab 3：分账总览 ─────────────────────────────────────────────────────────

function IncomeTab({ session }: { session: { token: string } | null }) {
  const query = useWbQuery<IncomeOverview | IncomeRow[]>('skillShop.incomeOverview', session, {}, { enabled: !!session?.token })

  // 兼容三种形态：{groups}（当前 API）/ {summary, rows} / 纯明细数组
  const rawRows: IncomeRow[] = Array.isArray(query.data)
    ? query.data
    : ((query.data as { groups?: IncomeRow[] })?.groups ?? query.data?.rows ?? query.data?.summary ?? [])

  // 聚合：owner_type × status
  const totals: Record<string, { accrued: number; settled: number }> = {}
  for (const r of rawRows) {
    const ot = ownerTypeOf(r) || 'platform'
    const t = (totals[ot] ??= { accrued: 0, settled: 0 })
    const amt = Number(r.amount ?? 0)
    if (r.status === 'settled') t.settled += amt
    else t.accrued += amt
  }

  const CARDS: { key: string; label: string; cls: string }[] = [
    { key: 'platform', label: '平台分账', cls: 'text-nebula-violet' },
    { key: 'factory', label: '企业分账', cls: 'text-pulse-cyan' },
    { key: 'staff', label: '员工分账', cls: 'text-forge-amber' },
  ]

  return (
    <WbPanel hud="REVENUE SHARE" title="分账总览（Token 调用计量台账）">
      {query.loading && !query.data ? (
        <WbLoading text="分账台账加载中…" />
      ) : query.error ? (
        <WbError message={query.error} />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            {CARDS.map((c) => {
              const t = totals[c.key] ?? { accrued: 0, settled: 0 }
              return (
                <div key={c.key} className="rounded-xl border border-line-subtle bg-void/40 p-5">
                  <p className="flex items-center gap-1.5 text-xs text-ink-faint">
                    <Coins className={cn('h-3.5 w-3.5', c.cls)} />
                    {c.label}
                  </p>
                  <p className="mt-2">
                    <span className={cn('font-display text-3xl font-bold', c.cls)}>{t.accrued + t.settled}</span>
                    <span className="ml-1.5 text-[11px] text-ink-faint">Token 合计</span>
                  </p>
                  <p className="mt-2 text-[11px] text-ink-secondary">
                    待结算 <span className="font-mono text-ink-primary">{t.accrued}</span>
                    <span className="mx-2 text-ink-faint">·</span>
                    已结算 <span className="font-mono text-ink-primary">{t.settled}</span>
                  </p>
                </div>
              )
            })}
          </div>

          {rawRows.length === 0 ? (
            <p className="py-10 text-center text-sm text-ink-faint">暂无分账流水（产生购买后自动记账）。</p>
          ) : (
            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead>
                  <tr className="border-b border-line-subtle text-xs text-ink-faint">
                    <th className="pb-2 pr-3 font-medium">账期</th>
                    <th className="pb-2 pr-3 font-medium">归属方</th>
                    <th className="pb-2 pr-3 font-medium">金额（Token）</th>
                    <th className="pb-2 font-medium">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {rawRows.map((r, i) => {
                    const accrued = r.status !== 'settled'
                    return (
                      <tr key={r.id ?? i} className="border-b border-line-subtle/60 last:border-0">
                        <td className="py-2.5 pr-3 font-mono text-ink-secondary">{r.period ?? '—'}</td>
                        <td className="py-2.5 pr-3 text-ink-primary">
                          {OWNER_LABEL[ownerTypeOf(r)] ?? ownerTypeOf(r) ?? '—'}
                          {r.ownerId != null || r.owner_id != null ? (
                            <span className="ml-1 font-mono text-[11px] text-ink-faint">#{r.ownerId ?? r.owner_id}</span>
                          ) : null}
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-forge-amber">{Number(r.amount ?? 0)}</td>
                        <td className="py-2.5">
                          {accrued ? (
                            <span className="inline-flex items-center rounded-full border border-forge-amber/40 bg-forge-amber/10 px-2 py-0.5 font-mono text-[10px] text-forge-amber">
                              待结算 · 结算兑换通道未来开放
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full border border-jade-green/40 bg-jade-green/10 px-2 py-0.5 font-mono text-[10px] text-jade-green">
                              已结算
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </WbPanel>
  )
}

// ─── 主页面 ──────────────────────────────────────────────────────────────────

export default function SkillShopAdmin() {
  const { session } = useWbSession()
  const [tab, setTab] = useState<TabKey>('review')

  return (
    <div>
      <WbPageHeader
        hud="SKILL SHOP ADMIN"
        title="技能商店"
        desc="技能包上架审核（脱敏报告辅助）· 商品管理 · 三方分账台账——金额以 Token（调用计量）计，结算兑换通道未来开放。"
      />

      <div className="mb-5 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border px-3.5 py-1.5 text-sm transition-colors duration-300',
              tab === t.key
                ? 'border-forge-amber/50 bg-forge-amber/10 font-medium text-forge-amber'
                : 'border-line-subtle text-ink-secondary hover:border-pulse-cyan/50 hover:text-ink-primary',
            )}
          >
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'review' && <ReviewTab session={session} />}
      {tab === 'manage' && <ManageTab session={session} />}
      {tab === 'income' && <IncomeTab session={session} />}
    </div>
  )
}
