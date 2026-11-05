import { useMemo } from 'react'
import { motion } from 'framer-motion'
import type { DetailData } from '@/components/agent-detail/detail-data'
import SectionHeader from '@/components/SectionHeader'
import HudCorner from '@/components/HudCorner'
import CountUp from '@/components/market/CountUp'
import { cn } from '@/lib/utils'

const CATEGORY_COLORS: Record<string, string> = {
  设备特征: '#22D3EE',
  工艺参数: '#7C5CFF',
  雇主偏好: '#F5A524',
  环境补偿: '#34D399',
}
const FALLBACK_CATS = [
  { category: '设备特征', pct: 38 },
  { category: '工艺参数', pct: 27 },
  { category: '雇主偏好', pct: 21 },
  { category: '环境补偿', pct: 14 },
]

interface MemorySectionProps {
  memories: DetailData['memories']
  memoryCount: number
}

function MemoryDonut({ cats }: { cats: { category: string; pct: number }[] }) {
  const R = 52
  const C = 2 * Math.PI * R
  let offset = 0
  return (
    <svg viewBox="0 0 140 140" className="h-40 w-40 -rotate-90">
      <circle cx="70" cy="70" r={R} fill="none" stroke="rgba(124,140,222,0.12)" strokeWidth="14" />
      {cats.map((c, i) => {
        const len = (c.pct / 100) * C
        const el = (
          <motion.circle
            key={c.category}
            cx="70"
            cy="70"
            r={R}
            fill="none"
            stroke={CATEGORY_COLORS[c.category] ?? '#55638A'}
            strokeWidth="14"
            strokeDasharray={`${len} ${C - len}`}
            strokeDashoffset={-offset}
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.15, duration: 0.8 }}
          />
        )
        offset += len
        return el
      })}
    </svg>
  )
}

/** 工作记忆：时间线 + 统计面板 */
export default function MemorySection({ memories, memoryCount }: MemorySectionProps) {
  const cats = useMemo(() => {
    if (memories.length === 0) return FALLBACK_CATS
    const counts = new Map<string, number>()
    memories.forEach((m) => counts.set(m.category, (counts.get(m.category) ?? 0) + 1))
    const total = memories.length
    return Array.from(counts.entries())
      .map(([category, n]) => ({ category, pct: Math.round((n / total) * 100) }))
      .sort((a, b) => b.pct - a.pct)
  }, [memories])

  return (
    <section className="bg-void py-[72px] md:py-[120px]">
      <div className="mx-auto max-w-site px-5 md:px-12">
        <SectionHeader
          hud="WORKING MEMORY"
          title="工作记忆"
          subtitle="每一次任务都在沉淀记忆——它越用越懂你的设备、工艺与偏好。"
        />

        <div className="mt-14 grid gap-10 lg:grid-cols-[55%_1fr]">
          {/* timeline */}
          <div className="relative pl-8">
            <span className="absolute bottom-2 left-[5px] top-2 w-px bg-gradient-to-b from-pulse-cyan/60 via-nebula-violet/40 to-transparent" />
            {memories.length === 0 && (
              <p className="text-sm text-ink-faint">记忆条目暂不可用</p>
            )}
            {memories.slice(0, 8).map((m, i) => (
              <motion.div
                key={m.id}
                initial={{ opacity: 0, x: -30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ delay: i * 0.12, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                className="relative mb-6 last:mb-0"
              >
                <motion.span
                  initial={{ scale: 0 }}
                  whileInView={{ scale: 1 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.12 + 0.1, type: 'spring', stiffness: 400, damping: 16 }}
                  className="absolute -left-8 top-2 h-[11px] w-[11px] rounded-full border-2 border-pulse-cyan bg-void shadow-[0_0_10px_rgba(34,211,238,0.5)]"
                />
                <div className="rounded-xl glass-panel p-4">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[11px] text-pulse-cyan">
                      {m.createdAt ? new Date(m.createdAt).toLocaleDateString('zh-CN') : '——'}
                    </span>
                    <span
                      className={cn('rounded-full border px-2 py-0.5 text-[10px]')}
                      style={{
                        color: CATEGORY_COLORS[m.category] ?? '#94A3C7',
                        borderColor: `${CATEGORY_COLORS[m.category] ?? '#55638A'}55`,
                      }}
                    >
                      {m.category}
                    </span>
                  </div>
                  <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{m.summary}</p>
                </div>
              </motion.div>
            ))}
          </div>

          {/* stats panel */}
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            className="relative h-fit rounded-2xl glass-panel p-8"
          >
            <HudCorner />
            <p className="hud-label text-pulse-cyan/80">MEMORY STATS</p>
            <p className="mt-4 font-grotesk text-[48px] font-bold leading-none text-ink-primary">
              <CountUp value={memoryCount} />
              <span className="ml-2 text-base font-normal text-ink-faint">条</span>
            </p>
            <p className="mt-2 text-sm text-ink-secondary">工作记忆条目</p>

            <div className="mt-6 flex items-center gap-6">
              <MemoryDonut cats={cats} />
              <ul className="flex-1 space-y-2.5">
                {cats.map((c) => (
                  <li key={c.category} className="flex items-center gap-2 text-xs text-ink-secondary">
                    <span
                      className="h-2.5 w-2.5 rounded-sm"
                      style={{ background: CATEGORY_COLORS[c.category] ?? '#55638A' }}
                    />
                    <span className="flex-1">{c.category}</span>
                    <span className="font-mono text-ink-primary">{c.pct}%</span>
                  </li>
                ))}
              </ul>
            </div>

            <p className="mt-6 border-t border-line-subtle pt-4 text-xs leading-relaxed text-ink-faint">
              记忆由向量数据库 + HermesAgent 记忆系统驱动，随任务持续沉淀。
            </p>
          </motion.div>
        </div>
      </div>
    </section>
  )
}
