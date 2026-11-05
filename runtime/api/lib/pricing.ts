import { createRng } from "./random";

// ─── 定价引擎 ────────────────────────────────────────────────────────────────
// 初始定价 = f(技能数, 复杂度, 老师傅声望, 供需比, 评分, 经验)
// 默认滑块参数（12技能/3复杂度/92声望/1.3供需/4.9评分/327任务）→ 1,284 Token，
// 瀑布构成：基准 620 + 技能 180 + 声望 110 + 供需 +214 + 评分 +96 + 经验 +64。

export interface PricingInput {
  skillCount: number; // 5-20
  complexity: number; // 1-5
  reputation: number; // 50-100
  demandRatio: number; // 0.5-1.8，>1 供不应求
  rating: number; // 3.0-5.0
  tasksCompleted: number; // 0-500（累计任务/经验）
}

export interface PriceBreakdownItem {
  key: "base" | "skill" | "reputation" | "demand" | "rating" | "experience";
  label: string;
  amount: number;
}

export interface PricingResult {
  suggestedPrice: number;
  breakdown: PriceBreakdownItem[];
  trajectory: { month: number; price: number }[]; // 12 个月预测
  rules: string[];
}

export function simulatePrice(input: PricingInput): PricingResult {
  const base = 320 + input.complexity * 100;
  const skillBonus = input.skillCount * 15;
  const reputationBonus = Math.round(((input.reputation - 50) * 110) / 42);
  const subtotal = base + skillBonus + reputationBonus;
  const demandAdj = Math.round(subtotal * (input.demandRatio - 1) * 0.785);
  const ratingAdj = Math.round((input.rating - 4.5) * 240);
  const experienceBonus = Math.round(Math.min(input.tasksCompleted, 500) * 0.196);
  const suggestedPrice = Math.max(
    300,
    subtotal + demandAdj + ratingAdj + experienceBonus,
  );

  // 12 个月价格轨迹：供需每月漂移（±20% 封顶）+ 经验增值 0.5%/月 + 确定性噪声
  const monthlyDrift = Math.max(-0.2, Math.min(0.2, (input.demandRatio - 1) * 0.66));
  const rng = createRng(
    Math.round(suggestedPrice * 7 + input.demandRatio * 1000),
  );
  const trajectory = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const trend = Math.pow(1 + monthlyDrift, m) * Math.pow(1.005, m);
    const noise = 1 + (rng.next() - 0.5) * 0.03;
    return { month: m, price: Math.round(suggestedPrice * trend * noise) };
  });

  return {
    suggestedPrice,
    breakdown: [
      { key: "base", label: "基准价", amount: base },
      { key: "skill", label: "技能加成", amount: skillBonus },
      { key: "reputation", label: "声望加成", amount: reputationBonus },
      { key: "demand", label: "供需浮动", amount: demandAdj },
      { key: "rating", label: "评分溢价", amount: ratingAdj },
      { key: "experience", label: "经验增值", amount: experienceBonus },
    ],
    trajectory,
    rules: [
      "初始定价：参考技能数量、复杂度、老师傅声望与同类 Agent 参考价，平台给出建议价，老师傅可自主微调",
      "供需调价：供不应求自动上浮（每月上限 +20%），供过于求自动下调（每月下限 -20%）",
      "评分联动：高评分 Agent 获得溢价空间；连续 3 个月评分低于 3 星自动下架整改",
      "经验增值：累计任务与工作记忆沉淀为经验值，经验越高价格越高，经验永不贬值",
      `当前供需比 ${input.demandRatio.toFixed(2)}：${
        input.demandRatio > 1.05
          ? "供不应求，价格处于上浮通道"
          : input.demandRatio < 0.95
            ? "供过于求，价格处于下调通道"
            : "供需基本平衡，价格保持稳定"
      }`,
    ],
  };
}

export interface PriceHistoryPoint {
  date: string; // YYYY-MM-DD
  price: number;
}

/** Agent 近 30 天价格曲线：以当前月薪为锚点，确定性随机游走（同一 agent+price 输出恒定） */
export function priceHistory(
  agentId: number,
  currentPrice: number,
  days = 30,
): PriceHistoryPoint[] {
  const rng = createRng(agentId * 7919 + currentPrice);
  // 向前游走：起点略低，末端锚定当前价
  const start = Math.round(currentPrice * (0.9 + rng.next() * 0.04));
  const prices: number[] = [start];
  for (let i = 1; i < days; i++) {
    const drift = 1 + (rng.next() - 0.42) * 0.024; // 微上行趋势
    prices.push(Math.round(prices[i - 1] * drift));
  }
  // 末端缩放到精确等于当前价，保持整条曲线形状
  const scale = currentPrice / prices[days - 1];
  const today = new Date();
  return prices.map((p, i) => {
    const d = new Date(today.getTime() - (days - 1 - i) * 86400_000);
    return {
      date: d.toISOString().slice(0, 10),
      price: i === days - 1 ? currentPrice : Math.round(p * scale),
    };
  });
}
