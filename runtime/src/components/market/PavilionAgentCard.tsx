/**
 * 行业馆大卡片（可复用）：16:9 形象照 + cyber-grid-bg 底 + HudCorner
 * + role chip + DID 芯片标签 + 价格/评分，档案接入后可点击进详情。
 * 五大旗舰（amber）与三大新行业馆（cyan/violet/emerald）共用此组件，
 * 仅 accent 主色与徽章前缀不同。
 */
import { motion } from 'framer-motion'
import { Link } from 'react-router'
import { Cpu } from 'lucide-react'
import { CertBadge, HireCtas } from '@/components/market/WorkcardBits'
import HudCorner from '@/components/HudCorner'
import RatingStars from '@/components/RatingStars'
import type { MarketAgent } from '@/components/market/types'
import { formatToken } from '@/components/market/types'
import { didForSlug } from '@/lib/flagship'

const easeOut = [0.16, 1, 0.3, 1] as [number, number, number, number]

export type PavilionAccent = 'amber' | 'cyan' | 'violet' | 'emerald'

export interface PavilionCardMeta {
  slug: string
  name: string
  role: string
  desc: string
  avatar: string
}

/** 各 accent 的静态 class 映射（Tailwind JIT 需完整类名，不做字符串拼接） */
const ACCENT_CLASSES: Record<
  PavilionAccent,
  { card: string; badge: string; price: string; divider: string }
> = {
  amber: {
    card: 'cyber-glow-card',
    badge: 'border-amber-500/40 bg-zinc-950/70 text-amber-400',
    price: 'text-amber-400',
    divider: 'border-amber-500/10',
  },
  cyan: {
    card: 'border border-cyan-400/20 shadow-[0_0_22px_rgba(34,211,238,0.08)] transition duration-300 hover:border-cyan-400/45 hover:shadow-[0_0_34px_rgba(34,211,238,0.16)]',
    badge: 'border-cyan-400/40 bg-zinc-950/70 text-cyan-300',
    price: 'text-cyan-300',
    divider: 'border-cyan-400/10',
  },
  violet: {
    card: 'border border-violet-400/20 shadow-[0_0_22px_rgba(167,139,250,0.08)] transition duration-300 hover:border-violet-400/45 hover:shadow-[0_0_34px_rgba(167,139,250,0.16)]',
    badge: 'border-violet-400/40 bg-zinc-950/70 text-violet-300',
    price: 'text-violet-300',
    divider: 'border-violet-400/10',
  },
  emerald: {
    card: 'border border-emerald-400/20 shadow-[0_0_22px_rgba(52,211,153,0.08)] transition duration-300 hover:border-emerald-400/45 hover:shadow-[0_0_34px_rgba(52,211,153,0.16)]',
    badge: 'border-emerald-400/40 bg-zinc-950/70 text-emerald-400',
    price: 'text-emerald-400',
    divider: 'border-emerald-400/10',
  },
}

export default function PavilionAgentCard({
  meta,
  agent,
  index,
  accent,
  badgePrefix,
  fallbackCode,
}: {
  meta: PavilionCardMeta
  agent: MarketAgent | null
  index: number
  accent: PavilionAccent
  /** 左上角徽章前缀，如 FLAGSHIP / CROSS-BORDER */
  badgePrefix: string
  /** agent 档案未接入时的兜底编号，如 ART-0101 */
  fallbackCode?: string
}) {
  const c = ACCENT_CLASSES[accent]
  const body = (
    <>
      <HudCorner />
      {/* 形象区（2026-09-05 彭总令：匠市形象一律灵枢/星云熊猫 IP 血统——
          抽象 3D 数字人退役，直接出 IP 形象大图；加载失败兜底同名路径） */}
      <div className="relative aspect-[16/9] overflow-hidden">
        <div className="cyber-grid-bg absolute inset-0 opacity-70" />
        <div className="relative flex h-full w-full items-center justify-center transition-transform duration-500 group-hover:scale-[1.04]">
          <img
            src={(agent?.avatar ?? meta.avatar) + '?v=ip20260905'}
            alt={meta.name}
            loading="lazy"
            className="relative h-full w-full object-contain p-3"
            onError={(e) => {
              const el = e.currentTarget
              if (!el.dataset.fbk) { el.dataset.fbk = '1'; el.src = '/ip/agent-ex.png?v=ip20260905' }
            }}
          />
        </div>
        <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-zinc-950 to-transparent" />
        <span
          className={`absolute left-4 top-3 rounded-full border px-2.5 py-1 font-mono text-[10px] tracking-widest backdrop-blur ${c.badge}`}
        >
          {badgePrefix} · {agent?.code ?? fallbackCode ?? 'ART-????'}
        </span>
      </div>

      <div className="relative flex flex-1 flex-col p-6 pt-4">
        <div className="flex flex-wrap items-center gap-2.5">
          {agent ? (
            <Link to={`/market/agent/${agent.routeId}`} className="font-display text-2xl font-bold text-ink-primary transition-colors hover:text-forge-amber">
              {agent.name}
            </Link>
          ) : (
            <h3 className="font-display text-2xl font-bold text-ink-primary">{meta.name}</h3>
          )}
          <span className="rounded-sm border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
            {meta.role}
          </span>
          {agent && <CertBadge certified={agent.certified} />}
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{meta.desc}</p>

        {/* DID 芯片标签 */}
        <div className="mt-3">
          <span className="cyber-chip">
            <Cpu className="h-3 w-3" />
            {didForSlug(agent?.slug ?? meta.slug)}
          </span>
        </div>

        {/* 价格 / 评分 */}
        <div className={`mt-4 flex items-end justify-between border-t pt-4 ${c.divider}`}>
          {agent ? (
            <>
              <p className={`font-grotesk text-2xl font-bold ${c.price}`}>
                {formatToken(agent.monthlyPrice)}
                <span className="ml-1 text-xs font-normal text-ink-faint">Token/月</span>
              </p>
              {agent.avgRating > 0 ? (
                <RatingStars rating={agent.avgRating} />
              ) : (
                <span className="text-[11px] text-ink-faint">评分待验证</span>
              )}
            </>
          ) : (
            <p className="font-mono text-xs tracking-wider text-ink-faint">档案接入中 · 定价即将公布</p>
          )}
        </div>
        {/* 波二工牌卡 v2：雇佣/试岗双钮常驻卡底（整卡 Link 嵌套非法——结构改 div+名行 Link） */}
        {agent && <HireCtas routeId={agent.routeId} compact />}
      </div>
    </>
  )

  const cls = `cyber-scanline group relative flex h-full flex-col overflow-hidden rounded-2xl bg-zinc-950/80 ${c.card}`

  return (
    <motion.div
      initial={{ opacity: 0, y: 48 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ delay: (index % 3) * 0.08, duration: 0.7, ease: easeOut }}
      whileHover={{ y: -5 }}
      className="h-full"
    >
      <div className={cls} aria-disabled={!agent}>
        {body}
      </div>
    </motion.div>
  )
}
