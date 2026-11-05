/**
 * deptMap —— 员工→部门键归因映射单源（战区② 2.2——彭总策略：单员工只做展示，雇佣租用以部门级订阅包主调；
 * 匠市面「雇佣」钮改「按部门订阅」跳部门包页带员工所属部门归因）。
 * 映射口径：按员工行业组+能力标签→职能部门键（对齐 deptConsole.ts DEPT_CODES 单源：
 * ops 运营/brand 品牌/marketing 市场/tech 技术/finance 财务/legal 法务）。
 * 不中是=null（无归因不硬归——部门包页全量展示面兜底）。
 */

/** 职能部门键（契约层单源直引——wb#79 复审票：手抄复刻漂移面封死） */
import { DEPT_CODES, type DeptCode } from "./deptCodes";
export { DEPT_CODES, type DeptCode };

/** 关键词→部门键映射表（职能词面——财税/法务/市场/技术/运营/品牌） */
const DEPT_KEYWORDS: Array<{ dept: DeptCode; words: string[] }> = [
  { dept: "finance", words: ["财税", "财务", "汇算", "资金", "账", "税", "核算", "财报", "成本"] },
  { dept: "legal", words: ["法务", "法律", "合规", "审计", "内控", "合同", "风险排查"] },
  { dept: "marketing", words: ["市场", "营销", "投放", "文案", "种草", "获客", "推广"] },
  { dept: "brand", words: ["品牌", "舆情", "公关", "口碑", "传播"] },
  { dept: "tech", words: ["技术", "研发", "编程", "开发", "软件", "数据", "算法"] },
  { dept: "ops", words: ["运营", "经营", "运维", "供应链", "物流", "生产", "总经理"] },
];

/** 员工→部门键归因（行业组+能力标签双轴打分——命中词最多的部门胜出；同分/零中=null 不硬归） */
export function deptCodeOfAgent(industry: string | null | undefined, capabilityTags: string[] | null | undefined): DeptCode | null {
  const text = `${industry ?? ""} ${(capabilityTags ?? []).join(" ")}`;
  if (!text.trim()) return null;
  let best: DeptCode | null = null;
  let bestHits = 0;
  let tie = false; // 同分标记（宣称=实现钉：JSDoc 说同分=null 不硬归——实现面同分=null）
  for (const d of DEPT_KEYWORDS) {
    const hits = d.words.filter((w) => text.includes(w)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = d.dept;
      tie = false;
    } else if (hits === bestHits && hits > 0) {
      tie = true; // 同分=标记（不改 best——最后判）
    }
  }
  if (bestHits === 0 || tie) return null; // 零中/同分=null（不硬归——部门包页全量展示面兜底）
  return best;
}
