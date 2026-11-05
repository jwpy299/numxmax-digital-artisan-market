import { motion } from 'framer-motion'
import { Award, Bot, Coins, Sparkles, Users } from 'lucide-react'
import SectionHeader from '@/components/SectionHeader'
import GlowButton from '@/components/GlowButton'
import MasterCard from '@/components/masters/MasterCard'
import { MastersSkeleton, LoadError } from '@/components/masters/MastersSkeleton'
import { mastersTrpc } from '@/components/masters/masters-trpc'

export default function Masters() {
  const list = mastersTrpc.masters.list.useQuery(undefined, { retry: 1 })
  const items = list.data?.items ?? []

  const totals = items.reduce(
    (a, m) => ({
      agents: a.agents + m.agentCount,
      earnings: a.earnings + m.totalEarnings,
      tasks: a.tasks + m.tasksCompleted,
    }),
    { agents: 0, earnings: 0, tasks: 0 },
  )

  return (
    <div className="relative">
      {/* 顶部光晕 */}
      <div aria-hidden className="nebula-halo pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[860px] -translate-x-1/2" />

      {/* ── 页头 ── */}
      <section className="mx-auto max-w-site px-5 pt-14 md:px-12 md:pt-20">
        <motion.div
          initial={{ opacity: 0, y: 32 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="max-w-3xl"
        >
          <p className="hud-label text-pulse-cyan/80">MASTER PORTAL</p>
          <h1 className="mt-3 font-display text-3xl font-bold tracking-[0.02em] text-ink-primary md:text-5xl">
            老师傅
          </h1>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-secondary md:text-base">
            三十年的手感与判断，封装成一个个可被雇佣的数字徒弟。
            这里是老师傅的入口 —— 查看名下工匠的表现、每一分经验换来的 Token 收益，以及沉淀下来的声望。
          </p>
        </motion.div>

        {/* 汇总数据带 */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
          className="glass-panel relative mt-10 grid grid-cols-2 gap-6 rounded-2xl p-7 md:grid-cols-4"
        >
          {[
            { icon: Users, label: '在册老师傅', value: items.length, suffix: '位', cls: 'text-nebula-violet' },
            { icon: Bot, label: '已带出工匠', value: totals.agents, suffix: '位', cls: 'text-pulse-cyan' },
            { icon: Award, label: '累计交付任务', value: totals.tasks, suffix: '次', cls: 'text-jade-green' },
            { icon: Coins, label: '老师傅累计分成', value: totals.earnings, suffix: 'Token', cls: 'text-forge-amber' },
          ].map((s) => (
            <div key={s.label}>
              <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                <s.icon className={`h-3.5 w-3.5 ${s.cls}`} /> {s.label}
              </p>
              <p className="mt-2 font-grotesk text-2xl font-bold text-ink-primary md:text-3xl">
                {list.isLoading ? '—' : s.value.toLocaleString()}
                <span className="ml-1 font-mono text-xs font-normal text-ink-faint">{s.suffix}</span>
              </p>
            </div>
          ))}
        </motion.div>
      </section>

      {/* ── 老师傅列表 ── */}
      <section className="mx-auto max-w-site px-5 pb-24 pt-16 md:px-12 md:pb-32 md:pt-24">
        <SectionHeader
          align="left"
          hud="MASTER DIRECTORY"
          title="经验的主人"
          subtitle="每位老师傅名下都站着亲手带出的数字工匠 —— 点击卡片进入个人看板，查看收益构成与雇主评价。"
        />
        <div className="mt-10">
          {list.isLoading ? (
            <MastersSkeleton cards={6} />
          ) : list.isError ? (
            <LoadError message={list.error?.message} onRetry={() => list.refetch()} />
          ) : items.length === 0 ? (
            <p className="rounded-[12px] border border-dashed border-line-subtle px-4 py-14 text-center text-sm text-ink-faint">
              暂无在册老师傅 —— 到企业中心上架第一位数字工匠，自动建立老师傅档案
            </p>
          ) : (
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
              {items.map((m, i) => (
                <MasterCard key={m.id} master={m} index={i} />
              ))}
            </div>
          )}
        </div>

        {/* CTA */}
        <div className="mt-14 flex flex-col items-center gap-4 rounded-2xl border border-line-subtle bg-deep/60 px-6 py-10 text-center">
          <Sparkles className="h-6 w-6 text-nebula-violet" />
          <p className="max-w-xl text-sm leading-relaxed text-ink-secondary">
            你也是车间里那个「问不倒」的人？把你的工艺经验上架为数字工匠，让经验 7×24 小时为你工作。
          </p>
          <GlowButton to="/enterprise" variant="primary">
            去企业中心上架 Agent
          </GlowButton>
        </div>
      </section>
    </div>
  )
}
