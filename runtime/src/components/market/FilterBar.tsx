import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, RotateCcw } from 'lucide-react'
import { Slider } from '@/components/ui/slider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatToken } from '@/components/market/types'
import { cn } from '@/lib/utils'

export type SortKey = 'recommended' | 'rating' | 'priceAsc' | 'priceDesc' | 'tasks' | 'newest'

export interface MarketFilters {
  search: string
  industries: string[]
  capabilities: string[]
  priceRange: [number, number]
  sort: SortKey
}

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'recommended', label: '综合推荐' },
  { value: 'rating', label: '评分最高' },
  { value: 'priceAsc', label: '价格从低到高' },
  { value: 'tasks', label: '任务量最多' },
  { value: 'newest', label: '最新上架' },
]

interface FilterBarProps {
  filters: MarketFilters
  onChange: (f: MarketFilters) => void
  facets: { industries: string[]; capabilities: string[]; minPrice: number; maxPrice: number }
  total: number
  loading: boolean
}

/** Sticky glass filter toolbar: industry multi-select, capability chips, price slider, sort */
export default function FilterBar({ filters, onChange, facets, total, loading }: FilterBarProps) {
  const [industryOpen, setIndustryOpen] = useState(false)

  const toggleIndustry = (ind: string) => {
    const next = filters.industries.includes(ind)
      ? filters.industries.filter((i) => i !== ind)
      : [...filters.industries, ind]
    onChange({ ...filters, industries: next })
  }

  const toggleCapability = (cap: string) => {
    const next = filters.capabilities.includes(cap)
      ? filters.capabilities.filter((c) => c !== cap)
      : [...filters.capabilities, cap]
    onChange({ ...filters, capabilities: next })
  }

  const hasActive =
    filters.industries.length > 0 ||
    filters.capabilities.length > 0 ||
    filters.priceRange[0] > facets.minPrice ||
    filters.priceRange[1] < facets.maxPrice ||
    filters.search.trim().length > 0

  const reset = () =>
    onChange({
      ...filters,
      search: '',
      industries: [],
      capabilities: [],
      priceRange: [facets.minPrice, facets.maxPrice],
    })

  return (
    <motion.div
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.9, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="sticky top-16 z-30 -mx-5 px-5 py-3 md:-mx-12 md:px-12"
    >
      <div className="rounded-2xl glass-panel p-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          {/* industry multi-select dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setIndustryOpen((v) => !v)}
              className={cn(
                'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors',
                filters.industries.length > 0
                  ? 'border-nebula-violet/60 bg-nebula-violet/10 text-ink-primary'
                  : 'border-line-subtle text-ink-secondary hover:border-pulse-cyan/40',
              )}
            >
              行业
              {filters.industries.length > 0 && (
                <span className="rounded-full bg-nebula-violet/30 px-1.5 font-mono text-[10px] text-ink-primary">
                  {filters.industries.length}
                </span>
              )}
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', industryOpen && 'rotate-180')} />
            </button>
            <AnimatePresence>
              {industryOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.18 }}
                  className="absolute left-0 top-full z-40 mt-2 w-44 overflow-hidden rounded-xl glass-panel p-1.5"
                >
                  {facets.industries.map((ind) => {
                    const active = filters.industries.includes(ind)
                    return (
                      <button
                        key={ind}
                        type="button"
                        onClick={() => toggleIndustry(ind)}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                          active ? 'bg-nebula-violet/15 text-ink-primary' : 'text-ink-secondary hover:bg-pulse-cyan/10',
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-3.5 w-3.5 items-center justify-center rounded-sm border',
                            active ? 'border-nebula-violet bg-nebula-violet text-[9px] text-white' : 'border-line-subtle',
                          )}
                        >
                          {active && '✓'}
                        </span>
                        {ind}
                      </button>
                    )
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* capability chips */}
          <div className="flex flex-wrap items-center gap-1.5">
            {facets.capabilities.map((cap) => {
              const active = filters.capabilities.includes(cap)
              return (
                <button
                  key={cap}
                  type="button"
                  onClick={() => toggleCapability(cap)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs transition-colors',
                    active
                      ? 'border-pulse-cyan bg-pulse-cyan/15 text-pulse-cyan'
                      : 'border-pulse-cyan/30 text-ink-secondary hover:border-pulse-cyan/60 hover:text-pulse-cyan',
                  )}
                >
                  {cap}
                </button>
              )
            })}
          </div>

          {/* price range slider */}
          <div className="flex min-w-[220px] flex-1 items-center gap-3 md:max-w-[300px]">
            <span className="whitespace-nowrap font-mono text-[11px] text-forge-amber">
              {formatToken(filters.priceRange[0])}
            </span>
            <Slider
              value={filters.priceRange}
              onValueChange={(v) => onChange({ ...filters, priceRange: [v[0] ?? facets.minPrice, v[1] ?? facets.maxPrice] })}
              min={facets.minPrice}
              max={facets.maxPrice}
              step={100}
              className="flex-1"
            />
            <span className="whitespace-nowrap font-mono text-[11px] text-forge-amber">
              {formatToken(filters.priceRange[1])}
            </span>
            <span className="whitespace-nowrap font-mono text-[10px] text-ink-faint">Token/月</span>
          </div>

          {/* sort */}
          <Select value={filters.sort} onValueChange={(v) => onChange({ ...filters, sort: v as SortKey })}>
            <SelectTrigger className="h-9 w-[136px] border-line-subtle bg-transparent text-sm text-ink-secondary">
              <SelectValue placeholder="排序" />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* reset + result count */}
          <div className="ml-auto flex items-center gap-3">
            {hasActive && (
              <button
                type="button"
                onClick={reset}
                className="flex items-center gap-1 text-xs text-ink-faint transition-colors hover:text-pulse-cyan"
              >
                <RotateCcw className="h-3 w-3" /> 重置
              </button>
            )}
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.p
                key={total}
                initial={{ y: '60%', opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: '-60%', opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="whitespace-nowrap font-mono text-xs text-ink-secondary"
              >
                共 <span className="text-pulse-cyan">{loading ? '…' : total}</span> 位工匠符合条件
              </motion.p>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
