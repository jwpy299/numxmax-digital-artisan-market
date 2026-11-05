/** recommendAdvisor —— 导购顾问逻辑契约件（③A 收官刀·双仓同轨面：wb/portal 同引本件=导购逻辑单源不双写[SYNC_LOCK 钉]）。
 *  纯件面：无 fetch/env/db 依赖（调用壳在各自仓——厚逻辑在本件）；
 *  清单白名单=PKG_CATALOG 同引（幻觉键拒单源）。 */
import { PKG_CATALOG, type PkgDeptKey } from "./pkgCatalog"; // PkgDeptKey 字面联合随引（P-ADVISOR-TYPE：DEPT_KEYWORDS 裸数组面收口）

/** 推荐校验纯函数（wb#97 high②——幻觉键拒/重复键去重/超 3 截/空面=null） */
export function pickRecommendations(ans: { pkgKey: string; reason: string }[] | null): { pkgKey: string; reason: string }[] | null {
  if (!ans?.length) return null;
  const seen = new Set<string>();
  const out: { pkgKey: string; reason: string }[] = [];
  for (const a of ans) {
    const k = String(a.pkgKey ?? "").trim().slice(0, 40);
    if (!PKG_CATALOG.some((p) => p.key === k)) continue; // 幻觉键拒（清单外自造=丢）
    if (seen.has(k)) continue; // 重复键去重
    seen.add(k);
    out.push({ pkgKey: k, reason: String(a.reason ?? "").slice(0, 80) || "导购顾问匹配" });
    if (out.length >= 3) break;
  }
  return out.length ? out : null; // 全幻觉=null=兜底面接
}

/** 兜底关键词部门映射（运行时故障=不空面——13 部门高频词精简面；双仓同引=兜底逻辑不双写） */
export const DEPT_KEYWORDS: [PkgDeptKey, string[]][] = [ // 键字面联合钉（裸 string 面收口——13 部门键外自造键=编译期红[P-ADVISOR-TYPE]）
  ["finance", ["报销", "报税", "账", "成本", "发票", "财务", "税"]],
  ["sales", ["销售", "客户", "线索", "签单", "成交", "拓客"]],
  ["hr", ["招聘", "入职", "考勤", "绩效", "简历", "面试", "人力"]],
  ["cs", ["客服", "售后", "咨询", "投诉", "答疑"]],
  ["marketing", ["营销", "推广", "品牌", "内容", "文案", "获客"]],
  ["production", ["生产", "工单", "排产", "产能", "车间"]],
  ["legal", ["合同", "法务", "合规", "诉讼", "协议"]],
  ["it", ["系统", "运维", "技术", "软件", "数据迁移"]],
  ["warehouse", ["库存", "仓储", "出入库", "盘点"]],
  ["quality", ["质检", "质量", "品控", "验收"]],
  ["research", ["研发", "研究", "调研", "专利"]],
  ["procurement", ["采购", "供应商", "比价", "招标"]],
  ["admin", ["行政", "审批", "流程", "会议", "证照"]],
];

export function fallbackRecommend(need: string) {
  const hitDepts = DEPT_KEYWORDS.filter(([, words]) => words.some((w) => need.includes(w))).map(([dk]) => dk);
  const pool = hitDepts.length
    ? PKG_CATALOG.filter((p) => p.deptCode && hitDepts.includes(p.deptCode))
    : PKG_CATALOG.filter((p) => p.packageTier === "synergy" || p.packageTier === "global"); // 零命中=协同/全域兜
  return pool.sort((a, b) => a.sortOrder - b.sortOrder).slice(0, 3);
}

/** 推荐项透出（种子件取真面） */
export function toRecommendItem(v: { pkgKey: string; reason: string }) {
  const p = PKG_CATALOG.find((x) => x.key === v.pkgKey); // find! 非空断言摘除（P-ADVISOR-TYPE：清单外键= null 兜底不炸——调用方面 filter 面）
  if (!p) return null;
  return { pkgKey: p.key, name: p.name, deptKey: p.deptCode ?? null, priceYuan: p.priceYuan, periodLabel: p.periodLabel, agentsCount: p.agentsCount, reason: v.reason };
}

/** 导购顾问任务文本构建（调用壳同引——任务构造不双写） */
export function buildAdvisorTask(need: string, catalogLite: string): string {
  return `你是 NumX Max 数字员工超市的导购顾问。客户说了他的需求痛点，请你从下方订阅包清单里挑 1-3 个最能解他痛点的包（只能挑清单里的 key——清单外自造=无效）。\n\n【本次任务】\n客户痛点：${need.slice(0, 500)}\n\n订阅包清单（key｜名称｜部门｜价格｜能力头）：\n${catalogLite}\n\n严格只输出 JSON 数组：[{"pkgKey":"清单里的key","reason":"一句人话理由≤60字"}]`;
}

/** 清单精简面（注入导购工位的清单文本——双仓同引同构） */
export function catalogLiteText(): string {
  return PKG_CATALOG.map((p) => `${p.key}｜${p.name}｜${p.deptCode ?? "全域"}｜¥${p.priceYuan}/${p.periodLabel}｜${p.features.slice(0, 3).join("、")}`).join("\n");
}
