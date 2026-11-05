import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeftRight, Coins, Factory, Landmark, Loader2, Scale, ShieldCheck, UploadCloud } from 'lucide-react'
import HudCorner from '@/components/HudCorner'
import GlowButton from '@/components/GlowButton'
import { cn } from '@/lib/utils'
import { trpcDev } from '@/lib/trpcDev'

const easeOut = [0.16, 1, 0.3, 1] as [number, number, number, number]

/** Token 购买交易服务状态（后端 overview 可用时以接口为准） */
function PurchaseStatusCard() {
  const overviewQuery = trpcDev.tokenEconomy.overview.useQuery(undefined, { retry: 1, staleTime: 60_000 })

  const overview = useMemo(() => {
    const raw = overviewQuery.data as
      | { purchaseStatus?: string; note?: string; [key: string]: unknown }
      | undefined
    if (!raw || overviewQuery.isError) return null
    return raw
  }, [overviewQuery.data, overviewQuery.isError])

  // 接口未就绪 / 未返回状态 → 一律按「未来开放」静态展示
  const statusText = overview?.purchaseStatus ?? '未来开放'
  const noteText =
    overview?.note ??
    'Token 购买与交易服务尚未开放。当前 Token 仅可通过上架 Agent / Skill 作品被工厂使用或租用获得。'

  return (
    <div className="cyber-glow-card cyber-scanline relative rounded-2xl bg-zinc-950/80 p-7 md:p-9">
      <HudCorner />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10">
            <ArrowLeftRight className="h-5 w-5 text-amber-400" />
          </span>
          <div>
            <p className="hud-label text-amber-400/80">PURCHASE SERVICE</p>
            <h3 className="mt-1 font-display text-xl font-bold text-ink-primary">Token 购买交易服务</h3>
          </div>
        </div>
        <span className="rounded-full border border-zinc-500/50 bg-zinc-900/80 px-3 py-1 font-mono text-xs tracking-widest text-zinc-300">
          {statusText}
        </span>
      </div>
      <p className="mt-5 text-sm leading-relaxed text-ink-secondary">{noteText}</p>
      {overviewQuery.isLoading && (
        <p className="mt-3 flex items-center gap-2 text-xs text-ink-faint">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在同步服务状态…
        </p>
      )}
      <p className="mt-4 rounded-lg border border-line-subtle bg-zinc-950/60 px-3.5 py-2.5 text-[11px] leading-relaxed text-ink-faint">
        平台不提供 Token 二级交易、炒作或任何形式的投机渠道；Token 不构成任何收益承诺，请以实际使用与结算规则为准。
      </p>
    </div>
  )
}

export default function TokenPage() {
  const sections = [
    {
      icon: Coins,
      accent: 'amber' as const,
      title: '什么是工业 Token',
      points: [
        '工业 Token 是 NumX Max 平台内部的计量与激励单位，用于度量数字员工与技能被使用的真实工作量。',
        'Token 仅在平台内流转记账，不代表任何外部资产，也不可转让炒作。',
        '每一次雇佣、每一次技能调用，都以 Token 计价入账，全程可审计。',
      ],
    },
    {
      icon: UploadCloud,
      accent: 'emerald' as const,
      title: '如何获得 Token',
      points: [
        '在开发者中心上架你的 Agent 应用或 Skill 技能，通过 NumX Max 智造研究院人工审核后进入市场。',
        '工厂按月雇佣你的 Agent，或按次调用你的 Skill —— 每一次真实使用都按定价计入 Token 收益。',
        '登上匠人排行榜可获得曝光与分成激励，但收益始终源于真实使用，无任何保底承诺。',
      ],
    },
    {
      icon: Landmark,
      accent: 'amber' as const,
      title: '如何结算',
      points: [
        'Token 可按平台公布的结算规则兑换数字人民币，全程走合规结算通道。',
        '结算按批次进行人工确认，开发者可在面板中查看每笔待结算与已结算记录。',
        '结算通道目前处于建设阶段（未来开放），开放时间以平台公告为准。',
      ],
    },
  ] as const

  return (
    <div className="bg-void">
      {/* Hero */}
      <section className="cyber-grid-bg cyber-scanline relative overflow-hidden">
        <div className="pointer-events-none absolute -top-40 left-1/2 h-[460px] w-[860px] -translate-x-1/2 bg-[radial-gradient(ellipse,rgba(245,165,36,0.12),transparent_65%)]" />
        <div className="relative mx-auto max-w-site px-5 pb-12 pt-16 text-center md:px-12 md:pt-24">
          <motion.div initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: easeOut }}>
            <p className="hud-label text-amber-400/80">INDUSTRIAL TOKEN ECONOMY</p>
            <h1 className="mt-3 font-display text-3xl font-bold tracking-[0.02em] text-ink-primary md:text-5xl">
              工业 Token 经济
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-secondary">
              一套面向工业生产力的计量与激励体系：用 Token 记录每一次真实使用，用数字人民币完成合规结算。
            </p>
          </motion.div>
        </div>
      </section>

      <div className="mx-auto max-w-4xl px-5 pb-24 md:px-12">
        <div className="space-y-8">
          {sections.map((sec, i) => (
            <motion.section
              key={sec.title}
              initial={{ opacity: 0, y: 32 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-60px' }}
              transition={{ delay: i * 0.05, duration: 0.7, ease: easeOut }}
              className="cyber-glow-card cyber-scanline relative rounded-2xl bg-zinc-950/80 p-7 md:p-9"
            >
              <HudCorner />
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    'flex h-11 w-11 items-center justify-center rounded-xl border',
                    sec.accent === 'amber'
                      ? 'border-amber-500/30 bg-amber-500/10'
                      : 'border-emerald-400/30 bg-emerald-400/10',
                  )}
                >
                  <sec.icon className={cn('h-5 w-5', sec.accent === 'amber' ? 'text-amber-400' : 'text-emerald-400')} />
                </span>
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
                    CHAPTER 0{i + 1}
                  </p>
                  <h2 className="mt-0.5 font-display text-xl font-bold text-ink-primary md:text-2xl">{sec.title}</h2>
                </div>
              </div>
              <ul className="mt-6 space-y-3.5">
                {sec.points.map((p, j) => (
                  <li key={j} className="flex gap-3 text-sm leading-relaxed text-ink-secondary">
                    <span className="mt-0.5 font-mono text-xs text-amber-400/70">{`${i + 1}.${j + 1}`}</span>
                    {p}
                  </li>
                ))}
              </ul>
            </motion.section>
          ))}

          {/* 流转示意 */}
          <motion.section
            initial={{ opacity: 0, y: 32 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.7, ease: easeOut }}
            className="rounded-2xl border border-line-subtle bg-zinc-950/60 p-7 md:p-9"
          >
            <p className="hud-label text-emerald-400/80">VALUE FLOW</p>
            <h2 className="mt-2 font-display text-xl font-bold text-ink-primary">Token 如何流转</h2>
            <div className="mt-6 grid gap-3 sm:grid-cols-4">
              {(
                [
                  { icon: UploadCloud, label: '开发者上架作品' },
                  { icon: Factory, label: '工厂使用 / 租用' },
                  { icon: Coins, label: 'Token 记账入账' },
                  { icon: Landmark, label: '数字人民币结算' },
                ] as const
              ).map((step, i) => (
                <div key={step.label} className="relative rounded-xl border border-amber-500/15 bg-zinc-950/70 p-4 text-center">
                  <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-amber-500/25 bg-amber-500/[0.08]">
                    <step.icon className="h-5 w-5 text-amber-400" />
                  </span>
                  <p className="mt-3 text-xs font-medium text-ink-primary">{step.label}</p>
                  <span className="absolute left-3 top-3 font-mono text-[10px] text-ink-faint">0{i + 1}</span>
                </div>
              ))}
            </div>
          </motion.section>

          {/* 购买交易服务状态 */}
          <motion.div
            initial={{ opacity: 0, y: 32 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.7, ease: easeOut }}
          >
            <PurchaseStatusCard />
          </motion.div>

          {/* 合规声明 */}
          <motion.section
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.7, ease: easeOut }}
            className="rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.04] p-7"
          >
            <p className="flex items-center gap-2 text-sm font-medium text-emerald-300">
              <ShieldCheck className="h-4 w-4" /> 合规声明
            </p>
            <ul className="mt-3 space-y-2 text-xs leading-relaxed text-ink-secondary">
              <li className="flex gap-2"><Scale className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400/70" />Token 是平台内的计量与激励单位，不构成任何金融工具、收益凭证或投资品。</li>
              <li className="flex gap-2"><Scale className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400/70" />平台不承诺任何固定收益，收益完全取决于作品被工厂真实使用的情况。</li>
              <li className="flex gap-2"><Scale className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400/70" />数字人民币结算将通过合规结算通道进行，并按批次人工确认。</li>
            </ul>
          </motion.section>

          <div className="flex flex-col items-center justify-between gap-4 rounded-2xl border border-line-subtle bg-zinc-950/60 p-7 md:flex-row">
            <p className="text-sm text-ink-secondary">准备好让你的作品进入 Token 经济循环了吗？</p>
            <GlowButton to="/developers">进入开发者中心</GlowButton>
          </div>
        </div>
      </div>
    </div>
  )
}
