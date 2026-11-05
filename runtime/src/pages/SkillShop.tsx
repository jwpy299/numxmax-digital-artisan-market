/**
 * SkillShop（/shop）—— 技能商店（迭代 31：技能商店 + 能力资产化 + 三方分账）。
 * 免登录：skillShop.list（status='listed' 商品网格：标题/层级/track 标签/创作者标签/price Token/销量/分账说明小字）；
 * 点击卡片展开详情（skillShop.detail，含分账比例说明）+「前往智能工作台购买挂载」按钮跳 wb 登录页。
 * 调用走 untyped tRPC client（wbSession 的 wbQuery，withToken:false 免登录模式）。
 */
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Coins, Layers, Search, Sparkles, Store, TrendingUp, User, X } from 'lucide-react'
import HudCorner from '@/components/HudCorner'
import { wbQuery, wbErrorMessage } from '@/lib/wbSession'
import { NEBULA_WORKBENCH_URL } from '@/config/workbench' // 丝滑度审面：URL 单源
import { cn } from '@/lib/utils'

// ─── 契约类型（字段名兼容 snake_case / camelCase 两种形态）─────────────────────

interface ShopPackRaw {
  id?: number
  packKey?: string
  pack_key?: string
  title?: string
  description?: string | null
  layer?: string
  track?: 'A' | 'B' | string
  creatorType?: string
  creator_type?: string
  priceTokens?: number
  price_tokens?: number
  salesCount?: number
  sales_count?: number
  shareNote?: string | null
  share_note?: string | null
  // Harness H1 技能真实化审计：执行器登记 + 徽标 + 真实成功率（近 90 天调用，null=样本不足）
  executorKind?: string | null
  executor_kind?: string | null
  badge?: 'real' | 'generative' | string
  realSuccessRate?: number | null
  real_success_rate?: number | null
  [key: string]: unknown
}

interface ShopPack {
  packKey: string
  title: string
  description: string
  layer: string
  track: string
  creatorType: string
  priceTokens: number
  salesCount: number
  shareNote?: string | null
  executorKind: string | null
  badge: 'real' | 'generative'
  /** null = 样本不足（近 90 天调用 <5 次）；不再回退展示种子 successRate=98 */
  realSuccessRate: number | null
}

function normalizePack(r: ShopPackRaw): ShopPack {
  const rawRate = r.realSuccessRate ?? r.real_success_rate
  return {
    packKey: String(r.packKey ?? r.pack_key ?? ''),
    title: String(r.title ?? '未命名技能包'),
    description: String(r.description ?? ''),
    layer: String(r.layer ?? 'general'),
    track: String(r.track ?? 'A'),
    creatorType: String(r.creatorType ?? r.creator_type ?? 'platform'),
    priceTokens: Number(r.priceTokens ?? r.price_tokens ?? 0),
    salesCount: Number(r.salesCount ?? r.sales_count ?? 0),
    shareNote: (r.shareNote ?? r.share_note ?? null) as string | null,
    executorKind: (r.executorKind ?? r.executor_kind ?? null) as string | null,
    badge: r.badge === 'real' ? 'real' : 'generative',
    realSuccessRate: rawRate == null ? null : Number(rawRate),
  }
}

// ─── 展示常量 ────────────────────────────────────────────────────────────────

const WORKBENCH_URL = NEBULA_WORKBENCH_URL + '/wb/login' // 硬编码归单源（丝滑度审面）

const LAYER_LABEL: Record<string, string> = {
  general: '通用办公',
  professional: '岗位专业',
  industry: '行业技能',
}
const LAYER_STYLE: Record<string, string> = {
  general: 'border-pulse-cyan/40 bg-pulse-cyan/10 text-pulse-cyan',
  professional: 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber',
  industry: 'border-nebula-violet/50 bg-nebula-violet/10 text-nebula-violet',
}

/** creator 标签：platform=平台官方 / A=岗位共创 / B=个人创作 */
function creatorLabel(p: ShopPack): { text: string; cls: string } {
  if (p.creatorType === 'platform') return { text: '平台官方', cls: 'border-nebula-violet/50 bg-nebula-violet/10 text-nebula-violet' }
  if (p.track === 'A') return { text: '岗位共创', cls: 'border-pulse-cyan/40 bg-pulse-cyan/10 text-pulse-cyan' }
  return { text: '个人创作', cls: 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber' }
}

/**
 * Harness H1 技能真实化徽标：⚡ 真执行器（玉绿，已登记真实执行器）/ ✨ 生成式（灰，LLM 兜底无专用执行器）。
 * 口径见 api/routers/skillStats.ts badgeOf。
 */
function ExecutorBadge({ badge, className }: { badge: 'real' | 'generative'; className?: string }) {
  return badge === 'real' ? (
    <span className={cn('inline-flex items-center rounded-full border border-jade-green/50 bg-jade-green/10 px-2 py-0.5 font-mono text-[10px] text-jade-green', className)}>
      ⚡ 真执行器
    </span>
  ) : (
    <span className={cn('inline-flex items-center rounded-full border border-line-subtle px-2 py-0.5 font-mono text-[10px] text-ink-faint', className)}>
      ✨ 生成式
    </span>
  )
}

/**
 * 真实成功率文案：realSuccessRate 非空 → 真实值 + 「真实统计」；null → 「样本不足」。
 * H1 起切换口径：不再展示种子 successRate=98（该字段为种子数据，非真实统计）。
 */
function realRateText(p: ShopPack): string {
  return p.realSuccessRate == null ? '样本不足' : `${p.realSuccessRate.toFixed(1)}% · 真实统计`
}

/** 分账比例小字说明（契约 §2：A 企业50/创作者30/平台20；B 创作者60/企业20/平台20；平台包平台100%） */
function shareText(p: ShopPack): string {
  if (p.shareNote) return p.shareNote
  if (p.creatorType === 'platform') return '分账：平台 100%'
  if (p.track === 'A') return '分账：企业 50% · 创作者 30% · 平台 20%'
  return '分账：创作者 60% · 企业 20% · 平台 20%'
}

const TRACK_FILTERS = [
  { key: '', label: '全部' },
  { key: 'A', label: '岗位共创' },
  { key: 'B', label: '个人创作' },
]
const LAYER_FILTERS = [
  { key: '', label: '全部层级' },
  { key: 'general', label: '通用办公' },
  { key: 'professional', label: '岗位专业' },
  { key: 'industry', label: '行业技能' },
]

// ─── 详情抽屉（skillShop.detail）──────────────────────────────────────────────

function DetailDrawer({ packKey, onClose }: { packKey: string; onClose: () => void }) {
  const [detail, setDetail] = useState<ShopPack | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    wbQuery<ShopPackRaw>('skillShop.detail', { packKey })
      .then((res) => {
        if (cancelled) return
        setDetail(normalizePack(res ?? {}))
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(wbErrorMessage(err))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [packKey])

  const creator = detail ? creatorLabel(detail) : null

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-void/80 backdrop-blur-sm sm:items-center" onClick={onClose}>
      <div
        className="glass-panel relative max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-2xl p-6 sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <HudCorner />
        <button
          type="button"
          aria-label="关闭"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full p-1.5 text-ink-secondary transition-colors hover:text-ink-primary"
        >
          <X className="h-4 w-4" />
        </button>
        <p className="hud-label text-pulse-cyan/80">SKILL PACK DETAIL</p>
        {loading ? (
          <div className="mt-6 space-y-3">
            <div className="h-6 w-1/2 animate-pulse rounded bg-panel" />
            <div className="h-20 animate-pulse rounded bg-panel" />
          </div>
        ) : error ? (
          <p className="mt-4 rounded-xl border border-ember-red/30 bg-ember-red/[0.06] px-4 py-3 text-xs text-ember-red">{error}</p>
        ) : detail ? (
          <>
            <h3 className="mt-1 font-display text-xl font-bold text-ink-primary">{detail.title}</h3>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[11px]', LAYER_STYLE[detail.layer] ?? 'border-line-subtle text-ink-secondary')}>
                {LAYER_LABEL[detail.layer] ?? detail.layer}
              </span>
              <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[11px]', creator!.cls)}>
                {creator!.text}
              </span>
              <ExecutorBadge badge={detail.badge} className="px-2.5 text-[11px]" />
              <span className="font-mono text-[11px] text-ink-faint">{detail.packKey}</span>
            </div>
            {/* H1 真实成功率：近 90 天真实调用统计；样本不足 5 次展示「样本不足」（不展示种子 98） */}
            <p className="mt-2 text-[11px] text-ink-faint">
              成功率 <span className={detail.realSuccessRate == null ? 'text-ink-faint' : 'text-jade-green'}>{realRateText(detail)}</span>
              <span className="ml-1">（近 90 天真实调用）</span>
            </p>
            <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-ink-secondary">
              {detail.description || '暂无详细介绍。'}
            </p>
            <div className="mt-5 flex items-end justify-between border-t border-line-subtle/60 pt-4">
              <p>
                <span className="font-display text-3xl font-bold text-forge-amber">{detail.priceTokens}</span>
                <span className="ml-1.5 text-sm text-ink-faint">Token（调用计量）</span>
              </p>
              <p className="flex items-center gap-1 text-xs text-ink-faint">
                <TrendingUp className="h-3.5 w-3.5 text-jade-green" />
                已售 {detail.salesCount}
              </p>
            </div>
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-faint">
              <Coins className="h-3 w-3 text-forge-amber" />
              {shareText(detail)}
            </p>
            <a
              href={WORKBENCH_URL}
              className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-[10px] bg-amber-gradient px-4 py-2.5 text-sm font-medium text-[#1A1206] transition-shadow duration-300 hover:shadow-[0_0_20px_rgba(245,165,36,0.35)]"
            >
              <Sparkles className="h-4 w-4" />
              前往智能工作台购买挂载
            </a>
            <p className="mt-2 text-center text-[11px] text-ink-faint">购买后请在智能工作台将技能包挂载到本厂数字员工</p>
          </>
        ) : null}
      </div>
    </div>
  )
}

// ─── 商品卡片 ────────────────────────────────────────────────────────────────

function PackCard({ pack, onOpen }: { pack: ShopPack; onOpen: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const creator = creatorLabel(pack)
  return (
    <article
      className="glass-panel group relative flex cursor-pointer flex-col rounded-xl p-5 transition-transform duration-300 hover:-translate-y-1"
      onClick={() => setExpanded((v) => !v)}
    >
      <HudCorner />
      <div className="flex items-start gap-2">
        <Store className="mt-0.5 h-4 w-4 shrink-0 text-pulse-cyan" />
        <h3 className="min-w-0 flex-1 truncate font-display text-base font-bold text-ink-primary">{pack.title}</h3>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px]', LAYER_STYLE[pack.layer] ?? 'border-line-subtle text-ink-secondary')}>
          {LAYER_LABEL[pack.layer] ?? pack.layer}
        </span>
        <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px]', creator.cls)}>
          <User className="mr-1 h-2.5 w-2.5" />
          {creator.text}
        </span>
        <ExecutorBadge badge={pack.badge} />
      </div>
      <p className={cn('mt-3 text-xs leading-relaxed text-ink-secondary', !expanded && 'line-clamp-2 min-h-[2rem]')}>
        {pack.description || '—'}
      </p>
      <div className="mt-4 flex items-end justify-between border-t border-line-subtle/60 pt-3">
        <p>
          <span className="font-display text-2xl font-bold text-forge-amber">{pack.priceTokens}</span>
          <span className="ml-1 text-[11px] text-ink-faint">Token</span>
        </p>
        <p className="flex items-center gap-1 text-[11px] text-ink-faint">
          <TrendingUp className="h-3 w-3 text-jade-green" />
          销量 {pack.salesCount}
        </p>
      </div>
      {/* H1 真实成功率：非空=真实统计值，null=样本不足（不再展示种子 successRate=98） */}
      <p className="mt-2 text-[10px] text-ink-faint">
        成功率 <span className={pack.realSuccessRate == null ? 'text-ink-faint' : 'text-jade-green'}>{realRateText(pack)}</span>
      </p>
      <p className="mt-2 flex items-center gap-1 text-[10px] text-ink-faint">
        <Coins className="h-2.5 w-2.5 text-forge-amber" />
        {shareText(pack)}
      </p>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onOpen()
        }}
        className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-pulse-cyan/50 px-4 py-2 text-xs text-pulse-cyan transition-colors hover:bg-pulse-cyan/[0.08]"
      >
        {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        查看详情 / 购买挂载
      </button>
    </article>
  )
}

// ─── 页面 ────────────────────────────────────────────────────────────────────

export default function SkillShop() {
  const [packs, setPacks] = useState<ShopPack[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [track, setTrack] = useState('')
  const [layer, setLayer] = useState('')
  const [q, setQ] = useState('')
  const [qInput, setQInput] = useState('')
  const [detailKey, setDetailKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const input: Record<string, unknown> = {}
    if (track) input.track = track
    if (layer) input.layer = layer
    if (q) input.q = q
    wbQuery<ShopPackRaw[] | { rows: ShopPackRaw[] }>('skillShop.list', input)
      .then((res) => {
        if (cancelled) return
        const rows = Array.isArray(res) ? res : (res?.rows ?? [])
        setPacks(rows.map(normalizePack))
      })
      .catch((err) => {
        if (cancelled) return
        setError(wbErrorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [track, layer, q])

  return (
    <section className="mx-auto max-w-site px-5 py-16 md:px-12 md:py-20">
      {/* 页头 */}
      <div className="text-center">
        <p className="hud-label text-pulse-cyan/80">SKILL SHOP</p>
        <h1 className="mt-3 font-display text-3xl font-bold tracking-[0.02em] text-ink-primary md:text-4xl">
          技能商店
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-ink-secondary">
          平台官方、企业岗位共创与个人创作者沉淀的技能包资产。以 Token（调用计量）计价，三方分账透明公示；购买后请前往智能工作台挂载到数字员工。
        </p>
      </div>

      {/* 筛选栏 */}
      <div className="mx-auto mt-10 flex max-w-3xl flex-wrap items-center justify-center gap-3">
        <div className="flex gap-1.5">
          {TRACK_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setTrack(f.key)}
              className={cn(
                'rounded-lg border px-3.5 py-1.5 text-xs transition-colors duration-300',
                track === f.key
                  ? 'border-pulse-cyan/50 bg-pulse-cyan/10 text-pulse-cyan'
                  : 'border-line-subtle text-ink-secondary hover:border-pulse-cyan/50 hover:text-ink-primary',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <Layers className="h-3.5 w-3.5 text-ink-faint" />
          {LAYER_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setLayer(f.key)}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-xs transition-colors duration-300',
                layer === f.key
                  ? 'border-forge-amber/50 bg-forge-amber/10 text-forge-amber'
                  : 'border-line-subtle text-ink-secondary hover:border-forge-amber/50 hover:text-ink-primary',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            setQ(qInput.trim())
          }}
        >
          <input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="搜索技能包…"
            className="w-40 rounded-[10px] border border-line-subtle bg-void/60 px-3.5 py-2 text-xs text-ink-primary outline-none transition-colors placeholder:text-ink-faint focus:border-pulse-cyan/60"
          />
          <button
            type="submit"
            aria-label="搜索"
            className="rounded-[10px] border border-pulse-cyan/50 p-2 text-pulse-cyan transition-colors hover:bg-pulse-cyan/[0.08]"
          >
            <Search className="h-4 w-4" />
          </button>
        </form>
      </div>

      {/* 商品网格 */}
      {error ? (
        <p className="mx-auto mt-12 max-w-xl rounded-xl border border-ember-red/30 bg-ember-red/[0.06] px-4 py-3 text-center text-xs text-ember-red">
          {error}
        </p>
      ) : !packs ? (
        <div className="mt-12 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="glass-panel animate-pulse rounded-xl p-5">
              <div className="h-5 w-1/2 rounded bg-panel" />
              <div className="mt-3 h-8 rounded bg-panel" />
              <div className="mt-4 h-16 rounded bg-panel" />
            </div>
          ))}
        </div>
      ) : packs.length === 0 ? (
        <p className="mt-12 text-center text-sm text-ink-faint">暂无上架技能包{q ? `（搜索「${q}」）` : ''}。</p>
      ) : (
        <div className="mt-12 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {packs.map((p) => (
            <PackCard key={p.packKey} pack={p} onOpen={() => setDetailKey(p.packKey)} />
          ))}
        </div>
      )}

      {/* 分账说明 */}
      <div className="glass-panel mx-auto mt-14 max-w-3xl rounded-xl p-6">
        <p className="hud-label text-forge-amber/80">REVENUE SHARE</p>
        <h3 className="mt-1 text-base font-bold text-ink-primary">三方分账说明</h3>
        <ul className="mt-3 space-y-1.5 text-xs leading-relaxed text-ink-secondary">
          <li>· 岗位共创（A）：企业 50% · 创作者 30% · 平台 20%</li>
          <li>· 个人创作（B）：创作者 60% · 企业 20% · 平台 20%</li>
          <li>· 平台官方包：平台 100%</li>
        </ul>
        <p className="mt-3 text-[11px] text-ink-faint">金额以 Token（调用计量）计；收益结算兑换通道未来开放。</p>
      </div>

      {detailKey && <DetailDrawer packKey={detailKey} onClose={() => setDetailKey(null)} />}
    </section>
  )
}
