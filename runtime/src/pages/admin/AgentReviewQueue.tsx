/**
 * AgentReviewQueue（/admin/agent-review-queue）—— P2-4（台账 W3）数字员工审核流水线。
 *
 * 缺口：agents.status 的 pending 是「只进不出」的死状态（77 条卡住、无入口无留痕）。
 * 本页是那个入口：列出 pending 队列 + AI 初审判定（可解释分项）→ 逐条通过/驳回。
 *
 * 数据：agentReviewQueue.list / .stats / .approve / .reject（requireAdmin）。
 * 边界：HIGH 档自动通过**默认关**；本页**不调用** `bulkApprove`，也**没有**批量按钮/勾选框。
 *       ⚠️ 门禁 PR#35 票（documentation/low）：原文案曾写「批量按钮仅在服务端返回
 *       autoApproveEnabled=true 且用户显式勾选后才可用」—— 但**本页根本没有那个按钮**，
 *       那描述的是意图而非行为。现据实更正：**批量通过有意未接线**（服务端端点已备，
 *       待阈值校准后再开面），免得后来者去找一个不存在的 UI。
 *       注：服务端 `bulkApprove` 自身已具备双闸（env 开关 + acknowledgeAutoHigh）+ 档位校验。
 * 诚实性：评分口径与阈值全部上屏（审核人必须看得懂为什么这条被排前面）；
 *         无法判定的维度如实显示「不下判定」，不假装算过。
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, BadgeCheck, ChevronDown, ChevronUp, RefreshCw, ShieldCheck, XCircle } from 'lucide-react'
import { callWb, wbErrorMessage, useWbQuery, useWbSession } from '@/lib/wbSession'
import { WbError, WbEmpty, WbLoading, WbNotice, WbPageHeader, WbPanel } from '@/components/wb/ui'
import { cn } from '@/lib/utils'

interface Dimension {
  key: string
  label: string
  weight: number
  score: number
  basis: string
}

// 门禁 PR#35 票（maintainability/low）：本文件原声明了 8 个**从未被读取**的类型成员，
//   它们会与真实 API 载荷**静默漂移**（接口说有、实际没有；或反之）。
//   现状：声明只保留组件真正读到的字段。tsc 全量通过即证明删除无损。
interface QueueItem {
  id: number
  code: string
  name: string
  industry: string
  industryGroup: string
  monthlyPrice: number
  suggestedPrice: number
  masterId: number
  capabilityTags: string[]
  ai: { score: number; tier: 'high' | 'mid' | 'low'; dimensions: Dimension[]; flags: string[] }
}

interface ListResp {
  total: number
  items: QueueItem[]
}

interface StatsResp {
  pending: number
  activeTotal: number
  tiers: { high: number; mid: number; low: number; autoApproveEnabled: boolean }
  reviewedRecently: { approved7d: number; rejected7d: number }
  mastersUsable: number
  reviewColumnsReady: boolean
  thresholds: { high: number; low: number; autoApproveEnabled: boolean; basisNote: string }
}

const TIER_LABEL: Record<string, string> = {
  high: '自动通过档',
  mid: '人工复核档',
  low: '自动拦截档',
}

const TIER_STYLE: Record<string, string> = {
  high: 'border-jade-green/40 bg-jade-green/10 text-jade-green',
  mid: 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber',
  low: 'border-ember-red/40 bg-ember-red/10 text-ember-red',
}

const PAGE_SIZE = 20

export default function AdminAgentReviewQueue() {
  const { session } = useWbSession()
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [tier, setTier] = useState<'' | 'high' | 'mid' | 'low'>('')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [rejectTarget, setRejectTarget] = useState<QueueItem | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  // 门禁 PR#35 票（bug/medium）：原为**单个标量** `useState<number|null>(null)`，
  //   用它禁用「正在操作的那一行」的按钮。但两行并发时会互相解锁：
  //     第二行 setBusy(B) 会把仍在飞行中的 A 行按钮重新启用；
  //     而 A 的 finally setBusy(null) 又会在 B 仍在跑时把 B 解锁 —— **允许重复提交**
  //     （服务端靠 CONFLICT 兜住，但那是把并发问题推给后端，且用户会看到莫名报错）。
  //   改为**在飞行 id 的集合**：每行只由自己是否在集合里决定禁用，互不影响。
  const [busyIds, setBusyIds] = useState<ReadonlySet<number>>(() => new Set<number>())
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const listInput = useMemo(
    () => ({ page, pageSize: PAGE_SIZE, ...(search ? { search } : {}), ...(tier ? { tier } : {}) }),
    [page, search, tier],
  )
  const list = useWbQuery<ListResp>('agentReviewQueue.list', session, listInput, { enabled: !!session?.token })
  const stats = useWbQuery<StatsResp>('agentReviewQueue.stats', session, {}, { enabled: !!session?.token })

  const items = list.data?.items ?? []
  const total = list.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  // 门禁 PR#35 票（bug/medium）：total 缩短后把越界页码拉回有效区间。
  //   不复位的话：审到最后一页使 total 变成 PAGE_SIZE 的整数倍时 page > pages，
  //   切片返回空列表 → 渲染「没有待审员工」空态、且**分页控件整个消失**，
  //   操作员被困在幻影页上，而前面几页其实还有待审行。
  useEffect(() => {
    if (page > pages) setPage(pages)
  }, [page, pages])

  async function act(item: QueueItem, action: 'approve' | 'reject', reason?: string) {
    if (!session?.token) return
    setBusyIds((prev) => new Set(prev).add(item.id))
    setActionError(null)
    setNotice(null)
    try {
      if (action === 'approve') {
        await callWb('mutation', 'agentReviewQueue.approve', session, { agentId: item.id })
        // 门禁 PR#35 票（bug/medium）：原文案**无条件**宣称「留痕已写 reviewedAt/reviewedBy」，
        //   但服务端在审核三列未落库时会降级为「仅迁 status + 写 st_admin_audit.detail_json」。
        //   stats.reviewColumnsReady 已如实上报当前模式，此处据实措辞，不再宣称没发生的事。
        const trace =
          stats.data?.reviewColumnsReady === false
            ? '留痕列未签，本次仅迁状态 + 写审计'
            : '留痕已写 reviewedAt/reviewedBy'
        setNotice(`「${item.name}」已通过审核，状态 pending → active（${trace}）。`)
      } else {
        await callWb('mutation', 'agentReviewQueue.reject', session, { agentId: item.id, rejectReason: reason })
        setNotice(`「${item.name}」已驳回，状态 pending → rejected（理由已留痕）。`)
      }
      setRejectTarget(null)
      setRejectReason('')
      list.refetch()
      stats.refetch()
    } catch (err) {
      setActionError(wbErrorMessage(err))
    } finally {
      // 只移除**本行自己**，不动别人 —— 这正是标量版做不到的
      setBusyIds((prev) => {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
    }
  }

  if (!session?.token) {
    return (
      <div className="p-6">
        <WbError message="需要管理员会话（superAdmin 登录后进入本页）。" />
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      <WbPageHeader
        hud="AGENT REVIEW PIPELINE · P2-4"
        title="待审数字员工"
        desc="pending 队列逐条审核：AI 初审给出可解释分项（五维加权），审核人拍板 —— 首次上线不做全自动，HIGH 档自动通过默认关。"
      />

      {stats.data && (
        <WbPanel hud="QUEUE" title="队列口径">
          <div className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="待审（pending）" value={stats.data.pending} tone="amber" />
            <Stat label="在役存量（active）" value={stats.data.activeTotal} tone="green" />
            <Stat label="近 7 天通过" value={stats.data.reviewedRecently.approved7d} tone="green" />
            <Stat label="近 7 天驳回" value={stats.data.reviewedRecently.rejected7d} tone="red" />
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
            <Pill className={TIER_STYLE.high}>
              自动通过档 ≥{stats.data.thresholds.high}：{stats.data.tiers.high} 条
            </Pill>
            <Pill className={TIER_STYLE.mid}>
              人工复核档 {stats.data.thresholds.low}–{stats.data.thresholds.high - 1}：{stats.data.tiers.mid} 条
            </Pill>
            <Pill className={TIER_STYLE.low}>
              自动拦截档 &lt;{stats.data.thresholds.low}：{stats.data.tiers.low} 条
            </Pill>
            <Pill
              className={
                stats.data.thresholds.autoApproveEnabled
                  ? 'border-jade-green/40 bg-jade-green/10 text-jade-green'
                  : 'border-line-subtle text-ink-faint'
              }
            >
              HIGH 档自动通过：{stats.data.thresholds.autoApproveEnabled ? '已开启' : '默认关'}
            </Pill>
            <Pill className="border-line-subtle text-ink-faint">
              审核留痕列：{stats.data.reviewColumnsReady ? '已就位' : '未签（写回降级：只迁状态 + 审计）'}
            </Pill>
            <Pill className="border-line-subtle text-ink-faint">masters 可用记录：{stats.data.mastersUsable}</Pill>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">{stats.data.thresholds.basisNote}</p>
        </WbPanel>
      )}

      <WbPanel
        hud="PENDING QUEUE"
        title="待审员工审核队列"
        actions={
          <div className="flex items-center gap-2">
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(1)
              }}
              placeholder="搜名称/编号/行业…"
              className="w-40 rounded-lg border border-line-subtle bg-void/60 px-3 py-1.5 text-xs text-ink-primary outline-none focus:border-pulse-cyan/50"
            />
            <select
              value={tier}
              onChange={(e) => {
                setTier(e.target.value as '' | 'high' | 'mid' | 'low')
                setPage(1)
              }}
              className="rounded-lg border border-line-subtle bg-void/60 px-2 py-1.5 text-xs text-ink-primary outline-none"
            >
              <option value="">全部档位</option>
              <option value="high">自动通过档</option>
              <option value="mid">人工复核档</option>
              <option value="low">自动拦截档</option>
            </select>
            <button
              type="button"
              onClick={() => {
                list.refetch()
                stats.refetch()
              }}
              className="flex items-center gap-1.5 rounded-lg border border-line-subtle px-3 py-1.5 text-xs text-ink-secondary hover:bg-pulse-cyan/[0.06] hover:text-ink-primary"
            >
              <RefreshCw className="h-3.5 w-3.5" /> 刷新
            </button>
          </div>
        }
      >
        {actionError && <WbError message={actionError} className="mb-3" />}
        {notice && <WbNotice message={notice} className="mb-3" />}
        {list.loading && !list.data ? (
          <WbLoading text="审核队列加载中…" />
        ) : list.error ? (
          <WbError message={list.error} />
        ) : items.length === 0 ? (
          <WbEmpty
            text="当前筛选下没有待审员工"
            hint="新的数字员工进入 pending 后会自动出现在这里（队列口径 = agents.status='pending'）。"
          />
        ) : (
          <>
            <p className="mb-3 text-xs text-ink-faint">
              共 <span className="font-mono text-ink-primary">{total}</span> 条待审 · 按 AI 初审分降序（同分按入队顺序）
              · 本页 {items.length} 条
            </p>
            <div className="space-y-3">
              {items.map((it) => (
                <div key={it.id} className="rounded-xl border border-line-subtle bg-void/40 px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <ShieldCheck className="h-4 w-4 shrink-0 text-pulse-cyan" />
                    <p className="text-sm font-medium text-ink-primary">{it.name}</p>
                    <span className="font-mono text-[11px] text-ink-faint">{it.code}</span>
                    <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-medium', TIER_STYLE[it.ai.tier])}>
                      {TIER_LABEL[it.ai.tier]} · {it.ai.score}
                    </span>
                    <span className="ml-auto font-mono text-[11px] text-ink-faint">#{it.id}</span>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-secondary">
                    <p>
                      行业：<span className="text-ink-primary">{it.industry}</span>
                      <span className="ml-1 text-ink-faint">（大类 {it.industryGroup}）</span>
                    </p>
                    <p>
                      月薪：<span className="font-mono text-forge-amber">{it.monthlyPrice}</span>
                      <span className="ml-1 text-ink-faint">建议 {it.suggestedPrice}</span>
                    </p>
                    <p>
                      师承：<span className="font-mono text-ink-primary">#{it.masterId}</span>
                    </p>
                    <p>
                      标签：<span className="text-ink-primary">{it.capabilityTags.join('·') || '—'}</span>
                    </p>
                  </div>

                  {it.ai.flags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      {it.ai.flags.map((f) => (
                        <span key={f} className="flex items-center gap-1 text-[11px] text-forge-amber">
                          <AlertTriangle className="h-3 w-3 shrink-0" /> {f}
                        </span>
                      ))}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => setExpanded(expanded === it.id ? null : it.id)}
                    className="mt-2 flex items-center gap-1 text-[11px] text-ink-faint hover:text-pulse-cyan"
                  >
                    {expanded === it.id ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    AI 初审分项（{it.ai.dimensions.length} 维，点击{expanded === it.id ? '收起' : '展开'}看判据）
                  </button>
                  {expanded === it.id && (
                    <table className="mt-2 w-full text-[11px]">
                      <thead>
                        <tr className="border-b border-line-subtle text-left text-ink-faint">
                          <th className="py-1 pr-3">维度</th>
                          <th className="py-1 pr-3">权重</th>
                          <th className="py-1 pr-3">得分</th>
                          <th className="py-1">判据</th>
                        </tr>
                      </thead>
                      <tbody>
                        {it.ai.dimensions.map((d) => (
                          <tr key={d.key} className="border-b border-line-subtle/40">
                            <td className="py-1 pr-3 text-ink-secondary">{d.label}</td>
                            <td className="py-1 pr-3 font-mono text-ink-faint">{d.weight.toFixed(2)}</td>
                            <td className="py-1 pr-3 font-mono text-ink-primary">{d.score}</td>
                            <td className="py-1 text-ink-secondary">{d.basis}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  <div className="mt-3 flex shrink-0 gap-2.5">
                    <button
                      type="button"
                      disabled={busyIds.has(it.id)}
                      onClick={() => act(it, 'approve')}
                      className="flex items-center gap-1.5 rounded-lg border border-jade-green/40 bg-jade-green/10 px-4 py-2 text-xs font-medium text-jade-green transition-colors hover:bg-jade-green/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <BadgeCheck className="h-3.5 w-3.5" /> 通过（pending → active）
                    </button>
                    <button
                      type="button"
                      disabled={busyIds.has(it.id)}
                      onClick={() => {
                        setRejectTarget(it)
                        setRejectReason('')
                        setActionError(null)
                      }}
                      className="flex items-center gap-1.5 rounded-lg border border-ember-red/40 bg-ember-red/10 px-4 py-2 text-xs font-medium text-ember-red transition-colors hover:bg-ember-red/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <XCircle className="h-3.5 w-3.5" /> 驳回（必填理由）
                    </button>
                  </div>

                  {rejectTarget?.id === it.id && (
                    <div className="mt-3 rounded-lg border border-ember-red/30 bg-ember-red/[0.06] px-4 py-3">
                      <p className="mb-2 text-xs text-ember-red">驳回理由（必填，≥2 字；将落 rejectReason + 管理审计）</p>
                      <textarea
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        rows={2}
                        className="w-full rounded-lg border border-line-subtle bg-void/60 px-3 py-2 text-xs text-ink-primary outline-none focus:border-ember-red/50"
                        placeholder="例：简介与能力标签不匹配，需重写后再审"
                      />
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          disabled={rejectReason.trim().length < 2 || busyIds.has(it.id)}
                          onClick={() => act(it, 'reject', rejectReason.trim())}
                          className="rounded-lg border border-ember-red/40 bg-ember-red/10 px-3 py-1.5 text-xs text-ember-red hover:bg-ember-red/20 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          确认驳回
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRejectTarget(null)
                            setRejectReason('')
                          }}
                          className="rounded-lg border border-line-subtle px-3 py-1.5 text-xs text-ink-secondary hover:text-ink-primary"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="mt-4 flex items-center justify-between text-xs text-ink-faint">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="rounded-lg border border-line-subtle px-3 py-1.5 disabled:opacity-40"
              >
                上一页
              </button>
              <span className="font-mono">
                {page} / {pages}
              </span>
              <button
                type="button"
                disabled={page >= pages}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-lg border border-line-subtle px-3 py-1.5 disabled:opacity-40"
              >
                下一页
              </button>
            </div>
          </>
        )}
      </WbPanel>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'amber' | 'green' | 'red' }) {
  // 门禁 PR#35 票（style/low）：本仓约定禁嵌套三元（见 Cockpit.tsx / AdminLayout.tsx 注释），改查表
  const color = { amber: 'text-forge-amber', green: 'text-jade-green', red: 'text-ember-red' }[tone]
  return (
    <div className="rounded-lg border border-line-subtle px-3 py-2">
      <p className="text-ink-faint">{label}</p>
      <p className={cn('mt-1 text-xl font-bold', color)}>{value < 0 ? '—' : value}</p>
    </div>
  )
}

function Pill({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn('rounded-full border px-2.5 py-0.5', className)}>{children}</span>
}
