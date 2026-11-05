import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Award,
  CircleDollarSign,
  Eye,
  Flame,
  Medal,
  Sparkles,
  Star,
  Trophy,
} from 'lucide-react'
import HudCorner from '@/components/HudCorner'
import GlowButton from '@/components/GlowButton'
import { cn } from '@/lib/utils'
import { formatToken } from '@/components/market/types'
import { trpcDev } from '@/lib/trpcDev'

const easeOut = [0.16, 1, 0.3, 1] as [number, number, number, number]

/** 榜单条目（以后端返回为准，渲染全部走可选链） */
interface BoardItem {
  rank?: number
  listingId?: number | string
  name?: string
  kind?: string
  devName?: string
  usageCount?: number
  revenueToken?: number
  avgRating?: number
  ratingCount?: number
  listedAt?: string | Date
  [key: string]: unknown
}

type BoardKey = 'revenue' | 'heat' | 'reputation' | 'newcomers'

const BOARD_TABS: { key: BoardKey; label: string; icon: typeof Trophy; desc: string }[] = [
  { key: 'revenue', label: '收益榜', icon: CircleDollarSign, desc: '按累计 Token 收益排序' },
  { key: 'heat', label: '热力榜', icon: Flame, desc: '按工厂使用次数排序' },
  { key: 'reputation', label: '口碑榜', icon: Star, desc: '按平均评分排序（需已评价满 10 次）' },
  { key: 'newcomers', label: '周新星', icon: Sparkles, desc: '本周新上架并快速获得使用的作品' },
]

/** 前三名徽章配色：金 / 银 / 铜 */
const PODIUM_META: Record<number, { label: string; cls: string; iconCls: string }> = {
  1: { label: '金匠', cls: 'border-amber-400/60 bg-amber-400/10', iconCls: 'text-amber-400' },
  2: { label: '银匠', cls: 'border-amber-600/60 bg-amber-600/10', iconCls: 'text-amber-600' },
  3: { label: '铜匠', cls: 'border-stone-400/50 bg-stone-400/10', iconCls: 'text-stone-400' },
}

/** 激励机制硬编码兜底（leaderboard.rules 返回字符串数组时以后端为准） */
const FALLBACK_RULES = [
  '金 / 银 / 铜匠人徽章：各榜单前三名获得对应徽章，展示在作品与开发者主页。',
  '首页曝光位：上榜作品可获得星云首页与市场推荐位曝光。',
  '收益榜 Top 3 下周平台分成由 20% 降至 10%，以实际结算单为准。',
  '周新星作品获得「新锐匠人」标签，展示周期一周。',
]

function RankBadge({ rank }: { rank: number }) {
  const meta = PODIUM_META[rank]
  if (meta) {
    return (
      <span className={cn('flex h-11 w-11 items-center justify-center rounded-xl border', meta.cls)} title={meta.label}>
        <Medal className={cn('h-5 w-5', meta.iconCls)} />
      </span>
    )
  }
  return (
    <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-line-subtle bg-zinc-950/60 font-mono text-sm text-ink-faint">
      {rank}
    </span>
  )
}

function BoardRow({ item, board, index }: { item: BoardItem; board: BoardKey; index: number }) {
  const rank = item.rank ?? index + 1
  const podium = rank <= 3
  return (
    <motion.li
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ delay: Math.min(index, 6) * 0.05, duration: 0.5, ease: easeOut }}
      className={cn(
        'flex items-center gap-4 rounded-2xl border bg-zinc-950/70 p-4 transition-colors md:p-5',
        podium ? 'cyber-glow-card' : 'border-line-subtle hover:border-amber-500/20',
      )}
    >
      <RankBadge rank={rank} />

      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium text-ink-primary">{item.name ?? '未命名作品'}</span>
          {item.kind && (
            <span className="rounded-sm border border-line-subtle px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink-faint">
              {item.kind === 'skill' ? 'Skill' : 'Agent'}
            </span>
          )}
          {board === 'newcomers' && (
            <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[10px] text-emerald-400">
              新锐匠人
            </span>
          )}
        </p>
        <p className="mt-1 text-xs text-ink-faint">
          开发者 · {item.devName ?? '匿名匠人'}
          {board === 'reputation' && typeof item.ratingCount === 'number' && (
            <span className="ml-2">已评价 {item.ratingCount} 次</span>
          )}
        </p>
      </div>

      <div className="shrink-0 text-right">
        {board === 'revenue' && (
          <>
            <p className="font-grotesk text-lg font-bold text-amber-400">{formatToken(item.revenueToken ?? 0)}</p>
            <p className="text-[10px] text-ink-faint">Token 收益</p>
          </>
        )}
        {board === 'heat' && (
          <>
            <p className="font-grotesk text-lg font-bold text-amber-400">{formatToken(item.usageCount ?? 0)}</p>
            <p className="text-[10px] text-ink-faint">次使用</p>
          </>
        )}
        {board === 'reputation' && (
          <>
            <p className="font-grotesk text-lg font-bold text-amber-400">{(item.avgRating ?? 0).toFixed(1)}★</p>
            <p className="text-[10px] text-ink-faint">平均评分</p>
          </>
        )}
        {board === 'newcomers' && (
          <>
            <p className="font-grotesk text-lg font-bold text-emerald-400">{formatToken(item.usageCount ?? 0)}</p>
            <p className="text-[10px] text-ink-faint">本周使用</p>
          </>
        )}
      </div>
    </motion.li>
  )
}

export default function LeaderboardPage() {
  const [tab, setTab] = useState<BoardKey>('revenue')

  const boardsQuery = trpcDev.leaderboard.boards.useQuery(undefined, { retry: 1, staleTime: 60_000 })
  const rulesQuery = trpcDev.leaderboard.rules.useQuery(undefined, { retry: 1, staleTime: 300_000 })

  const boards = boardsQuery.data as Record<BoardKey, BoardItem[] | undefined> | undefined

  const rows = useMemo(() => {
    const list = (boards?.[tab] ?? []) as BoardItem[]
    // 口碑榜仅展示已评价满 10 次的作品
    return tab === 'reputation' ? list.filter((it) => (it.ratingCount ?? 0) >= 10) : list
  }, [boards, tab])

  const rules = useMemo(() => {
    const raw = rulesQuery.data as unknown
    if (Array.isArray(raw) && raw.length > 0 && raw.every((r) => typeof r === 'string')) return raw as string[]
    if (raw && typeof raw === 'object' && Array.isArray((raw as { rules?: unknown }).rules)) {
      const arr = (raw as { rules: unknown[] }).rules
      if (arr.every((r) => typeof r === 'string')) return arr as string[]
    }
    return FALLBACK_RULES
  }, [rulesQuery.data])

  const activeTab = BOARD_TABS.find((t) => t.key === tab)!

  return (
    <div className="bg-void">
      {/* Hero */}
      <section className="cyber-grid-bg cyber-scanline relative overflow-hidden">
        <div className="pointer-events-none absolute -top-40 left-1/2 h-[460px] w-[860px] -translate-x-1/2 bg-[radial-gradient(ellipse,rgba(245,165,36,0.12),transparent_65%)]" />
        <div className="relative mx-auto max-w-site px-5 pb-12 pt-16 text-center md:px-12 md:pt-24">
          <motion.div initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: easeOut }}>
            <p className="hud-label text-amber-400/80">ARTISAN LEADERBOARD</p>
            <h1 className="mt-3 flex items-center justify-center gap-3 font-display text-3xl font-bold tracking-[0.02em] text-ink-primary md:text-5xl">
              <Trophy className="h-8 w-8 text-amber-400 md:h-10 md:w-10" />
              匠人排行榜
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-secondary">
              收益、热力、口碑与新星 —— 工厂的真实使用，是匠人作品唯一的度量衡。
            </p>
          </motion.div>
        </div>
      </section>

      <div className="mx-auto max-w-4xl px-5 pb-24 md:px-12">
        {/* 榜单 Tab */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.6, ease: easeOut }}
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
          role="tablist"
        >
          {BOARD_TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3.5 transition-colors',
                tab === t.key
                  ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                  : 'border-line-subtle bg-zinc-950/60 text-ink-secondary hover:border-zinc-500/50 hover:text-ink-primary',
              )}
            >
              <t.icon className="h-5 w-5" />
              <span className="text-sm font-medium">{t.label}</span>
            </button>
          ))}
        </motion.div>
        <p className="mt-3 text-center text-xs text-ink-faint">{activeTab.desc}</p>

        {/* 榜单内容 */}
        <div className="mt-8">
          {boardsQuery.isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-[76px] animate-pulse rounded-2xl bg-zinc-900/60" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="cyber-glow-card relative flex flex-col items-center gap-3 rounded-2xl bg-zinc-950/80 px-6 py-16 text-center">
              <HudCorner />
              <Trophy className="h-10 w-10 text-zinc-600" />
              <p className="font-display text-xl text-ink-secondary">虚位以待</p>
              <p className="max-w-sm text-sm leading-relaxed text-ink-faint">
                {boardsQuery.isError
                  ? '榜单接口暂不可用，请稍后刷新重试。'
                  : '该榜单暂时无人上榜 —— 上架你的作品，下一期榜单就有你。'}
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {rows.map((item, i) => (
                <BoardRow key={item.listingId ?? i} item={item} board={tab} index={i} />
              ))}
            </ul>
          )}
        </div>

        {/* 激励机制 */}
        <motion.section
          initial={{ opacity: 0, y: 28 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.7, ease: easeOut }}
          className="cyber-glow-card cyber-scanline relative mt-14 rounded-2xl bg-zinc-950/80 p-7 md:p-9"
        >
          <HudCorner />
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10">
              <Award className="h-5 w-5 text-amber-400" />
            </span>
            <div>
              <p className="hud-label text-amber-400/80">INCENTIVES</p>
              <h2 className="mt-1 font-display text-xl font-bold text-ink-primary">激励机制</h2>
            </div>
          </div>
          <ul className="mt-6 space-y-3">
            {rules.map((rule, i) => (
              <li key={i} className="flex gap-3 text-sm leading-relaxed text-ink-secondary">
                <span className="mt-0.5 font-mono text-xs text-amber-400/80">{String(i + 1).padStart(2, '0')}</span>
                {rule}
              </li>
            ))}
          </ul>
          <div className="mt-7 flex flex-col items-start justify-between gap-4 border-t border-amber-500/10 pt-6 md:flex-row md:items-center">
            <p className="flex items-center gap-2 text-xs text-ink-faint">
              <Eye className="h-3.5 w-3.5" />
              榜单每周更新，数据以平台统计口径为准。
            </p>
            <GlowButton to="/developers" variant="secondary" className="px-5 py-2.5 text-xs">
              上架作品 · 冲击榜单
            </GlowButton>
          </div>
        </motion.section>
      </div>
    </div>
  )
}
