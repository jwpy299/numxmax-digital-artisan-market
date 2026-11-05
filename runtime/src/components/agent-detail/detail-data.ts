import type { Agent as StaticAgent } from '@/data/agents'

/** Normalized Agent detail consumed by the detail page (API-adapted or fallback) */
export interface DetailData {
  agent: {
    numericId: number | null
    slug: string
    code: string
    name: string
    avatar: string
    industry: string
    industryGroup: string
    industries: string[]
    capabilityTags: string[]
    monthlyPrice: number
    suggestedPrice: number
    tasksCompleted: number
    successRate: number
    avgRating: number
    ratingCount: number
    experienceMonths: number
    skillCount: number
    memoryCount: number
    recommended: boolean
    certified: boolean
    status: string
    /** 发行（上架）日期；离线兜底数据为 null */
    listedAt: Date | null
    /** iter83 3D 数字人形象配置与购买前自我介绍 */
    avatarConfig: { seed: string; palette: { primary: string; accent: string }; ring?: boolean } | null
    introText: string | null
  }
  master: {
    name: string
    signature: string
    yearsExperience: number
    title: string | null
    reputation: number
  } | null
  skills: {
    id: number | string
    name: string
    type: 'V' | 'U'
    callCount: number
    successRate: number
    // Harness H1 技能真实化审计：执行器徽标 + 真实成功率（null=样本不足；离线兜底数据缺省）
    executorKind?: string | null
    badge?: 'real' | 'generative'
    realSuccessRate?: number | null
  }[]
  reviews: {
    id: number | string
    rating: number
    content: string
    employerTitle: string | null
    hireMonths: number | null
    enterpriseName: string | null
    enterpriseIndustry: string | null
    hireStatus: 'current' | 'history'
  }[]
  ratingDistribution: { star: number; count: number; pct: number }[]
  memories: { id: number | string; category: string; summary: string; createdAt: Date | null }[]
  pricing: {
    history: { date: string; price: number }[]
    changePct: number
    suggestedPrice: number
    masterAdjustment: number
  }
}

export type ApiDetail = {
  agent: {
    id: number
    slug: string
    code: string
    name: string
    avatar: string
    industry: string
    /** 行业大类（迭代 13 新增列；旧接口兜底为工业制造） */
    industryGroup?: string
    capabilityTags: string[]
    status: 'pending' | 'active' | 'suspended'
    monthlyPrice: number
    suggestedPrice: number
    tasksCompleted: number
    successRate: number
    avgRating: number
    ratingCount: number
    experienceMonths: number
    skillCount: number
    memoryCount: number
    recommended: boolean
    certified: boolean
    /** agents 详情返回完整行时带 listedAt */
    listedAt?: Date | null
    /** iter83 3D 数字人字段（agents 详情完整行携带） */
    avatarConfig?: { seed: string; palette: { primary: string; accent: string }; ring?: boolean } | null
    introText?: string | null
  }
  master: {
    name: string
    signature: string
    yearsExperience: number
    title: string | null
    reputation: number
  } | null
  skills: {
    id: number
    name: string
    type: 'V' | 'U'
    callCount: number
    successRate: number
    executorKind?: string | null
    badge?: 'real' | 'generative'
    realSuccessRate?: number | null
  }[]
  reviews: {
    id: number
    rating: number
    content: string
    employerTitle: string | null
    hireMonths: number | null
    hireRecordId: number | null
    enterpriseName: string | null
    enterpriseIndustry: string | null
  }[]
  ratingDistribution: { star: number; count: number; pct: number }[]
  memories: { id: number; category: string; summary: string; createdAt: Date }[]
  hireHistory: { id: number; status: 'trial' | 'active' | 'expired' | 'cancelled' }[]
  pricing: {
    history: { date: string; price: number }[]
    changePct: number
    suggestedPrice: number
    masterAdjustment: number
  }
}

export function fromApiDetail(d: ApiDetail): DetailData {
  const currentHireIds = new Set(
    d.hireHistory.filter((h) => h.status === 'active' || h.status === 'trial').map((h) => h.id),
  )
  return {
    agent: {
      numericId: d.agent.id,
      slug: d.agent.slug,
      code: d.agent.code,
      name: d.agent.name,
      avatar: d.agent.avatar,
      industry: d.agent.industry,
      industryGroup: d.agent.industryGroup ?? '工业制造',
      industries: [d.agent.industry],
      capabilityTags: d.agent.capabilityTags,
      monthlyPrice: d.agent.monthlyPrice,
      suggestedPrice: d.agent.suggestedPrice,
      tasksCompleted: d.agent.tasksCompleted,
      successRate: d.agent.successRate,
      avgRating: d.agent.avgRating,
      ratingCount: d.agent.ratingCount,
      experienceMonths: d.agent.experienceMonths,
      skillCount: d.agent.skillCount,
      memoryCount: d.agent.memoryCount,
      recommended: d.agent.recommended,
      certified: d.agent.certified,
      status: d.agent.status,
      listedAt: d.agent.listedAt ?? null,
      avatarConfig:
        d.agent.avatarConfig ?? { seed: d.agent.slug, palette: { primary: '#e8a33d', accent: '#7dd3c8' } },
      introText: d.agent.introText ?? null,
    },
    master: d.master
      ? {
          name: d.master.name,
          signature: d.master.signature,
          yearsExperience: d.master.yearsExperience,
          title: d.master.title,
          reputation: d.master.reputation,
        }
      : null,
    skills: d.skills,
    reviews: d.reviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      content: r.content,
      employerTitle: r.employerTitle,
      hireMonths: r.hireMonths,
      enterpriseName: r.enterpriseName,
      enterpriseIndustry: r.enterpriseIndustry,
      hireStatus: r.hireRecordId != null && currentHireIds.has(r.hireRecordId) ? 'current' : 'history',
    })),
    ratingDistribution: d.ratingDistribution,
    memories: d.memories,
    pricing: d.pricing,
  }
}

/* ---------------- offline fallback (from agent-detail.md design examples) ---------------- */

const FALLBACK_SKILLS = [
  { name: '振动频谱采集', type: 'V' as const, callCount: 1842, successRate: 99.1 },
  { name: 'FFT 频谱特征提取', type: 'U' as const, callCount: 1796, successRate: 98.7 },
  { name: '轴承故障特征识别', type: 'U' as const, callCount: 964, successRate: 97.4 },
  { name: '主轴动平衡评估', type: 'U' as const, callCount: 588, successRate: 96.9 },
  { name: '刀具磨损趋势预测', type: 'U' as const, callCount: 742, successRate: 95.8 },
  { name: '异常共振点定位', type: 'U' as const, callCount: 433, successRate: 97.2 },
  { name: '测点布置建议', type: 'V' as const, callCount: 312, successRate: 99.4 },
  { name: '历史工况对比分析', type: 'U' as const, callCount: 655, successRate: 98.3 },
  { name: '诊断报告自动生成', type: 'V' as const, callCount: 327, successRate: 99.8 },
]

const FALLBACK_MEMORIES = [
  {
    category: '设备特征',
    summary: '记住雇主 A 的 3 号 CNC 在 4200rpm 存在历史共振峰，后续任务自动规避误判。',
    date: '2025-01-12',
  },
  {
    category: '工艺参数',
    summary: '学会该厂区刀具供应商 B 的磨损曲线偏快特征，预测窗口自动提前 15%。',
    date: '2025-01-28',
  },
  { category: '环境补偿', summary: '积累冬季低温环境下传感器漂移补偿参数。', date: '2025-02-09' },
  {
    category: '雇主偏好',
    summary: '识别出雇主偏好"先给结论再给过程"的报告格式，自动调整输出结构。',
    date: '2025-03-02',
  },
]

const FALLBACK_REVIEWS = [
  {
    rating: 5,
    content: '振衡上岗第三周就提前 11 天预警了主轴轴承内圈剥落，避免了一次整线停机。',
    enterpriseName: '某汽车零部件厂',
    enterpriseIndustry: '汽车零部件',
    employerTitle: '设备总监',
    hireMonths: 6,
    hireStatus: 'current' as const,
  },
  {
    rating: 5,
    content: '报告很专业，刚开始不熟悉我们厂的老机床，一个月后比新入职的设备工程师还懂。',
    enterpriseName: '某精密机械厂',
    enterpriseIndustry: '装备制造',
    employerTitle: '厂长',
    hireMonths: 4,
    hireStatus: 'current' as const,
  },
  {
    rating: 4,
    content: '试用期的评估报告数据翔实，签约后响应速度一直在提升。',
    enterpriseName: '某航空配套厂',
    enterpriseIndustry: '航空配套',
    employerTitle: '工艺主管',
    hireMonths: 2,
    hireStatus: 'history' as const,
  },
]

/** deterministic pseudo-random 30-day price history ending at current price */
function synthHistory(current: number, seed: number) {
  const points: { date: string; price: number }[] = []
  let s = seed || 7
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
  const today = new Date()
  let price = current
  const backwards: number[] = [current]
  for (let i = 1; i < 30; i++) {
    price = Math.max(Math.round(current * 0.6), Math.round(price * (1 - (rand() - 0.52) * 0.04)))
    backwards.push(price)
  }
  backwards.reverse()
  for (let i = 0; i < 30; i++) {
    const d = new Date(today.getTime() - (29 - i) * 86400_000)
    points.push({ date: d.toISOString().slice(0, 10), price: backwards[i] ?? current })
  }
  return points
}

export function fallbackDetail(staticAgent: StaticAgent): DetailData {
  const history = synthHistory(staticAgent.price, staticAgent.code.length * 31)
  const first = history[0]?.price ?? staticAgent.price
  const changePct = Math.round(((staticAgent.price - first) / first) * 1000) / 10
  const suggested = Math.round(staticAgent.price * 0.94)
  const [masterName, masterRest] = staticAgent.master.split(' · ')
  return {
    agent: {
      numericId: null,
      slug: staticAgent.id,
      code: staticAgent.code,
      name: staticAgent.name,
      avatar: staticAgent.avatar,
      industry: staticAgent.industry,
      industryGroup: '工业制造',
      industries: [staticAgent.industry, '汽车零部件'],
      capabilityTags: [...staticAgent.tags, '刀具磨损评估', '动平衡校正建议'],
      monthlyPrice: staticAgent.price,
      suggestedPrice: suggested,
      tasksCompleted: staticAgent.tasks,
      successRate: 98.2,
      avgRating: staticAgent.rating,
      ratingCount: 48,
      experienceMonths: 14,
      skillCount: staticAgent.skills,
      memoryCount: 12408,
      recommended: staticAgent.id === 'zhenheng',
      certified: true,
      status: 'active',
      listedAt: null,
      avatarConfig: { seed: staticAgent.id, palette: { primary: '#e8a33d', accent: '#7dd3c8' } },
      introText: `你好！我是${staticAgent.name}，你的${staticAgent.industry}数字员工。我擅长${staticAgent.tags.slice(0, 3).join('、')}，已完成 ${staticAgent.tasks.toLocaleString('zh-CN')} 次任务。雇佣我之后，我会 7×24 小时在岗，把重复的工作都交给我！`,
    },
    master: {
      name: masterName ?? staticAgent.master,
      signature: staticAgent.master,
      yearsExperience: parseInt(masterRest ?? '30', 10) || 30,
      title: '某重工集团高级技师',
      reputation: 92,
    },
    skills: FALLBACK_SKILLS.map((s, i) => ({ id: `fb-${i}`, ...s })),
    reviews: FALLBACK_REVIEWS.map((r, i) => ({ id: `fb-${i}`, ...r })),
    ratingDistribution: [
      { star: 5, count: 42, pct: 88 },
      { star: 4, count: 4, pct: 9 },
      { star: 3, count: 2, pct: 3 },
      { star: 2, count: 0, pct: 0 },
      { star: 1, count: 0, pct: 0 },
    ],
    memories: FALLBACK_MEMORIES.map((m, i) => ({
      id: `fb-${i}`,
      category: m.category,
      summary: m.summary,
      createdAt: new Date(m.date),
    })),
    pricing: {
      history,
      changePct,
      suggestedPrice: suggested,
      masterAdjustment: staticAgent.price - suggested,
    },
  }
}
