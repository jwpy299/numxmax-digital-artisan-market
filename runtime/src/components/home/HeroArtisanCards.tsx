/**
 * HeroArtisanCards —— 首屏右侧工牌卡组（波二·门户 UI 改造，按彭总已批设计稿）。
 *
 * 主卡：汇算（财务总监·认证+战绩诚实面+雇佣/试岗双钮）；后卡：揽月/明章错位层叠（景深）。
 * 数据全真：agents.list 真拉三 slug（台账口径，不摆拍）；加载中骨架、失败静默（首屏不炸）。
 */
import { useEffect, useState } from 'react'
import { CertBadge, HireCtas } from '@/components/market/WorkcardBits'
import { formatToken } from '@/components/market/types'

/** agents.list items 原始表形态（前端再映射 routeId） */
interface HeroAgent {
  id: number
  slug: string
  code: string
  name: string
  avatar: string
  industry: string
  monthlyPrice: number
  tasksCompleted: number
  certified: boolean
}

const HERO_SLUGS = ['huisuan', 'lanyue', 'mingzhang'] as const

const ROLE_LINE: Record<string, string> = {
  huisuan: '财务总监 · 成本与账税',
  lanyue: '销售冠军 · 客户开拓',
  mingzhang: '经营参谋 · 总经理助理',
}

async function fetchHeroAgents(): Promise<Record<string, HeroAgent>> {
  const r = await fetch('/api/trpc/agents.list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: { limit: 100 } }),
  })
  const d = await r.json()
  const items: HeroAgent[] = d?.result?.data?.json?.items ?? []
  const map: Record<string, HeroAgent> = {}
  for (const a of items) if ((HERO_SLUGS as readonly string[]).includes(a.slug)) map[a.slug] = a
  return map
}

/** 主工牌卡（汇算） */
function MainCard({ agent }: { agent: HeroAgent }) {
  return (
    <div className="relative w-[320px] rounded-2xl border border-forge-amber/30 bg-panel/95 p-5 shadow-[0_24px_60px_-12px_rgba(245,164,36,0.25)] backdrop-blur">
      <div className="absolute inset-x-0 top-0 h-1 rounded-t-2xl bg-gradient-to-r from-transparent via-forge-amber to-transparent" />
      <div className="flex items-start gap-3.5">
        <img
          src={agent.avatar}
          alt={agent.name}
          className="h-20 w-20 rounded-xl border border-forge-amber/30 object-cover"
          loading="lazy"
        />
        <div className="min-w-0 flex-1">
          <p className="font-display text-xl font-bold text-ink-primary">{agent.name}</p>
          <p className="mt-0.5 text-xs text-ink-secondary">{ROLE_LINE[agent.slug] ?? agent.industry}</p>
          <p className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-jade-green">
            <span className="h-1.5 w-1.5 rounded-full bg-jade-green" /> 在岗 · 可接单
          </p>
          <div className="mt-1.5">
            <CertBadge certified={agent.certified} />
          </div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-line-subtle pt-3.5">
        <div>
          <p className="font-grotesk text-base font-bold text-ink-primary">{agent.tasksCompleted} 单</p>
          <p className="mt-0.5 text-[10px] text-ink-faint">真实成交 · 累计中</p>
        </div>
        <div>
          <p className="font-grotesk text-base font-bold text-ink-primary">—</p>
          <p className="mt-0.5 text-[10px] text-ink-faint">雇主评分 · 新店</p>
        </div>
        <div>
          <p className="font-grotesk text-base font-bold text-ink-primary">—</p>
          <p className="mt-0.5 text-[10px] text-ink-faint">成功率 · 样本累计中</p>
        </div>
      </div>
      <p className="mt-3.5 font-grotesk text-xl font-bold text-ink-primary">
        {formatToken(agent.monthlyPrice)}
        <span className="ml-1 text-xs font-normal text-ink-faint">Token/月起 · 按调用计量</span>
      </p>
      <HireCtas routeId={agent.slug || String(agent.id)} compact />
    </div>
  )
}

/** 后卡（错位缩略景深） */
function BackCard({ agent, className }: { agent: HeroAgent; className?: string }) {
  return (
    <div className={`absolute w-[240px] rounded-2xl border border-line-subtle bg-panel/80 p-4 opacity-70 backdrop-blur ${className ?? ''}`}>
      <div className="flex items-center gap-3">
        <img src={agent.avatar} alt={agent.name} className="h-12 w-12 rounded-lg object-cover" loading="lazy" />
        <div className="min-w-0">
          <p className="truncate font-display text-base font-bold text-ink-primary">{agent.name}</p>
          <p className="truncate text-[11px] text-ink-secondary">{ROLE_LINE[agent.slug] ?? agent.industry}</p>
          <p className="mt-1 inline-flex items-center gap-1.5 text-[10px] text-jade-green">
            <span className="h-1.5 w-1.5 rounded-full bg-jade-green" /> 在岗 · 可接单
          </p>
        </div>
      </div>
      <p className="mt-3 font-grotesk text-sm font-bold text-ink-primary">
        {formatToken(agent.monthlyPrice)}
        <span className="ml-1 text-[10px] font-normal text-ink-faint">Token/月起</span>
      </p>
    </div>
  )
}

export default function HeroArtisanCards() {
  const [agents, setAgents] = useState<Record<string, HeroAgent> | null>(null)
  useEffect(() => {
    let cancelled = false
    fetchHeroAgents()
      .then((m) => { if (!cancelled) setAgents(m) })
      .catch(() => { if (!cancelled) setAgents({}) })
    return () => { cancelled = true }
  }, [])

  const main = agents?.huisuan
  const back1 = agents?.lanyue
  const back2 = agents?.mingzhang

  return (
    <div className="relative hidden h-[520px] w-[460px] lg:block" aria-hidden={!main}>
      {main ? (
        <>
          {back1 && <BackCard agent={back1} className="left-0 top-8 -rotate-3 scale-95" />}
          {back2 && <BackCard agent={back2} className="bottom-4 right-0 rotate-2 scale-95" />}
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            <MainCard agent={main} />
          </div>
        </>
      ) : (
        <div className="absolute left-1/2 top-1/2 h-[380px] w-[320px] -translate-x-1/2 -translate-y-1/2 animate-pulse rounded-2xl bg-panel/60" />
      )}
    </div>
  )
}
