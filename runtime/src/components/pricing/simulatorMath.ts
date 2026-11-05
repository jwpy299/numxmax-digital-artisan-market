/**
 * 本地降级定价引擎 —— 与 api/lib/pricing.ts 的 simulatePrice 完全同构。
 * 当 pricing.simulate tRPC 接口不可用时，定价模拟器退化为前端本地计算，
 * 保证相同滑块参数产出相同结果。
 */

export interface SimulatorInput {
  skillCount: number // 5-20
  complexity: number // 1-5
  reputation: number // 50-100
  demandRatio: number // 0.5-1.8，>1 供不应求
  rating: number // 3.0-5.0
  tasksCompleted: number // 0-500
}

export interface BreakdownItem {
  key: 'base' | 'skill' | 'reputation' | 'demand' | 'rating' | 'experience'
  label: string
  amount: number
}

export interface SimulatorResult {
  suggestedPrice: number
  breakdown: BreakdownItem[]
  trajectory: { month: number; price: number }[]
  rules: string[]
}

/** 与后端 createRng 一致的 LCG，保证轨迹曲线在降级时不变 */
function createRng(seed: number) {
  let state = seed >>> 0 || 1
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0xffffffff
  }
}

export function simulatePriceLocal(input: SimulatorInput): SimulatorResult {
  const base = 320 + input.complexity * 100
  const skillBonus = input.skillCount * 15
  const reputationBonus = Math.round(((input.reputation - 50) * 110) / 42)
  const subtotal = base + skillBonus + reputationBonus
  const demandAdj = Math.round(subtotal * (input.demandRatio - 1) * 0.785)
  const ratingAdj = Math.round((input.rating - 4.5) * 240)
  const experienceBonus = Math.round(Math.min(input.tasksCompleted, 500) * 0.196)
  const suggestedPrice = Math.max(300, subtotal + demandAdj + ratingAdj + experienceBonus)

  const monthlyDrift = Math.max(-0.2, Math.min(0.2, (input.demandRatio - 1) * 0.66))
  const rng = createRng(Math.round(suggestedPrice * 7 + input.demandRatio * 1000))
  const trajectory = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1
    const trend = Math.pow(1 + monthlyDrift, m) * Math.pow(1.005, m)
    const noise = 1 + (rng() - 0.5) * 0.03
    return { month: m, price: Math.round(suggestedPrice * trend * noise) }
  })

  return {
    suggestedPrice,
    breakdown: [
      { key: 'base', label: '基准价', amount: base },
      { key: 'skill', label: '技能加成', amount: skillBonus },
      { key: 'reputation', label: '声望加成', amount: reputationBonus },
      { key: 'demand', label: '供需浮动', amount: demandAdj },
      { key: 'rating', label: '评分溢价', amount: ratingAdj },
      { key: 'experience', label: '经验增值', amount: experienceBonus },
    ],
    trajectory,
    rules: [
      '初始定价：参考技能数量、复杂度、老师傅声望与同类 Agent 参考价，平台给出建议价，老师傅可自主微调',
      '供需调价：供不应求自动上浮（每月上限 +20%），供过于求自动下调（每月下限 -20%）',
      '评分联动：高评分 Agent 获得溢价空间；连续 3 个月评分低于 3 星自动下架整改',
      '经验增值：累计任务与工作记忆沉淀为经验值，经验越高价格越高，经验永不贬值',
      `当前供需比 ${input.demandRatio.toFixed(2)}：${
        input.demandRatio > 1.05
          ? '供不应求，价格处于上浮通道'
          : input.demandRatio < 0.95
            ? '供过于求，价格处于下调通道'
            : '供需基本平衡，价格保持稳定'
      }`,
    ],
  }
}
