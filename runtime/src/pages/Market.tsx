import { useMemo, useState } from 'react'
import { LayoutGroup, motion } from 'framer-motion'
import { Link } from 'react-router'
import { ArrowRight, CloudOff, PackageCheck, ScanSearch, Trophy, Truck, UserPlus } from 'lucide-react'
import { trpc } from '@/providers/trpc'
import { AGENTS } from '@/data/agents'
import HudCorner from '@/components/HudCorner'
import MarketAgentCard from '@/components/market/MarketAgentCard'
import PavilionAgentCard from '@/components/market/PavilionAgentCard'
import type { PavilionAccent } from '@/components/market/PavilionAgentCard'
import SearchBar from '@/components/market/SearchBar'
import FilterBar from '@/components/market/FilterBar'
import type { MarketFilters } from '@/components/market/FilterBar'
import Leaderboard from '@/components/market/Leaderboard'
import type { ApiAgentCard, MarketAgent } from '@/components/market/types'
import { fromApiAgent, fromStaticAgent } from '@/components/market/types'
import {
  FLAGSHIP_AGENTS,
  FLAGSHIP_CODES,
  UPCOMING_AGENTS,
} from '@/lib/flagship'
import {
  INDUSTRY_GROUPS,
  LIVE_GROUPS,
  PAVILION_LABELS,
  metasForGroup,
} from '@/lib/industries'

const easeOut = [0.16, 1, 0.3, 1] as [number, number, number, number]

const FALLBACK_FACETS = {
  industries: ['装备制造', '汽车零部件', '压力容器', '精密仪器', '模具钢加工', '电子装配'],
  capabilities: ['故障诊断', '视觉质检', '工艺优化', '声学检测', '精密测量', '巡检调度'],
  minPrice: 500,
  maxPrice: 25000,
}

const UPCOMING_ICONS = [Truck, ScanSearch, PackageCheck] as const

function applyFiltersClientSide(items: MarketAgent[], f: MarketFilters): MarketAgent[] {
  let rows = items
  const kw = f.search.trim()
  if (kw) {
    rows = rows.filter(
      (a) =>
        a.name.includes(kw) ||
        a.code.includes(kw) ||
        a.industry.includes(kw) ||
        a.tags.some((t) => t.includes(kw)),
    )
  }
  if (f.industries.length > 0) rows = rows.filter((a) => f.industries.includes(a.industry))
  if (f.capabilities.length > 0)
    rows = rows.filter((a) => f.capabilities.some((c) => a.tags.some((t) => t.includes(c))))
  rows = rows.filter((a) => a.monthlyPrice >= f.priceRange[0] && a.monthlyPrice <= f.priceRange[1])
  const sorted = [...rows]
  switch (f.sort) {
    case 'rating':
      sorted.sort((a, b) => b.avgRating - a.avgRating)
      break
    case 'priceAsc':
      sorted.sort((a, b) => a.monthlyPrice - b.monthlyPrice)
      break
    case 'priceDesc':
      sorted.sort((a, b) => b.monthlyPrice - a.monthlyPrice)
      break
    case 'tasks':
      sorted.sort((a, b) => b.tasksCompleted - a.tasksCompleted)
      break
    case 'newest':
      sorted.sort((a, b) => (b.listedAt?.getTime() ?? 0) - (a.listedAt?.getTime() ?? 0))
      break
    default:
      sorted.sort(
        (a, b) =>
          Number(b.recommended) - Number(a.recommended) ||
          b.avgRating - a.avgRating ||
          b.tasksCompleted - a.tasksCompleted,
      )
  }
  return sorted
}

/** 三大新行业馆徽章前缀（卡片左上角 chip 用） */
const PAVILION_BADGE_PREFIX: Record<string, string> = {
  跨境电商: 'CROSS-BORDER',
  设计创意: 'DESIGN',
  财税服务: 'FIN-TAX',
}

/** 新馆员工 slug → 兜底编号（API 未返回该员工时展示） */
const PAVILION_CODES: Record<string, string> = {
  duyang: 'ART-0201', milan: 'ART-0202', yifan: 'ART-0203',
  tuoling: 'ART-0204', xingdun: 'ART-0205', chaoming: 'ART-0206',
  danqing: 'ART-0301', liubai: 'ART-0302', chisu: 'ART-0303',
  sunmao: 'ART-0304', qijing: 'ART-0305', moyun: 'ART-0306',
  siku: 'ART-0401', mingzhang: 'ART-0402', chouheng: 'ART-0403',
  shenwei: 'ART-0404', piaoshu: 'ART-0405', huisuan: 'ART-0406',
}

/** 行业筛选 tab 的选中态样式（Tailwind JIT 需完整类名） */
const TAB_ACTIVE_CLASSES: Record<string, string> = {
  全部: 'border-amber-500/60 bg-amber-500/10 text-amber-400',
  工业制造: 'border-amber-500/60 bg-amber-500/10 text-amber-400',
  跨境电商: 'border-cyan-400/60 bg-cyan-400/10 text-cyan-300',
  设计创意: 'border-violet-400/60 bg-violet-400/10 text-violet-300',
  财税服务: 'border-emerald-400/60 bg-emerald-400/10 text-emerald-400',
}

/** 覆盖矩阵卡片按 accent 的文字/描边色（Tailwind JIT 需完整类名） */
const MATRIX_ACCENT: Record<PavilionAccent, { text: string; hud: string; hover: string; chip: string }> = {
  amber: {
    text: 'text-amber-400', hud: 'text-amber-400/80',
    hover: 'hover:border-amber-500/40', chip: 'border-amber-500/30 text-amber-400',
  },
  cyan: {
    text: 'text-cyan-300', hud: 'text-cyan-300/80',
    hover: 'hover:border-cyan-400/40', chip: 'border-cyan-400/30 text-cyan-300',
  },
  violet: {
    text: 'text-violet-300', hud: 'text-violet-300/80',
    hover: 'hover:border-violet-400/40', chip: 'border-violet-400/30 text-violet-300',
  },
  emerald: {
    text: 'text-emerald-400', hud: 'text-emerald-400/80',
    hover: 'hover:border-emerald-400/40', chip: 'border-emerald-400/30 text-emerald-400',
  },
}

function scrollToPavilion(key: string) {
  document.getElementById(`pavilion-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** 2026-09-07 彭总令：编程十员上首页明星区（团队租用为主） */
function StarCoderBand({ rows }: { rows: ApiAgentCard[] }) {
  if (rows.length === 0) return null
  return (
    <section className="border-b border-sky-500/10 bg-zinc-950/70 py-14 md:py-16">
      <div className="mx-auto max-w-site px-5 md:px-12">
        <motion.div
          initial={{ opacity: 0, y: 28 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }} transition={{ duration: 0.7, ease: easeOut }}
          className="mb-8"
        >
          <p className="hud-label text-sky-400/80">STAR SQUAD · 明星数字员工</p>
          <h2 className="mt-2 font-display text-2xl font-bold text-ink-primary md:text-3xl">
            编程班组 · 系统自我生成流水线
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-secondary">
            对企业只说人话，班组现场造出只属该企业的管理系统——跑在 NumX Max 自治智能底座上，代码留在企业自己的边缘节点。
            团队租用为主：整班十员打包价 = 单雇总价 7 折。
          </p>
        </motion.div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {rows.map((a) => (
            <Link
              key={a.slug}
              to={`/market/agent/${a.slug}`}
              className="group rounded-2xl border border-line-subtle bg-panel/60 p-4 transition hover:border-sky-400/40"
            >
              <img src={a.avatar} alt={a.name} loading="lazy" className="mx-auto h-28 w-28 rounded-xl object-contain transition group-hover:scale-105" />
              <p className="mt-3 text-center font-display text-sm font-bold text-ink-primary">{a.name}</p>
              <p className="mt-0.5 text-center text-[11px] text-ink-faint">{a.capabilityTags?.[0] ?? '编程'}</p>
              <p className="mt-1.5 text-center font-mono text-xs text-amber-300">{a.monthlyPrice.toLocaleString()} Token/月</p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  )
}

export default function Market() {
  const [filters, setFilters] = useState<MarketFilters>({
    search: '',
    industries: [],
    capabilities: [],
    priceRange: [FALLBACK_FACETS.minPrice, FALLBACK_FACETS.maxPrice],
    sort: 'recommended',
  })

  // 行业大类筛选 tab：'全部' 或 4 个 live 大类
  const [groupTab, setGroupTab] = useState<string>('全部')

  const facetsQuery = trpc.agents.facets.useQuery(undefined, { staleTime: 60_000, retry: 1 })
  const facets = useMemo(() => {
    if (facetsQuery.data) return facetsQuery.data
    return FALLBACK_FACETS
  }, [facetsQuery.data])

  const listQuery = trpc.agents.list.useQuery(
    {
      search: filters.search.trim() || undefined,
      industryGroup: groupTab === '全部' ? undefined : groupTab,
      capabilities: filters.capabilities.length ? filters.capabilities : undefined,
      minPrice: filters.priceRange[0],
      maxPrice: filters.priceRange[1],
      sort: filters.sort,
      limit: 50,
    },
    { staleTime: 15_000, retry: 1, placeholderData: (prev) => prev },
  )

  // 旗舰专区独立取数：不受用户筛选影响（slug 优先，code ART-0101~0105 兜底）
  const flagshipQuery = trpc.agents.list.useQuery({ limit: 100 }, { staleTime: 60_000, retry: 1 })

  const leaderboardQuery = trpc.agents.leaderboard.useQuery({ limit: 5 }, { staleTime: 30_000, retry: 1 })
  const newestQuery = trpc.agents.list.useQuery({ sort: 'newest', limit: 1 }, { staleTime: 30_000, retry: 1 })

  const offline = listQuery.isError

  const agents: MarketAgent[] = useMemo(() => {
    if (listQuery.data) {
      const rows = (listQuery.data.items as ApiAgentCard[]).map(fromApiAgent)
      // industry multi-select filtered client-side (API accepts a single industry)
      return filters.industries.length
        ? rows.filter((a) => filters.industries.includes(a.industry))
        : rows
    }
    if (offline) {
      return applyFiltersClientSide(AGENTS.map(fromStaticAgent), filters)
    }
    return []
  }, [listQuery.data, offline, filters])

  const flagships = useMemo(() => {
    const rows = ((flagshipQuery.data?.items ?? []) as ApiAgentCard[]).map(fromApiAgent)
    const bySlug = new Map(rows.map((a) => [a.slug, a]))
    const byCode = new Map(rows.map((a) => [a.code, a]))
    return FLAGSHIP_AGENTS.map((meta, i) => ({
      meta,
      agent: bySlug.get(meta.slug) ?? byCode.get(FLAGSHIP_CODES[i]!) ?? null,
    }))
  }, [flagshipQuery.data])

  // 三大新行业馆：与旗舰共用 limit:100 全量列表，按 slug 命中档案
  const pavilions = useMemo(() => {
    const rows = ((flagshipQuery.data?.items ?? []) as ApiAgentCard[]).map(fromApiAgent)
    const bySlug = new Map(rows.map((a) => [a.slug, a]))
    return LIVE_GROUPS.filter((g) => g.key !== '工业制造').map((g) => ({
      group: g,
      agents: metasForGroup(g.key).map((meta) => ({
        meta,
        agent: bySlug.get(meta.slug) ?? null,
      })),
    }))
  }, [flagshipQuery.data])

  // 全行业覆盖矩阵的员工数：优先 facets.groups（active 全量统计），
  // 兜底用 limit:100 列表行按 industryGroup 分组
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>()
    if (facetsQuery.data?.groups) {
      for (const g of facetsQuery.data.groups) counts.set(g.group, g.count)
    }
    if (counts.size === 0) {
      for (const a of (flagshipQuery.data?.items ?? []) as ApiAgentCard[]) {
        const key = a.industryGroup || '工业制造'
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    return counts
  }, [facetsQuery.data, flagshipQuery.data])

  const leaders: MarketAgent[] = useMemo(() => {
    if (leaderboardQuery.data) return (leaderboardQuery.data as ApiAgentCard[]).map(fromApiAgent)
    if (offline) {
      return [...AGENTS.map(fromStaticAgent)]
        .sort((a, b) => b.tasksCompleted - a.tasksCompleted)
        .slice(0, 5)
    }
    return []
  }, [leaderboardQuery.data, offline])

  const newcomer: MarketAgent | null = useMemo(() => {
    const first = newestQuery.data?.items?.[0] as ApiAgentCard | undefined
    if (first) return fromApiAgent(first)
    if (offline) {
      const staticAgents = AGENTS.map(fromStaticAgent)
      return staticAgents.find((a) => a.slug === 'xunxian') ?? staticAgents[staticAgents.length - 1] ?? null
    }
    return null
  }, [newestQuery.data, offline])

  const total = offline ? agents.length : listQuery.data ? agents.length : 0
  const loading = listQuery.isLoading

  return (
    <div className="bg-void">
      {/* Section 1 · 页头 — NumX Max·数字匠市 */}
      <section className="cyber-grid-bg cyber-scanline relative overflow-hidden">
        <div className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 bg-[radial-gradient(ellipse,rgba(245,165,36,0.12),transparent_65%)]" />
        <div className="relative mx-auto flex min-h-[420px] max-w-site flex-col items-center justify-center px-5 pb-16 pt-20 text-center md:px-12">
          <p className="hud-label text-amber-400/80">NUMX MAX DIGITAL ARTISAN MARKET</p>
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: easeOut }}
            className="mt-5 flex items-start gap-4"
          >
            <h1 className="font-display text-[32px] font-bold leading-tight tracking-[0.02em] text-ink-primary md:text-5xl">
              NumX Max·数字匠市
            </h1>
            <span className="mt-2 select-none rounded-sm border border-amber-500/50 px-1.5 py-2 font-mono text-[10px] leading-[1.1] tracking-widest text-amber-400 [writing-mode:vertical-rl]">
              内测中·BETA
            </span>
          </motion.div>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15, duration: 0.6, ease: easeOut }}
            className="mt-5 max-w-xl text-[15px] leading-relaxed text-ink-secondary md:text-base"
          >
            每一位数字员工都拥有链上数字身份，可按月雇佣、按次调用，为工厂提供可验证的专业生产力。
          </motion.p>
          <div className="mt-9 flex w-full justify-center">
            <SearchBar value={filters.search} onChange={(v) => setFilters((f) => ({ ...f, search: v }))} />
          </div>

          {/* 行业大类筛选 tab（控制下方主列表查询） */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25, duration: 0.6, ease: easeOut }}
            className="mt-6 flex flex-wrap items-center justify-center gap-2.5"
            role="tablist"
            aria-label="行业大类筛选"
          >
            {['全部', ...LIVE_GROUPS.map((g) => g.key)].map((tab) => {
              const active = groupTab === tab
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setGroupTab(tab)}
                  className={`inline-flex items-center gap-1.5 rounded-sm border px-3 py-1.5 font-mono text-[11px] tracking-wider transition ${
                    active
                      ? (TAB_ACTIVE_CLASSES[tab] ?? TAB_ACTIVE_CLASSES['全部'])
                      : 'border-line-subtle bg-zinc-950/40 text-ink-faint hover:border-amber-500/30 hover:text-ink-secondary'
                  }`}
                >
                  {tab}
                </button>
              )
            })}
          </motion.div>
        </div>
      </section>

      {/* Section 1.5 · 明星班组（彭总令 2026-09-07：编程十员上首页当明星）——
          系统自我生成班组：听企业说人话，现场造出只属该企业的管理系统；团队租用为主 */}
      <StarCoderBand rows={((flagshipQuery.data?.items ?? []) as ApiAgentCard[]).filter((a) => a.industry === '软件研发')} />

      {/* Section 2 · 工业制造馆 · 五大旗舰数字员工（置顶专区） */}
      <section id="pavilion-工业制造" className="scroll-mt-20 border-y border-amber-500/10 bg-zinc-950/60 py-14 md:py-20">
        <div className="mx-auto max-w-site px-5 md:px-12">
          <motion.div
            initial={{ opacity: 0, y: 28 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.7, ease: easeOut }}
            className="mb-8 flex flex-wrap items-end justify-between gap-4"
          >
            <div>
              <p className="hud-label text-amber-400/80">FLAGSHIP AGENTS</p>
              <h2 className="mt-2 font-display text-2xl font-bold text-ink-primary md:text-3xl">
                工业制造馆 · 五大旗舰数字员工
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-secondary">
                由 NumX Max 智造研究院认证发行的旗舰数字员工，覆盖经营、财务、采购、销售与研发五大岗位，持证上岗、身份可验。
              </p>
            </div>
            <span className="rounded-full border border-line-subtle px-3 py-1 font-mono text-xs text-ink-faint">
              5 位在编
            </span>
          </motion.div>

          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {flagships.map(({ meta, agent }, i) => (
              <PavilionAgentCard
                key={meta.slug}
                meta={meta}
                agent={agent}
                index={i}
                accent="amber"
                badgePrefix="FLAGSHIP"
                fallbackCode={FLAGSHIP_CODES[i]}
              />
            ))}

            {/* 未来 Agent 上线模块（剪影占位，不可点击） */}
            {UPCOMING_AGENTS.map((up, i) => {
              const Icon = UPCOMING_ICONS[i] ?? Truck
              return (
                <motion.div
                  key={up.name}
                  initial={{ opacity: 0, y: 48 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: '-60px' }}
                  transition={{ delay: ((flagships.length + i) % 3) * 0.08, duration: 0.7, ease: easeOut }}
                  aria-disabled
                  className="cyber-scanline relative flex h-full cursor-not-allowed flex-col overflow-hidden rounded-2xl border border-dashed border-zinc-600/60 bg-zinc-950/40"
                >
                  <div className="cyber-grid-bg relative flex aspect-[16/9] items-center justify-center overflow-hidden opacity-60">
                    <Icon className="h-16 w-16 text-zinc-600" strokeWidth={1.2} />
                    <span className="absolute right-4 top-3 rounded-full border border-zinc-500/50 bg-zinc-900/80 px-2.5 py-1 font-mono text-[10px] tracking-widest text-zinc-400">
                      未来开放
                    </span>
                  </div>
                  <div className="flex flex-1 flex-col p-6 pt-4">
                    <h3 className="font-display text-xl font-bold text-zinc-400">{up.name}</h3>
                    <p className="mt-2 text-[13px] leading-relaxed text-zinc-500">{up.desc}</p>
                    <p className="mt-auto pt-4 font-mono text-[11px] tracking-wider text-zinc-600">
                      COMING SOON · 岗位能力建模中
                    </p>
                  </div>
                </motion.div>
              )
            })}
          </div>
        </div>
      </section>

      {/* Section 3 · 三大新行业馆（跨境电商 / 设计创意 / 财税服务） */}
      {pavilions.map(({ group, agents: pavilionAgents }) => (
        <section
          key={group.key}
          id={`pavilion-${group.key}`}
          className="scroll-mt-20 border-b border-line-subtle bg-void py-14 md:py-20"
        >
          <div className="mx-auto max-w-site px-5 md:px-12">
            <motion.div
              initial={{ opacity: 0, y: 28 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-80px' }}
              transition={{ duration: 0.7, ease: easeOut }}
              className="mb-8 flex flex-wrap items-end justify-between gap-4"
            >
              <div>
                <p className={`hud-label ${MATRIX_ACCENT[group.accent].hud}`}>
                  {PAVILION_LABELS[group.key]}
                </p>
                <h2 className="mt-2 font-display text-2xl font-bold text-ink-primary md:text-3xl">
                  {group.key}馆
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-secondary">{group.tagline}</p>
              </div>
              <span className="rounded-full border border-line-subtle px-3 py-1 font-mono text-xs text-ink-faint">
                {pavilionAgents.filter((a) => a.agent).length || pavilionAgents.length} 位在编
              </span>
            </motion.div>

            {flagshipQuery.isError ? (
              <div className="flex h-32 items-center justify-center rounded-2xl border border-dashed border-zinc-600/60 bg-zinc-950/40">
                <p className="font-mono text-xs tracking-wider text-ink-faint">行业馆数据加载中</p>
              </div>
            ) : (
              <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
                {pavilionAgents.map(({ meta, agent }, i) => (
                  <PavilionAgentCard
                    key={meta.slug}
                    meta={meta}
                    agent={agent}
                    index={i}
                    accent={group.accent}
                    badgePrefix={PAVILION_BADGE_PREFIX[group.key] ?? 'AGENT'}
                    fallbackCode={PAVILION_CODES[meta.slug]}
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      ))}

      {/* Section 4 · 全行业覆盖矩阵（4 已上线 + 8 未来开放） */}
      <section className="cyber-grid-bg relative overflow-hidden border-b border-line-subtle bg-zinc-950/60 py-14 md:py-20">
        <div className="relative mx-auto max-w-site px-5 md:px-12">
          <motion.div
            initial={{ opacity: 0, y: 28 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.7, ease: easeOut }}
            className="mb-8"
          >
            <p className="hud-label text-amber-400/80">INDUSTRY COVERAGE MATRIX</p>
            <h2 className="mt-2 font-display text-2xl font-bold text-ink-primary md:text-3xl">
              全行业 · 全品类覆盖
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-secondary">
              十二大行业馆全部开放：工业制造、跨境电商、设计创意、财税服务有编在岗，其余场馆岗位公示、虚位以待——老师傅上架即开业。
            </p>
          </motion.div>

          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
            {INDUSTRY_GROUPS.map((g, i) => {
              const accent = MATRIX_ACCENT[g.accent]
              const live = g.status === 'live'
              const count = groupCounts.get(g.key) ?? 0
              const inner = (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <h3 className={`font-display text-lg font-bold ${live ? 'text-ink-primary' : 'text-zinc-400'}`}>
                      {g.key}
                    </h3>
                    {live ? (
                      <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${accent.chip}`}>
                        已上线
                      </span>
                    ) : (
                      <span className="rounded-full border border-zinc-500/50 bg-zinc-900/80 px-2 py-0.5 font-mono text-[10px] tracking-widest text-zinc-400">
                        未来开放
                      </span>
                    )}
                  </div>
                  <p className={`mt-2 text-xs leading-relaxed ${live ? 'text-ink-secondary' : 'text-zinc-500'}`}>
                    {g.tagline}
                  </p>
                  {live && count > 0 ? (
                    <p className={`mt-auto pt-4 font-mono text-[11px] tracking-wider ${accent.text}`}>
                      {count} 位数字员工在编
                    </p>
                  ) : live ? (
                    // 2026-09-05 全行业开放（彭总令）：空馆如实公示招募岗位，不装有人
                    <ul className="mt-auto space-y-1 pt-4">
                      {(g.plannedRoles ?? []).map((r) => (
                        <li key={r} className="font-mono text-[11px] tracking-wider text-zinc-400">
                          · {r} <span className="text-amber-400/80">虚位以待</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <ul className="mt-auto space-y-1 pt-4">
                      {(g.plannedRoles ?? []).map((r) => (
                        <li key={r} className="font-mono text-[11px] tracking-wider text-zinc-500">
                          · {r}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )
              return (
                <motion.div
                  key={g.key}
                  initial={{ opacity: 0, y: 32 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: '-60px' }}
                  transition={{ delay: (i % 4) * 0.06, duration: 0.6, ease: easeOut }}
                  className="h-full"
                >
                  {live ? (
                    <button
                      type="button"
                      onClick={() => scrollToPavilion(g.key)}
                      className={`cyber-glow-card cyber-scanline flex h-full w-full flex-col rounded-xl bg-zinc-950/80 p-5 text-left ${accent.hover}`}
                    >
                      {inner}
                    </button>
                  ) : (
                    <div
                      aria-disabled
                      className="flex h-full cursor-not-allowed flex-col rounded-xl border border-dashed border-zinc-600/60 bg-zinc-950/40 p-5 opacity-60 grayscale-[30%]"
                    >
                      {inner}
                    </div>
                  )}
                </motion.div>
              )
            })}
          </div>
        </div>
      </section>

      {/* Section 5 · 筛选工具栏 + 全部数字员工卡片网格 */}
      <section className="bg-deep pb-[72px] md:pb-[120px]">
        <div className="mx-auto max-w-site px-5 pt-12 md:px-12">
          <div className="mb-2">
            <p className="hud-label text-emerald-400/70">ALL ARTISANS</p>
            <h2 className="mt-2 font-display text-2xl font-bold text-ink-primary md:text-3xl">全部数字员工</h2>
          </div>
          <FilterBar
            filters={filters}
            onChange={setFilters}
            facets={facets}
            total={total}
            loading={loading}
          />

          {offline && (
            <div className="mb-6 flex items-center justify-center gap-2 rounded-xl border border-forge-amber/30 bg-forge-amber/5 px-4 py-2.5 text-xs text-forge-amber">
              <CloudOff className="h-3.5 w-3.5" />
              实时行情接口暂不可用，正在展示离线演示数据
            </div>
          )}

          <LayoutGroup>
            <motion.div layout className="grid gap-6 pt-8 sm:grid-cols-2 xl:grid-cols-3">
              {loading &&
                Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-[420px] animate-pulse rounded-2xl glass-panel" />
                ))}
              {!loading &&
                agents.map((a, i) => (
                  <motion.div
                    key={a.routeId}
                    layout="position"
                    initial={{ opacity: 0, y: 60 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, margin: '-60px' }}
                    transition={{ delay: (i % 3) * 0.09, duration: 0.7, ease: easeOut }}
                  >
                    <MarketAgentCard agent={a} />
                  </motion.div>
                ))}
            </motion.div>
          </LayoutGroup>

          {!loading && agents.length === 0 && (
            <div className="py-20 text-center">
              <p className="font-display text-xl text-ink-secondary">没有符合条件的工匠</p>
              <p className="mt-2 text-sm text-ink-faint">试试放宽价格区间或清除部分筛选条件</p>
            </div>
          )}
        </div>
      </section>

      {/* Section 4 · 市场排行榜 */}
      <div className="bg-void">
        <Leaderboard leaders={leaders} newcomer={newcomer} loading={leaderboardQuery.isLoading && !offline} />
      </div>

      {/* Section 5 · 底部入口：开发者生态 / 匠人排行榜 */}
      <section className="cyber-grid-bg relative overflow-hidden bg-zinc-950/70 pb-[72px] pt-16 md:pb-[120px] md:pt-20">
        <div className="relative mx-auto max-w-site px-5 md:px-12">
          <motion.div
            initial={{ opacity: 0, y: 28 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.7, ease: easeOut }}
            className="mb-8"
          >
            <p className="hud-label text-amber-400/80">ECOSYSTEM</p>
            <h2 className="mt-2 font-display text-2xl font-bold text-ink-primary md:text-3xl">生态入口</h2>
          </motion.div>

          <div className="grid gap-6 md:grid-cols-2">
            <motion.div
              initial={{ opacity: 0, y: 40 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-80px' }}
              transition={{ duration: 0.7, ease: easeOut }}
            >
              <Link
                to="/developers"
                className="cyber-glow-card cyber-scanline group relative flex h-full flex-col rounded-2xl bg-zinc-950/80 p-8"
              >
                <HudCorner />
                <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10">
                  <UserPlus className="h-6 w-6 text-amber-400" />
                </div>
                <h3 className="mt-5 font-display text-xl font-bold text-ink-primary md:text-2xl">
                  开发者生态 · 上架你的 Agent / Skill
                </h3>
                <p className="mt-3 flex-1 text-sm leading-relaxed text-ink-secondary">
                  把你的 Agent 应用与 Skill 技能上架到市场，被 NumX Max 的工厂使用与租用，获得 Token 收益并可兑换数字人民币结算。
                </p>
                <span className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-amber-400 transition-transform duration-300 group-hover:translate-x-1">
                  进入开发者中心 <ArrowRight className="h-4 w-4" />
                </span>
              </Link>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 40 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-80px' }}
              transition={{ delay: 0.1, duration: 0.7, ease: easeOut }}
            >
              <Link
                to="/leaderboard"
                className="cyber-glow-card cyber-scanline group relative flex h-full flex-col rounded-2xl bg-zinc-950/80 p-8"
              >
                <HudCorner />
                <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-emerald-400/30 bg-emerald-400/10">
                  <Trophy className="h-6 w-6 text-emerald-400" />
                </div>
                <h3 className="mt-5 font-display text-xl font-bold text-ink-primary md:text-2xl">匠人排行榜</h3>
                <p className="mt-3 flex-1 text-sm leading-relaxed text-ink-secondary">
                  收益榜、热力榜、口碑榜与周新星 —— 看一看哪些上架作品正在被工厂们高频使用。
                </p>
                <span className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-emerald-400 transition-transform duration-300 group-hover:translate-x-1">
                  查看排行榜 <ArrowRight className="h-4 w-4" />
                </span>
              </Link>
            </motion.div>
          </div>
        </div>
      </section>
    </div>
  )
}
