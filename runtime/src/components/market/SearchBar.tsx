import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useNavigate } from 'react-router'
import { Search, Wrench } from 'lucide-react'
import { trpc } from '@/providers/trpc'

const HOT_SEARCHES = ['振动频谱分析', '焊接缺陷检测', '热处理优化', '产线巡检', '精密校准']

interface SearchBarProps {
  value: string
  onChange: (v: string) => void
}

/** Big glassmorphism search box with live suggestions + hot-search chips */
export default function SearchBar({ value, onChange }: SearchBarProps) {
  const navigate = useNavigate()
  const [keyword, setKeyword] = useState(value)
  const [focused, setFocused] = useState(false)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // debounce outward change
  useEffect(() => {
    const t = setTimeout(() => onChange(keyword), 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword])

  const suggestQuery = trpc.agents.suggest.useQuery(
    { keyword: keyword.trim() },
    { enabled: keyword.trim().length > 0, staleTime: 30_000, retry: 1 },
  )
  const suggestions = suggestQuery.data ?? []

  const commit = (v: string) => {
    setKeyword(v)
    onChange(v)
    setFocused(false)
  }

  return (
    <div className="w-full max-w-[640px]">
      <motion.div
        initial={{ opacity: 0, scaleY: 0.6 }}
        animate={{ opacity: 1, scaleY: 1 }}
        transition={{ delay: 0.4, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="relative"
      >
        <div
          className={`flex h-14 items-center gap-2 rounded-2xl glass-panel pl-5 pr-2 transition-shadow duration-300 ${
            focused ? 'shadow-[0_0_24px_rgba(34,211,238,0.25)] ring-1 ring-pulse-cyan/50' : ''
          }`}
        >
          <Search className="h-5 w-5 shrink-0 text-ink-faint" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onFocus={() => {
              if (blurTimer.current) clearTimeout(blurTimer.current)
              setFocused(true)
            }}
            onBlur={() => {
              blurTimer.current = setTimeout(() => setFocused(false), 150)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit(keyword)
            }}
            placeholder="搜索工匠、技能或行业，如：振动诊断 / CNC / 焊接质检"
            className="h-full flex-1 bg-transparent text-sm text-ink-primary placeholder:text-ink-faint focus:outline-none"
          />
          <button
            type="button"
            onClick={() => commit(keyword)}
            className="flex h-10 items-center gap-2 rounded-xl bg-pulse-cyan/15 px-4 text-sm font-medium text-pulse-cyan transition-colors hover:bg-pulse-cyan/25"
          >
            <Search className="h-4 w-4" /> 搜索
          </button>
        </div>

        {/* suggestions dropdown */}
        <AnimatePresence>
          {focused && keyword.trim().length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-x-0 top-full z-30 mt-2 overflow-hidden rounded-xl glass-panel"
            >
              {suggestQuery.isLoading ? (
                <p className="px-4 py-3 font-mono text-xs text-ink-faint">正在联想…</p>
              ) : suggestions.length === 0 ? (
                <p className="px-4 py-3 text-xs text-ink-faint">暂无匹配的工匠，试试行业或能力关键词</p>
              ) : (
                suggestions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      commit(s.name)
                      navigate(`/market/agent/${s.id}`)
                    }}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-pulse-cyan/10"
                  >
                    <span className="flex items-center gap-3">
                      <span className="font-display text-sm font-bold text-ink-primary">{s.name}</span>
                      <span className="font-mono text-[10px] tracking-widest text-ink-faint">{s.code}</span>
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] text-pulse-cyan">
                      {s.matchedSkill && (
                        <>
                          <Wrench className="h-3 w-3" />
                          {s.matchedSkill}
                        </>
                      )}
                    </span>
                  </button>
                ))
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* hot search chips */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">热门</span>
        {HOT_SEARCHES.map((h, i) => (
          <motion.button
            key={h}
            type="button"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.55 + i * 0.05, type: 'spring', stiffness: 400, damping: 18 }}
            onClick={() => commit(h)}
            className="rounded-full border border-line-subtle px-3 py-1 text-xs text-ink-secondary transition-colors hover:border-forge-amber/50 hover:text-forge-amber"
          >
            {h}
          </motion.button>
        ))}
      </div>
    </div>
  )
}
