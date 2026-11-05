import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { trpc } from '@/providers/trpc'
import { AGENTS } from '@/data/agents'
import MarketAgentCard from '@/components/market/MarketAgentCard'
import type { ApiAgentCard, MarketAgent } from '@/components/market/types'
import { fromApiAgent, fromStaticAgent } from '@/components/market/types'
import SectionHeader from '@/components/SectionHeader'

interface RelatedAgentsProps {
  numericId: number | null
  currentSlug: string
}

/** 相关工匠推荐：agents.related，离线时取静态数据中的其余工匠 */
export default function RelatedAgents({ numericId, currentSlug }: RelatedAgentsProps) {
  const relatedQuery = trpc.agents.related.useQuery(
    { id: numericId ?? 0, limit: 4 },
    { enabled: numericId != null, staleTime: 30_000, retry: 1 },
  )

  const offline = numericId == null || relatedQuery.isError

  const agents: MarketAgent[] = useMemo(() => {
    if (relatedQuery.data) return (relatedQuery.data as ApiAgentCard[]).map(fromApiAgent)
    if (offline) {
      return AGENTS.filter((a) => a.id !== currentSlug)
        .slice(0, 4)
        .map(fromStaticAgent)
    }
    return []
  }, [relatedQuery.data, offline, currentSlug])

  if (!offline && relatedQuery.isLoading) {
    return (
      <section className="bg-deep py-[72px] md:py-[120px]">
        <div className="mx-auto max-w-site px-5 md:px-12">
          <div className="h-8 w-48 animate-pulse rounded bg-panel/60" />
          <div className="mt-10 grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-[380px] animate-pulse rounded-2xl glass-panel" />
            ))}
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="bg-deep py-[72px] md:py-[120px]">
      <div className="mx-auto max-w-site px-5 md:px-12">
        <SectionHeader
          hud="EMPLOYERS ALSO HIRED"
          title="雇主们还雇佣了"
          subtitle="同行业、相近能力谱系的其他数字工匠。"
          align="left"
          className="max-w-none"
        />
        <div className="mt-12 grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
          {agents.map((a, i) => (
            <motion.div
              key={a.routeId}
              initial={{ opacity: 0, y: 60 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-60px' }}
              transition={{ delay: i * 0.09, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            >
              <MarketAgentCard agent={a} />
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
