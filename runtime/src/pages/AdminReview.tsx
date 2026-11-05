import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, BadgeCheck, Inbox, Loader2, Lock, ShieldCheck, Store, UserRound, XCircle } from 'lucide-react'
import { Link } from 'react-router'
import { trpcRecruitLoop } from '@/lib/trpcRecruitLoop'
import { trpcDev } from '@/lib/trpcDev'
import { loadWbSession } from '@/lib/wbSession'
import { useAuth } from '@/hooks/useAuth'
import { LOGIN_PATH } from '@/const'
import GlowButton from '@/components/GlowButton'
import HudCorner from '@/components/HudCorner'
import ReviewStatsBar from '@/components/admin/ReviewStatsBar'
import PendingAgentCard from '@/components/admin/PendingAgentCard'
import RiskAgentCard from '@/components/admin/RiskAgentCard'
import { formatToken } from '@/components/market/types'
import { cn } from '@/lib/utils'

const easeOut = [0.16, 1, 0.3, 1] as [number, number, number, number]

type AdminTab = 'agents' | 'developerListings'

function AccessDenied({ isAuthenticated }: { isAuthenticated: boolean }) {
  return (
    <div className="mx-auto flex max-w-site flex-col items-center px-5 pb-32 pt-28 text-center md:px-12">
      <div className="glass-panel relative flex max-w-md flex-col items-center rounded-2xl p-10">
        <HudCorner />
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-ember-red/40 bg-ember-red/10">
          <Lock className="h-7 w-7 text-ember-red" />
        </div>
        <h1 className="mt-6 font-display text-2xl font-bold tracking-[0.02em] text-ink-primary">
          仅平台评审会成员可访问
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-secondary">
          审核管理台面向平台评审会开放，负责 Agent 上架审核与风险下架处置。
          {isAuthenticated ? '当前账号没有评审权限。' : '请先登录评审账号。'}
        </p>
        {!isAuthenticated && (
          <GlowButton to={LOGIN_PATH} className="mt-6">
            前往登录
          </GlowButton>
        )}
        <Link to="/enterprise" className="mt-4 text-xs text-ink-faint transition-colors hover:text-pulse-cyan">
          返回企业中心 →
        </Link>
      </div>
    </div>
  )
}

/** 开发者上架审核：token 取 localStorage("nebula_auth")（工作台会话），放入请求体 */
function DeveloperListingReview() {
  const session = loadWbSession()
  const token = session?.token ?? ''
  const [feedback, setFeedback] = useState<string | null>(null)

  const listingsQuery = trpcDev.developer.adminListings.useQuery(
    { token },
    { enabled: !!token, retry: 1 },
  )
  const reviewMut = trpcDev.developer.adminReviewListing.useMutation({
    onError: (err: { message?: string }) => setFeedback(err?.message ?? '操作失败，请稍后重试'),
    onSuccess: (_data: unknown, vars: { action?: string }) => {
      setFeedback(vars?.action === 'approve' ? '已人工确认通过，该作品状态更新为「已上架」' : '已人工确认驳回')
      listingsQuery.refetch()
    },
  })

  interface AdminListing {
    id?: number | string
    listingId?: number | string
    name?: string
    kind?: string
    summary?: string
    category?: string
    priceToken?: number
    status?: string
    devName?: string
    developerName?: string
    createdAt?: string | Date
  }

  const rows = useMemo(() => {
    const raw = listingsQuery.data as { items?: AdminListing[] } | AdminListing[] | undefined
    const all = (Array.isArray(raw) ? raw : raw?.items ?? []) as AdminListing[]
    // 仅列出待人工审核的上架申请
    return all.filter((l) => (l.status ?? 'pending_review') === 'pending_review')
  }, [listingsQuery.data])

  const act = (listing: AdminListing, action: 'approve' | 'reject') => {
    const id = listing.listingId ?? listing.id
    if (id == null) return
    const verb = action === 'approve' ? '通过并上架' : '驳回'
    // 人工确认：所有审核操作均需评审人显式确认
    if (!window.confirm(`请人工确认：确定${verb}「${listing.name ?? '该作品'}」吗？`)) return
    setFeedback(null)
    reviewMut.mutate({ token, listingId: id, action })
  }

  if (!token) {
    return (
      <div className="glass-panel flex flex-col items-center gap-3 rounded-2xl px-6 py-14 text-center">
        <Lock className="h-8 w-8 text-ink-faint" />
        <p className="max-w-md text-sm leading-relaxed text-ink-faint">
          开发者上架审核需要工作台管理端会话（localStorage nebula_auth）。请先在智能工作台登录管理账号后再回到本页。
        </p>
        <GlowButton to="/workbench" variant="secondary" className="mt-2 px-5 py-2.5 text-xs">
          前往工作台登录
        </GlowButton>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <p className="hud-label text-forge-amber/80">DEVELOPER LISTINGS</p>
          <h2 className="mt-1.5 font-display text-xl font-bold text-ink-primary md:text-2xl">开发者上架待审</h2>
          <p className="mt-2 text-xs text-ink-faint">
            开发者提交的 Agent / Skill 上架申请，需评审会逐项人工确认后生效。
          </p>
        </div>
        <span className="rounded-full border border-line-subtle px-3 py-1 font-mono text-xs text-ink-faint">
          {rows.length} 件待审
        </span>
      </div>

      {feedback && (
        <p className="mb-5 rounded-xl border border-forge-amber/30 bg-forge-amber/5 px-4 py-2.5 text-xs text-forge-amber">
          {feedback}
        </p>
      )}

      {listingsQuery.isLoading ? (
        <p className="flex items-center gap-2 py-10 text-sm text-ink-faint">
          <Loader2 className="h-4 w-4 animate-spin" /> 正在载入开发者上架申请…
        </p>
      ) : listingsQuery.isError ? (
        <div className="rounded-2xl border border-dashed border-line-subtle px-6 py-10 text-center text-sm text-ink-faint">
          开发者上架接口暂不可用，请稍后刷新重试
        </div>
      ) : rows.length === 0 ? (
        <div className="glass-panel flex flex-col items-center gap-3 rounded-2xl px-6 py-14 text-center">
          <Inbox className="h-8 w-8 text-ink-faint" />
          <p className="text-sm text-ink-faint">开发者上架审核队列已清空 —— 新的申请会实时出现在这里</p>
        </div>
      ) : (
        <div className="space-y-4">
          {rows.map((l, i) => (
            <motion.div
              key={l.listingId ?? l.id ?? i}
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i, 6) * 0.06, duration: 0.6, ease: easeOut }}
              className="cyber-glow-card relative rounded-2xl bg-zinc-950/80 p-6"
            >
              <HudCorner />
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-display text-lg font-bold text-ink-primary">{l.name ?? '未命名作品'}</span>
                    <span className="rounded-sm border border-line-subtle px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink-faint">
                      {l.kind === 'skill' ? 'Skill 技能' : 'Agent 应用'}
                    </span>
                    <span className="rounded-full border border-forge-amber/40 bg-forge-amber/10 px-2 py-0.5 text-[10px] text-forge-amber">
                      审核中
                    </span>
                  </p>
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-faint">
                    <UserRound className="h-3.5 w-3.5" />
                    开发者 · {l.devName ?? l.developerName ?? '匿名匠人'}
                    {l.createdAt && (
                      <span className="ml-2 font-mono">提交于 {new Date(l.createdAt).toLocaleDateString('zh-CN')}</span>
                    )}
                  </p>
                  {l.summary && (
                    <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-secondary">{l.summary}</p>
                  )}
                  <p className="mt-3 font-mono text-xs text-amber-400/80">
                    {typeof l.priceToken === 'number' ? `定价 ${formatToken(l.priceToken)} Token` : '定价待确认'}
                    {l.category ? ` · 分类 ${l.category}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2.5">
                  <button
                    disabled={reviewMut.isPending}
                    onClick={() => act(l, 'approve')}
                    className={cn(
                      'flex items-center gap-1.5 rounded-lg border border-jade-green/40 bg-jade-green/10 px-4 py-2 text-xs font-medium text-jade-green transition-colors hover:bg-jade-green/20',
                      'disabled:cursor-not-allowed disabled:opacity-50',
                    )}
                  >
                    <BadgeCheck className="h-3.5 w-3.5" /> 通过上架
                  </button>
                  <button
                    disabled={reviewMut.isPending}
                    onClick={() => act(l, 'reject')}
                    className={cn(
                      'flex items-center gap-1.5 rounded-lg border border-ember-red/40 bg-ember-red/10 px-4 py-2 text-xs font-medium text-ember-red transition-colors hover:bg-ember-red/20',
                      'disabled:cursor-not-allowed disabled:opacity-50',
                    )}
                  >
                    <XCircle className="h-3.5 w-3.5" /> 驳回
                  </button>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function AdminReview() {
  const { user, isAuthenticated, isLoading } = useAuth()
  const isAdmin = isAuthenticated && user?.role === 'admin'
  const [tab, setTab] = useState<AdminTab>('agents')

  const stats = trpcRecruitLoop.review.stats.useQuery(undefined, {
    enabled: isAdmin,
    retry: false,
  })
  const queue = trpcRecruitLoop.review.pendingQueue.useQuery(undefined, {
    enabled: isAdmin,
    retry: false,
  })

  if (isLoading) {
    return (
      <div className="mx-auto flex max-w-site items-center justify-center px-5 pb-32 pt-40 md:px-12">
        <p className="flex items-center gap-2 text-sm text-ink-faint">
          <Loader2 className="h-4 w-4 animate-spin" /> 正在校验评审权限…
        </p>
      </div>
    )
  }

  // 未登录 / 非 admin / 后端 FORBIDDEN 一律按无权限处理
  const forbidden = queue.error?.data?.code === 'FORBIDDEN' || stats.error?.data?.code === 'FORBIDDEN'
  if (!isAdmin || forbidden) {
    return <AccessDenied isAuthenticated={isAuthenticated} />
  }

  const pending = queue.data?.pending ?? []
  const risk = queue.data?.risk ?? []

  return (
    <div className="relative">
      <div aria-hidden className="nebula-halo pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[860px] -translate-x-1/2" />

      <section className="mx-auto max-w-site px-5 pt-14 md:px-12 md:pt-20">
        <motion.div
          initial={{ opacity: 0, y: 32 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: easeOut }}
        >
          <p className="hud-label text-pulse-cyan/80">REVIEW CONSOLE</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-[0.02em] text-ink-primary md:text-4xl">
            审核管理台
          </h1>
          <p className="mt-3 flex items-center gap-2 text-sm text-ink-secondary">
            <ShieldCheck className="h-4 w-4 text-jade-green" />
            评审人：{user?.name ?? '评审会成员'} —— 负责 Agent 上架审核、开发者上架审核与风险下架处置
          </p>
        </motion.div>

        {/* Tab 切换 */}
        <div className="mt-8 flex gap-2" role="tablist">
          {(
            [
              { key: 'agents', label: 'Agent 审核', icon: ShieldCheck },
              { key: 'developerListings', label: '开发者上架', icon: Store },
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'flex items-center gap-2 rounded-xl border px-5 py-2.5 text-sm font-medium transition-colors',
                tab === t.key
                  ? 'border-forge-amber/50 bg-forge-amber/10 text-forge-amber'
                  : 'border-line-subtle text-ink-secondary hover:border-zinc-500/50 hover:text-ink-primary',
              )}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'agents' && (
          <div className="mt-8">
            {stats.data ? (
              <ReviewStatsBar stats={stats.data} />
            ) : (
              <p className="flex items-center gap-2 py-4 text-sm text-ink-faint">
                <Loader2 className="h-4 w-4 animate-spin" /> 正在加载审核仪表…
              </p>
            )}
          </div>
        )}
      </section>

      {tab === 'developerListings' ? (
        <section className="mx-auto max-w-site px-5 pb-24 pt-10 md:px-12 md:pb-32 md:pt-12">
          <DeveloperListingReview />
        </section>
      ) : (
        <>
          {/* ── 待审队列 ── */}
          <section className="mx-auto max-w-site px-5 pt-14 md:px-12 md:pt-20">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <p className="hud-label text-forge-amber/80">PENDING QUEUE</p>
                <h2 className="mt-1.5 font-display text-xl font-bold text-ink-primary md:text-2xl">待审上架申请</h2>
              </div>
              <span className="rounded-full border border-line-subtle px-3 py-1 font-mono text-xs text-ink-faint">
                {pending.length} 位待审
              </span>
            </div>
            {queue.isLoading ? (
              <p className="flex items-center gap-2 py-10 text-sm text-ink-faint">
                <Loader2 className="h-4 w-4 animate-spin" /> 正在载入待审队列…
              </p>
            ) : pending.length === 0 ? (
              <div className="glass-panel flex flex-col items-center gap-3 rounded-2xl px-6 py-14 text-center">
                <Inbox className="h-8 w-8 text-ink-faint" />
                <p className="text-sm text-ink-faint">审核队列已清空 —— 新的上架申请会实时出现在这里</p>
              </div>
            ) : (
              <div className="space-y-5">
                {pending.map((a, i) => <PendingAgentCard key={a.id} agent={a} index={i} />)}
              </div>
            )}
          </section>

          {/* ── 下架风险区 ── */}
          <section className="mx-auto max-w-site px-5 pb-24 pt-14 md:px-12 md:pb-32 md:pt-20">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <p className="hud-label text-ember-red/80">DELIST RISK</p>
                <h2 className="mt-1.5 flex items-center gap-2 font-display text-xl font-bold text-ink-primary md:text-2xl">
                  <AlertTriangle className="h-5 w-5 text-ember-red" /> 风险工匠处置
                </h2>
                <p className="mt-2 text-xs text-ink-faint">连续低分评价触发下架风险标记的 Agent，评审会可执行下架。</p>
              </div>
              <span className="rounded-full border border-line-subtle px-3 py-1 font-mono text-xs text-ink-faint">
                {risk.length} 位风险
              </span>
            </div>
            {queue.isLoading ? null : risk.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-line-subtle px-6 py-10 text-center text-sm text-ink-faint">
                当前没有触发下架风险的工匠
              </div>
            ) : (
              <div className="space-y-3">
                {risk.map((a, i) => <RiskAgentCard key={a.id} agent={a} index={i} />)}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
