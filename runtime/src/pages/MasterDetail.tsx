import { Link, useParams } from 'react-router'
import { motion } from 'framer-motion'
import { ArrowLeft, Award, Bot, Brain, Building2, Coins, Quote, Wrench } from 'lucide-react'
import HudCorner from '@/components/HudCorner'
import RatingStars from '@/components/RatingStars'
import SectionHeader from '@/components/SectionHeader'
import CountUp from '@/components/market/CountUp'
import ReputationBar from '@/components/masters/ReputationBar'
import EarningsDonut from '@/components/masters/EarningsDonut'
import EarningsTrend from '@/components/masters/EarningsTrend'
import MasterAgentCard from '@/components/masters/MasterAgentCard'
import { DashboardSkeleton, LoadError } from '@/components/masters/MastersSkeleton'
import { mastersTrpc } from '@/components/masters/masters-trpc'
import type { MasterDashboard } from '@/components/masters/masters-trpc'

const easeOut = [0.16, 1, 0.3, 1] as [number, number, number, number]

// ─── 身份卡 ──────────────────────────────────────────────────────────────────
function IdentityCard({ data }: { data: MasterDashboard }) {
  const { master, stats, earnings } = data
  return (
    <motion.div
      initial={{ opacity: 0, y: 32 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: easeOut }}
      className="glass-panel relative overflow-hidden rounded-2xl p-7 md:p-9"
    >
      <HudCorner />
      <div className="flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
        {/* 左：身份 */}
        <div className="flex items-center gap-5">
          <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl border border-nebula-violet/40 bg-nebula-violet/10 font-display text-3xl font-bold text-nebula-violet">
            {master.name.slice(0, 1)}
          </span>
          <div>
            <p className="hud-label text-pulse-cyan/80">MASTER PROFILE</p>
            <h1 className="mt-1.5 font-display text-2xl font-bold tracking-[0.02em] text-ink-primary md:text-3xl">
              {master.signature}
            </h1>
            <p className="mt-1.5 text-sm text-ink-secondary">
              {master.title ?? master.specialty}
              <span className="mx-2 text-ink-faint">·</span>
              {master.specialty}
              <span className="mx-2 text-ink-faint">·</span>
              {master.yearsExperience} 年一线经验
            </p>
            <p className="mt-2.5 flex items-center gap-2">
              <Award className="h-3.5 w-3.5 text-nebula-violet" />
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">声望</span>
              <ReputationBar value={master.reputation} className="[&>span:first-child]:w-32" />
            </p>
          </div>
        </div>

        {/* 右：总收益大数字 */}
        <div className="shrink-0 rounded-2xl border border-forge-amber/25 bg-forge-amber/5 px-7 py-5 lg:text-right">
          <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint lg:justify-end">
            <Coins className="h-3.5 w-3.5 text-forge-amber" /> 累计总收益
          </p>
          <p className="mt-2 font-grotesk text-4xl font-bold text-forge-amber md:text-5xl">
            <CountUp value={earnings.total} />
          </p>
          <p className="mt-1 font-mono text-xs text-ink-faint">TOKEN · {earnings.txCount} 笔流水</p>
        </div>
      </div>

      {/* 指标条 */}
      <div className="mt-8 grid grid-cols-2 gap-4 border-t border-line-subtle pt-6 md:grid-cols-4">
        {[
          { icon: Bot, label: '带出工匠', value: `${stats.agentCount} 位`, sub: `${stats.activeAgentCount} 位在岗` },
          { icon: Wrench, label: '累计交付任务', value: stats.tasksCompleted.toLocaleString(), sub: '次' },
          { icon: Brain, label: '工作记忆', value: stats.memoryBaseline.toLocaleString(), sub: `平台新增 ${stats.memoryTotal} 条` },
          { icon: Award, label: '工匠均分', value: stats.avgRating.toFixed(1), sub: '/ 5.0' },
        ].map((s) => (
          <div key={s.label}>
            <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
              <s.icon className="h-3.5 w-3.5 text-pulse-cyan" /> {s.label}
            </p>
            <p className="mt-1.5 font-grotesk text-xl font-bold text-ink-primary">
              {s.value}
              <span className="ml-1.5 font-mono text-[11px] font-normal text-ink-faint">{s.sub}</span>
            </p>
          </div>
        ))}
      </div>
    </motion.div>
  )
}

// ─── 收益区 ──────────────────────────────────────────────────────────────────
function EarningsSection({ data }: { data: MasterDashboard }) {
  return (
    <section className="mx-auto max-w-site px-5 pt-16 md:px-12 md:pt-24">
      <SectionHeader
        align="left"
        hud="EARNINGS LEDGER"
        title="经验变现账本"
        subtitle="每一笔 Token 流水，都是一次经验的交付 —— 雇佣月薪分成 85%，技能单次调用分润 80%。"
      />
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.6, ease: easeOut }}
          className="glass-panel relative rounded-2xl p-7"
        >
          <HudCorner />
          <p className="mb-5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">REVENUE MIX</p>
          <EarningsDonut hire={data.earnings.hire} skill={data.earnings.skill} other={data.earnings.other} />
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.6, delay: 0.1, ease: easeOut }}
          className="glass-panel relative rounded-2xl p-7"
        >
          <HudCorner />
          <EarningsTrend points={data.earnings.trend} />
          <div className="mt-5 grid grid-cols-3 gap-3 border-t border-line-subtle pt-4">
            <div>
              <p className="font-mono text-[10px] text-ink-faint">雇佣分成</p>
              <p className="mt-1 font-grotesk text-base font-bold text-nebula-violet">{data.earnings.hire.toLocaleString()}</p>
            </div>
            <div>
              <p className="font-mono text-[10px] text-ink-faint">技能分润</p>
              <p className="mt-1 font-grotesk text-base font-bold text-pulse-cyan">{data.earnings.skill.toLocaleString()}</p>
            </div>
            <div>
              <p className="font-mono text-[10px] text-ink-faint">其他</p>
              <p className="mt-1 font-grotesk text-base font-bold text-forge-amber">{data.earnings.other.toLocaleString()}</p>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  )
}

// ─── 雇主评价 ────────────────────────────────────────────────────────────────
function ReviewsSection({ data }: { data: MasterDashboard }) {
  return (
    <section className="mx-auto max-w-site px-5 pb-24 pt-16 md:px-12 md:pb-32 md:pt-24">
      <SectionHeader
        align="left"
        hud="EMPLOYER REVIEWS"
        title="雇主怎么说"
        subtitle="评价记在工匠头上，也记在师承头上 —— 好口碑会让整个师门的工匠更值钱。"
      />
      <div className="mt-8">
        {data.reviews.length === 0 ? (
          <p className="rounded-[12px] border border-dashed border-line-subtle px-4 py-14 text-center text-sm text-ink-faint">
            暂无雇主评价 —— 第一条五星好评正在路上
          </p>
        ) : (
          <ul className="grid gap-5 md:grid-cols-2">
            {data.reviews.map((r, i) => (
              <motion.li
                key={r.id}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ duration: 0.5, delay: (i % 2) * 0.08, ease: easeOut }}
                className="glass-panel relative rounded-2xl p-6"
              >
                <HudCorner />
                <div className="flex items-center justify-between gap-3">
                  <RatingStars rating={r.rating} />
                  <span className="rounded-full border border-line-subtle px-2.5 py-0.5 font-mono text-[10px] text-ink-faint">
                    {r.agentName} · {r.agentCode}
                  </span>
                </div>
                <p className="mt-4 flex gap-2 text-sm leading-relaxed text-ink-secondary">
                  <Quote className="mt-0.5 h-4 w-4 shrink-0 text-nebula-violet/60" />
                  {r.content}
                </p>
                <div className="mt-4 flex items-center justify-between border-t border-line-subtle pt-3.5">
                  <p className="flex items-center gap-1.5 text-xs text-ink-faint">
                    <Building2 className="h-3.5 w-3.5" />
                    {r.enterpriseName ?? '匿名企业'}
                    {r.employerTitle && <span className="text-ink-faint/70">· {r.employerTitle}</span>}
                  </p>
                  <p className="font-mono text-[10px] text-ink-faint">
                    {r.hireMonths ? `已雇佣 ${r.hireMonths} 个月 · ` : ''}
                    {new Date(r.createdAt).toLocaleDateString('zh-CN')}
                  </p>
                </div>
              </motion.li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

// ─── 页面 ────────────────────────────────────────────────────────────────────
export default function MasterDetail() {
  const { id: rawId } = useParams<{ id: string }>()
  const masterId = rawId && /^\d+$/.test(rawId) ? Number(rawId) : null

  const dash = mastersTrpc.masters.dashboard.useQuery(
    { masterId: masterId ?? 0 },
    { enabled: masterId != null, retry: 1 },
  )

  return (
    <div className="relative">
      <div aria-hidden className="nebula-halo pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[860px] -translate-x-1/2" />

      <section className="mx-auto max-w-site px-5 pt-10 md:px-12 md:pt-14">
        <Link
          to="/masters"
          className="inline-flex items-center gap-1.5 text-xs text-ink-faint transition-colors hover:text-pulse-cyan"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> 返回老师傅列表
        </Link>

        <div className="mt-6">
          {masterId == null ? (
            <LoadError message="无效的老师傅编号" onRetry={() => window.location.assign('/masters')} />
          ) : dash.isLoading ? (
            <DashboardSkeleton />
          ) : dash.isError || !dash.data ? (
            <LoadError message={dash.error?.message} onRetry={() => dash.refetch()} />
          ) : (
            <IdentityCard data={dash.data} />
          )}
        </div>
      </section>

      {dash.data && (
        <>
          <EarningsSection data={dash.data} />

          {/* 我的工匠 */}
          <section className="mx-auto max-w-site px-5 pt-16 md:px-12 md:pt-24">
            <SectionHeader
              align="left"
              hud="MY ARTISANS"
              title="我的数字工匠"
              subtitle={`亲手带出的 ${dash.data.stats.agentCount} 位徒弟，正在 ${dash.data.stats.activeAgentCount} 条产线上替师傅上班。`}
            />
            <div className="mt-8">
              {dash.data.agents.length === 0 ? (
                <p className="rounded-[12px] border border-dashed border-line-subtle px-4 py-14 text-center text-sm text-ink-faint">
                  名下暂无工匠 —— 到企业中心提交上架，把第一段经验封装起来
                </p>
              ) : (
                <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
                  {dash.data.agents.map((a, i) => (
                    <MasterAgentCard key={a.id} agent={a} index={i} />
                  ))}
                </div>
              )}
            </div>
          </section>

          <ReviewsSection data={dash.data} />
        </>
      )}
    </div>
  )
}
