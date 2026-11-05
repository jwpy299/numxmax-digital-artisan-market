import { useEffect, useMemo } from 'react'
import AgentIpImage from '@/components/market/AgentIpImage'
import { motion } from 'framer-motion'
import { Link, useLocation, useParams } from 'react-router'
import { BadgeCheck, ChevronRight, CloudOff, Sparkles } from 'lucide-react'
import { trpc } from '@/providers/trpc'
import { AGENTS } from '@/data/agents'
import type { ApiAgentCard } from '@/components/market/types'
import TagChip from '@/components/TagChip'
import HudCorner from '@/components/HudCorner'
import GlowButton from '@/components/GlowButton'
import type { ApiDetail, DetailData } from '@/components/agent-detail/detail-data'
import { fallbackDetail, fromApiDetail } from '@/components/agent-detail/detail-data'
import HirePanel from '@/components/agent-detail/HirePanel'

import IdentityCard from '@/components/agent-detail/IdentityCard'
import SkillGrid from '@/components/agent-detail/SkillGrid'
import MemorySection from '@/components/agent-detail/MemorySection'
import ReviewsSection from '@/components/agent-detail/ReviewsSection'
import TrialSection from '@/components/agent-detail/TrialSection'
import RelatedAgents from '@/components/agent-detail/RelatedAgents'
import SkillBadges from '@/components/agent-detail/SkillBadges'

const easeOut = [0.16, 1, 0.3, 1] as [number, number, number, number]

export default function AgentDetail() {
  const { id: rawId } = useParams<{ id: string }>()
  const location = useLocation()
  const isNumeric = !!rawId && /^\d+$/.test(rawId)

  // slug → numeric id resolution (route accepts both /market/agent/7 and /market/agent/zhenheng)
  const listQuery = trpc.agents.list.useQuery(
    { limit: 50 },
    { enabled: !isNumeric, staleTime: 60_000, retry: 1 },
  )
  const resolvedId = useMemo(() => {
    if (isNumeric) return Number(rawId)
    const hit = (listQuery.data?.items as ApiAgentCard[] | undefined)?.find(
      (a) => a.slug === rawId || a.code === rawId,
    )
    return hit?.id ?? null
  }, [isNumeric, rawId, listQuery.data])

  const detailQuery = trpc.agents.detail.useQuery(
    { id: resolvedId ?? 0 },
    { enabled: resolvedId != null, staleTime: 15_000, retry: 1 },
  )

  // offline fallback from static design data
  const staticAgent = useMemo(() => {
    if (!isNumeric) {
      return AGENTS.find((a) => a.id === rawId) ?? AGENTS[0]!
    }
    const idx = Number(rawId) - 1
    return (idx >= 0 && idx < AGENTS.length ? AGENTS[idx] : AGENTS[0])!
  }, [isNumeric, rawId])

  const apiFailed =
    detailQuery.isError || (!isNumeric && listQuery.isError) || (!isNumeric && listQuery.isSuccess && resolvedId == null)

  const detail: DetailData | null = useMemo(() => {
    if (detailQuery.data) return fromApiDetail(detailQuery.data as unknown as ApiDetail)
    if (apiFailed) return fallbackDetail(staticAgent)
    return null
  }, [detailQuery.data, apiFailed, staticAgent])

  // hash scroll (e.g. /market/agent/:id#trial from market card CTA)
  useEffect(() => {
    if (!location.hash || !detail) return
    const t = setTimeout(() => {
      document.querySelector(location.hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 400)
    return () => clearTimeout(t)
  }, [location.hash, detail])

  if (!detail) {
    return (
      <div className="bg-void">
        <div className="mx-auto max-w-site px-5 py-20 md:px-12">
          <div className="grid gap-10 lg:grid-cols-[62%_1fr]">
            <div className="space-y-6">
              <div className="h-6 w-64 animate-pulse rounded bg-panel/60" />
              <div className="h-40 w-40 animate-pulse rounded-full bg-panel/60" />
              <div className="h-12 w-72 animate-pulse rounded bg-panel/60" />
              <div className="h-24 animate-pulse rounded-2xl glass-panel" />
            </div>
            <div className="h-[480px] animate-pulse rounded-2xl glass-panel" />
          </div>
        </div>
      </div>
    )
  }

  const { agent, master } = detail
  const nameChars = Array.from(agent.name)

  return (
    <div className="bg-void">
      {/* Section 1 · 档案头 */}
      <section className="relative overflow-hidden">
        <div className="nebula-halo pointer-events-none absolute -top-40 right-0 h-[480px] w-[720px]" />
        <div className="relative mx-auto max-w-site px-5 pb-[72px] pt-14 md:px-12 md:pb-[120px]">
          {apiFailed && (
            <div className="mb-8 flex items-center justify-center gap-2 rounded-xl border border-forge-amber/30 bg-forge-amber/5 px-4 py-2.5 text-xs text-forge-amber">
              <CloudOff className="h-3.5 w-3.5" />
              实时档案接口暂不可用，正在展示离线演示数据
            </div>
          )}

          <div className="grid gap-12 lg:grid-cols-[62%_1fr]">
            {/* left · identity */}
            <div>
              {/* breadcrumb */}
              <nav className="flex items-center gap-1.5 text-xs text-ink-faint">
                <Link to="/market" className="transition-colors hover:text-pulse-cyan">
                  数字匠市
                </Link>
                <ChevronRight className="h-3 w-3" />
                <span>{agent.industry}</span>
                <ChevronRight className="h-3 w-3" />
                <span className="text-ink-secondary">{agent.name}</span>
              </nav>

              {/* iter83 3D 数字人主视觉（静态头像兜底） */}
              <motion.div
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.7, ease: [0.34, 1.4, 0.64, 1] }}
                className="relative mt-8 h-40 w-40"
              >
                <div className="nebula-halo absolute -inset-6" />
                {/* iter96 熊猫 IP 3D 形象（角色化渲染图），原 avatar 兜底 */}
                <AgentIpImage
                  tags={agent.capabilityTags ?? []}
                  code={agent.code}
                  alt={agent.name}
                  fallback={agent.avatar}
                  className="relative h-40 w-40 rounded-full border-2 border-pulse-cyan/40 object-contain bg-gradient-to-b from-[#101a2e] to-[#0A0F1E] shadow-[0_0_40px_rgba(56,225,255,0.30)]"
                />
                <span className="absolute bottom-2 right-2 flex h-6 w-6 items-center justify-center rounded-full border-2 border-void bg-jade-green">
                  <span className="sr-only">可雇佣</span>
                </span>
              </motion.div>

              {/* name + code + badges */}
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <h1 className="font-display text-4xl font-bold tracking-[0.02em] text-ink-primary md:text-[56px] md:leading-tight">
                  {nameChars.map((c, i) => (
                    <motion.span
                      key={i}
                      className="inline-block"
                      initial={{ opacity: 0, y: 40, rotateX: -30 }}
                      animate={{ opacity: 1, y: 0, rotateX: 0 }}
                      transition={{ delay: i * 0.04, duration: 0.6, ease: easeOut }}
                    >
                      {c}
                    </motion.span>
                  ))}
                </h1>
                <span className="mt-2 font-mono text-sm tracking-widest text-ink-faint">{agent.code}</span>
                {agent.recommended && (
                  <span className="animate-rec-badge mt-2 flex items-center gap-1 rounded-full border border-forge-amber/50 bg-forge-amber/10 px-2.5 py-1 text-[11px] font-medium text-forge-amber">
                    <Sparkles className="h-3 w-3" /> 市场推荐
                  </span>
                )}
                {agent.certified && (
                  <span className="mt-2 flex items-center gap-1 rounded-full border border-pulse-cyan/50 bg-pulse-cyan/10 px-2.5 py-1 text-[11px] font-medium text-pulse-cyan">
                    <BadgeCheck className="h-3 w-3" /> 平台认证
                  </span>
                )}
                <span className="mt-2 flex items-center rounded-full border border-line-subtle bg-panel/60 px-2.5 py-1 text-[11px] font-medium text-ink-secondary">
                  {agent.industryGroup} · {agent.industry}
                </span>
              </div>

              {/* master lineage + reputation */}
              {master && (
                <div className="mt-5 max-w-xl">
                  <p className="text-[15px] text-ink-secondary">
                    师承 · {master.name} — {master.yearsExperience} 年{master.signature.split('·')[1]?.replace(/^\s*\d+\s*年/, '').trim() || '一线经验'}
                    {master.title ? `，${master.title}` : ''}
                  </p>
                  <div className="mt-3 flex items-center gap-3">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel/80">
                      <motion.div
                        initial={{ scaleX: 0 }}
                        animate={{ scaleX: 1 }}
                        transition={{ delay: 0.5, duration: 0.9, ease: easeOut }}
                        className="h-full origin-left rounded-full bg-brand-gradient"
                        style={{ width: `${master.reputation}%` }}
                      />
                    </div>
                    <span className="whitespace-nowrap font-mono text-[11px] text-ink-faint">
                      老师傅声望 {master.reputation}/100
                    </span>
                  </div>
                </div>
              )}

              {/* capability tags */}
              <div className="mt-6 flex flex-wrap gap-2">
                {agent.capabilityTags.map((t, i) => (
                  <motion.span
                    key={t}
                    initial={{ opacity: 0, scale: 0.7 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.4 + i * 0.06, type: 'spring', stiffness: 400, damping: 18 }}
                  >
                    <TagChip label={t} />
                  </motion.span>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {agent.industries.map((ind) => (
                  <span
                    key={ind}
                    className="rounded-full border border-line-subtle px-3 py-1 text-xs text-ink-faint"
                  >
                    {ind}
                  </span>
                ))}
              </div>

              {/* 迭代 30：技能徽章（skills.byAgentPublic 免登录，失败静默不渲染） */}
              <SkillBadges agentId={agent.numericId} />

              {/* key metrics */}
              <motion.div
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5, duration: 0.7, ease: easeOut }}
                className="relative mt-8 grid grid-cols-2 gap-4 rounded-2xl glass-panel p-6 sm:grid-cols-4"
              >
                <HudCorner />
                <div>
                  <p className="font-grotesk text-2xl font-bold text-ink-primary">
                    {agent.tasksCompleted.toLocaleString('zh-CN')}
                    <span className="ml-1 text-xs font-normal text-ink-faint">单</span>
                  </p>
                  <p className="mt-1 text-[11px] text-ink-faint">累计任务</p>
                </div>
                <div>
                  <p className="font-grotesk text-2xl font-bold text-jade-green">
                    {agent.successRate > 0 ? `${agent.successRate.toFixed(1)}%` : '待验证'}
                  </p>
                  <p className="mt-1 text-[11px] text-ink-faint">成功率{agent.successRate > 0 ? '' : '（真实样本积累中）'}</p>
                </div>
                <div>
                  <p className="font-grotesk text-2xl font-bold text-forge-amber">
                    {agent.avgRating > 0 ? `${agent.avgRating.toFixed(1)}★` : '待验证'}
                  </p>
                  <p className="mt-1 text-[11px] text-ink-faint">平均评分{agent.avgRating > 0 ? '' : '（真实评价积累中）'}</p>
                </div>
                <div>
                  <p className="font-grotesk text-2xl font-bold text-pulse-cyan">
                    {agent.memoryCount >= 10000
                      ? `${(agent.memoryCount / 10000).toFixed(1)} 万`
                      : agent.memoryCount.toLocaleString('zh-CN')}
                    <span className="ml-1 text-xs font-normal text-ink-faint">条</span>
                  </p>
                  <p className="mt-1 text-[11px] text-ink-faint">工作记忆</p>
                </div>
              </motion.div>
            </div>

            {/* right · sticky hire panel */}
            <HirePanel detail={detail} />
          </div>
        </div>
      </section>

      {/* Section 2 · 数字身份证（赛博凭证） */}
      <IdentityCard
        agent={agent}
        did={
          // 若详情接口已返回 identity.did 则以后端为准，否则前端按 slug 拼
          (detailQuery.data as unknown as { identity?: { did?: string } } | undefined)?.identity?.did ??
          undefined
        }
      />

      {/* Section 3 · 技能清单 */}
      <SkillGrid skills={detail.skills} />

      {/* Section 3 · 工作记忆 */}
      <MemorySection memories={detail.memories} memoryCount={agent.memoryCount} />

      {/* Section 4 · 雇佣记录与雇主评价 */}
      <ReviewsSection
        reviews={detail.reviews}
        distribution={detail.ratingDistribution}
        avgRating={agent.avgRating}
        ratingCount={agent.ratingCount}
      />

      {/* Section 5 · 7 天试用说明 */}
      <TrialSection />

      {/* Section 6 · 相关工匠推荐 */}
      <RelatedAgents numericId={agent.numericId} currentSlug={agent.slug} />

      {/* Section 7 · 底部 CTA */}
      <section className="relative overflow-hidden bg-void pb-[72px] pt-4 md:pb-[120px]">
        <img
          src="/nebula-band.png"
          alt=""
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 w-full opacity-40"
        />
        <div className="relative mx-auto max-w-site px-5 text-center md:px-12">
          <motion.h2
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.7, ease: easeOut }}
            className="mx-auto max-w-2xl font-display text-[26px] font-bold leading-snug text-ink-primary md:text-4xl"
          >
            「把 {master?.yearsExperience ?? 30} 年的经验，请回你的工厂。」
          </motion.h2>
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 0.2, duration: 0.6, ease: [0.34, 1.4, 0.64, 1] }}
            className="mt-8 flex flex-wrap justify-center gap-4"
          >
            <GlowButton
              onClick={() =>
                document.getElementById('trial')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            >
              申请 7 天免费试用
            </GlowButton>
            <GlowButton
              variant="secondary"
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            >
              签订智能合约
            </GlowButton>
          </motion.div>
        </div>
      </section>
    </div>
  )
}
