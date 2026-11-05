import type { Agent as StaticAgent } from '@/data/agents'

/** Backend AgentCard row shape (agents.list / leaderboard / related / recommended) */
export interface ApiAgentCard {
  id: number
  slug: string
  code: string
  name: string
  avatar: string
  industry: string
  industryGroup: string
  capabilityTags: string[]
  status: 'pending' | 'active' | 'suspended'
  delistRisk: boolean
  monthlyPrice: number
  suggestedPrice: number
  tasksCompleted: number
  successRate: number
  avgRating: number
  ratingCount: number
  experienceMonths: number
  skillCount: number
  memoryCount: number
  weeklyHires: number
  weeklyHireTrend: number[]
  recommended: boolean
  certified: boolean
  listedAt: Date
  masterName?: string | null
  masterSignature: string | null
  masterReputation?: number | null
  /** iter83 3D 数字人：参数化形象配置 + 购买前自我介绍 */
  avatarConfig?: { seed: string; palette: { primary: string; accent: string }; ring?: boolean } | null
  introText?: string | null
}

/** Normalized shape consumed by market/detail card components */
export interface MarketAgent {
  /** route param: slug when known, otherwise numeric id as string */
  routeId: string
  numericId: number | null
  slug: string | null
  code: string
  name: string
  avatar: string
  industry: string
  industryGroup: string
  masterLine: string
  masterReputation: number | null
  tags: string[]
  skillCount: number
  monthlyPrice: number
  suggestedPrice: number | null
  avgRating: number
  ratingCount: number
  tasksCompleted: number
  successRate: number
  status: string
  recommended: boolean
  certified: boolean
  weeklyHires: number
  weeklyHireTrend: number[]
  listedAt: Date | null
  /** iter83 3D 数字人形象配置与自我介绍 */
  avatarConfig: { seed: string; palette: { primary: string; accent: string }; ring?: boolean } | null
  introText: string | null
}

export function fromApiAgent(a: ApiAgentCard): MarketAgent {
  return {
    routeId: a.slug || String(a.id),
    numericId: a.id,
    slug: a.slug,
    code: a.code,
    name: a.name,
    avatar: a.avatar,
    industry: a.industry,
    industryGroup: a.industryGroup ?? '工业制造',
    masterLine: a.masterSignature ?? (a.masterName ? `师承 · ${a.masterName}` : '师承信息待补全'),
    masterReputation: a.masterReputation ?? null,
    tags: a.capabilityTags,
    skillCount: a.skillCount,
    monthlyPrice: a.monthlyPrice,
    suggestedPrice: a.suggestedPrice,
    avgRating: a.avgRating,
    ratingCount: a.ratingCount,
    tasksCompleted: a.tasksCompleted,
    successRate: a.successRate,
    status: a.status,
    recommended: a.recommended,
    certified: a.certified,
    weeklyHires: a.weeklyHires,
    weeklyHireTrend: a.weeklyHireTrend ?? [],
    listedAt: a.listedAt ?? null,
    avatarConfig: a.avatarConfig ?? (a.slug ? { seed: a.slug, palette: { primary: '#e8a33d', accent: '#7dd3c8' } } : null),
    introText: a.introText ?? null,
  }
}

export function fromStaticAgent(a: StaticAgent): MarketAgent {
  return {
    routeId: a.id,
    numericId: null,
    slug: a.id,
    code: a.code,
    name: a.name,
    avatar: a.avatar,
    industry: a.industry,
    industryGroup: '工业制造',
    masterLine: `师承 · ${a.master}`,
    masterReputation: null,
    tags: a.tags,
    skillCount: a.skills,
    monthlyPrice: a.price,
    suggestedPrice: null,
    avgRating: a.rating,
    ratingCount: 0,
    tasksCompleted: a.tasks,
    successRate: 0,
    status: 'active',
    recommended: a.id === 'zhenheng',
    certified: true,
    weeklyHires: 0,
    weeklyHireTrend: [],
    listedAt: null,
    avatarConfig: { seed: a.id, palette: { primary: '#e8a33d', accent: '#7dd3c8' } },
    introText: null,
  }
}

export function formatToken(n: number): string {
  return n.toLocaleString('zh-CN')
}
