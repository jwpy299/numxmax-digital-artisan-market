/**
 * agentReview —— M32 数字员工考核列编（Harness 运行装配线 P0-④）。
 *
 * 呼应闭环的最后一环：Agent 越进化，考核数据越厚，系统授权越精准。
 * 全部指标只取真实台账，绝不估算/编造：
 * - 活跃任务量：st_chat_threads(agentCode) × st_chat_messages(role='user') 近 90 天；
 * - 产出物数：st_agent_artifacts(agentCode) 近 90 天；
 * - 采纳率：st_artifact_feedback(adopted/rejected) 经 artifact 关联到 agentCode，
 *   样本 <3 条标注「观察中」，绝不硬算；
 * - 评级（公式面板公示）：A=采纳率≥70%且产出≥5；B=采纳率≥50%或产出≥3；C=其余；
 *   反馈样本<3 → 观察中；
 * - 末位预警：反馈样本≥3 且采纳率<40% → warn（连续低采纳自动降权的信号源）。
 *
 * 安全：requireAdminToken 守门；只读聚合；原始指令内容绝不返回。
 *
 * ── P2-4 追加（同一文件、同一域、不同生命周期，2026-10-04）─────────────────
 * 本文件同时承载 **P2-4（台账 W3）待审员工审核流水线**（`agentReviewQueueRouter`，
 * 注册为 api.agentReviewQueue）。两者共用「数字员工」这一域：
 *   · agentReview.board        在役（active）员工的**事后**考核列编（M32）
 *   · agentReviewQueue.*       待审（pending）员工的**事前**审核流水线（P2-4）
 * 之所以不新建独立文件：`api/routers/agentReview.ts` 是方案指定的落点，而其中
 * `agentReviewRouter`（M32）已被 api/router.ts 与 api/agentReview.test.ts 引用，
 * 覆盖会破坏既有约定 —— 按「不另立范式」原则，同域同文件、导出两个 router。
 */
import { z } from "zod";
import { createRouter, publicQuery } from "../middleware";
import { requireAdmin as requireAdminToken, rawRows } from "./terminal";
import { getDb } from "../queries/connection";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { requireAdmin } from "./admin";
import { writeAdminAudit, adminDisplayName } from "./adminAnalytics";

export interface AgentReviewRow {
  agentCode: string;
  name: string;
  title: string;
  deptCode: string;
  tasks90d: number;
  artifacts90d: number;
  adopted: number;
  rejected: number;
  adoptionRate: number | null; // null=样本不足
  grade: "A" | "B" | "C" | "观察中";
  warn: boolean;
}

/** 评级公式（面板公示；样本不足一律观察中） */
export function gradeOf(a: { adoptionRate: number | null; artifacts90d: number; fbSamples: number }): "A" | "B" | "C" | "观察中" {
  if (a.fbSamples < 3) return "观察中";
  const rate = a.adoptionRate ?? 0;
  if (rate >= 0.7 && a.artifacts90d >= 5) return "A";
  if (rate >= 0.5 || a.artifacts90d >= 3) return "B";
  return "C";
}

export const agentReviewRouter = createRouter({
  /** board（query，管理员 token）：数字员工考核列编（近 90 天真实台账聚合）。 */
  board: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      await requireAdminToken(input.token);
      const db = getDb();

      const agents = rawRows(
        await db.execute(
          sql`SELECT code, name, title, deptCode FROM st_agents WHERE status = 'active' ORDER BY deptCode ASC, id ASC`,
        ),
      );

      const tasks = rawRows(
        await db.execute(
          sql`SELECT t.agentCode AS agentCode, COUNT(m.id) AS cnt
              FROM st_chat_threads t JOIN st_chat_messages m ON m.threadId = t.id AND m.role = 'user'
              WHERE m.createdAt > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 DAY)
              GROUP BY t.agentCode`,
        ),
      );
      const taskMap = new Map(tasks.map((r) => [String(r.agentCode), Number(r.cnt)]));

      const artifacts = rawRows(
        await db.execute(
          sql`SELECT agentCode, COUNT(*) AS cnt FROM st_agent_artifacts
              WHERE createdAt > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 DAY)
              GROUP BY agentCode`,
        ),
      );
      const artifactMap = new Map(artifacts.map((r) => [String(r.agentCode), Number(r.cnt)]));

      const fb = rawRows(
        await db.execute(
          sql`SELECT a.agentCode AS agentCode,
                     SUM(f.fb_signal = 'adopted') AS adopted,
                     SUM(f.fb_signal = 'rejected') AS rejected
              FROM st_artifact_feedback f JOIN st_agent_artifacts a ON a.id = f.artifact_id
              GROUP BY a.agentCode`,
        ),
      );
      const fbMap = new Map(
        fb.map((r) => [String(r.agentCode), { adopted: Number(r.adopted ?? 0), rejected: Number(r.rejected ?? 0) }]),
      );

      const rows: AgentReviewRow[] = agents.map((a) => {
        const code = String(a.code);
        const f = fbMap.get(code) ?? { adopted: 0, rejected: 0 };
        const fbSamples = f.adopted + f.rejected;
        const adoptionRate = fbSamples > 0 ? f.adopted / fbSamples : null;
        const artifacts90d = artifactMap.get(code) ?? 0;
        const grade = gradeOf({ adoptionRate, artifacts90d, fbSamples });
        const warn = fbSamples >= 3 && (adoptionRate ?? 1) < 0.4;
        return {
          agentCode: code,
          name: String(a.name),
          title: String(a.title),
          deptCode: String(a.deptCode),
          tasks90d: taskMap.get(code) ?? 0,
          artifacts90d,
          adopted: f.adopted,
          rejected: f.rejected,
          adoptionRate,
          grade,
          warn,
        };
      });

      return {
        window: "90d",
        formula: "A=采纳率≥70%且产出≥5；B=采纳率≥50%或产出≥3；C=其余；反馈样本<3→观察中；样本≥3且采纳率<40%→末位预警",
        agents: rows,
      };
    }),
});

// ═══════════════════════════════════════════════════════════════════════════
// P2-4（台账 W3 / PPT W3）数字员工审核流水线 —— agentReviewQueueRouter
// ═══════════════════════════════════════════════════════════════════════════
//
// 缺口定位（实测）：`agents.status = enum('pending','active','suspended','rejected')` 有状态机，
// 但**无操作入口、无留痕** —— 77 条 pending 与 47 条 active 数据完整度完全一致
// （masterId/monthlyPrice/intro_text/skillCount 零缺失），是**成形记录卡在状态迁移上**，
// 属「只进不出」的死状态。本 router 交付**能力**：队列可见、逐条可判、全程留痕。
//
// ⚠️ 边界（方案第四节）：本 router **不批量改存量 77 条状态** —— 实际审核是 Owner 的动作。
//
// ── 端点（按 devListings「开发者上架审核」既有约定：status 迁移 + requireAdmin + 留痕）──
// - list         pending 队列（分页 + 搜索），每条带 AI 初审判定与可解释分项
// - approve      pending → active，写 reviewedAt/reviewedBy，落 st_admin_audit
// - reject       pending → rejected，**rejectReason 必填（服务端强制）**，写三件套 + 审计
// - bulkApprove  批量通过 —— HIGH 档自动通过档专用；**默认关**（见 autoApproveHighEnabled）
// - stats        队列口径（决策台第 5 组「待审员工」角标数据源）
//
// ── AI 初审 + 双阈值分流（方案 2.3）─────────────────────────────────────────
//   score >= HIGH_T          → 自动通过档（可批量；但受 AGENT_REVIEW_AUTO_APPROVE_HIGH 开关闸）
//   LOW_T <= score < HIGH_T  → 人工复核档（默认，逐条看）
//   score < LOW_T            → 自动拦截档（标记待拒，**仍需人确认**，绝不自动改状态）
//
// 初审五维（可解释、非黑盒，逐维返回分数 + 判据文本）：数据完整度 / 简介质量 /
// 技能与行业大类匹配 / 定价合理性 / 师承（masterId）有效性。
//
// ── 与既有 callModelChat / modelGateway 的关系（诚实说明）───────────────────
// 五维初审是**确定性规则算法**（同输入同输出、可复盘、可写进审计）。
// 既有 `callModelChat` 的语义是「失败即降级/静默」（modelGateway.ts:1055 起，
// 全链故障转移后返回 { ok:false }），把审核分建在它上面会让**同一份数据每次算出不同的分**，
// 无法作为留痕证据，也无法向 Owner 解释「为什么这条被判高分」。
// 故本版不接 LLM：**不新增依赖、不新增模型调用点**（符合方案「不新增依赖」边界）。
// HIGH 档若要开自动通过，应先人工抽检 10 条校准（方案原话），而不是先接模型。

/** HIGH 档自动通过开关 —— **默认关**（方案原话：先人工抽检 10 个校准，再把 HIGH 档打开） */
export function autoApproveHighEnabled(): boolean {
  return process.env.AGENT_REVIEW_AUTO_APPROVE_HIGH === "1";
}

/**
 * 双阈值（env 可覆盖，便于抽检校准不改代码）。
 *
 * 取值依据（实测标定，非拍脑袋）——见施工回报第 5 节：
 * - 77 条 pending 实数跑分区间 **[37, 72]**（各维实测分布：D1 全 100；D2 80/90；
 *   D3 0/40/70/100；D4 25/40/50/80/100；D5 全 60）；
 * - HIGH_T=88 落在实测上界 72 之上 → **自动通过档当前为空**。这正是「首次上线不做全自动」
 *   想要的形状：数据本身够不到自动线，而不是被开关挡出来的假空；
 * - LOW_T=60 取实测分布的断层处（60 分及以上 18 条、以下 59 条），
 *   人工复核档只留「五维里至少两维拿满」的记录。
 * - ⚠️ 本组阈值建立在一个**均匀数据集**上（D1/D5 实测零方差），校准样本不足；
 *   抽检 10 条后应复核（见 agentReviewQueue.stats 的 thresholds.basisNote）。
 */
export const DEFAULT_HIGH_T = 88;
export const DEFAULT_LOW_T = 60;

export function highThreshold(): number {
  const v = Number(process.env.AGENT_REVIEW_HIGH_T);
  return Number.isFinite(v) && v > 0 && v <= 100 ? v : DEFAULT_HIGH_T;
}

export function lowThreshold(): number {
  const v = Number(process.env.AGENT_REVIEW_LOW_T);
  return Number.isFinite(v) && v >= 0 && v < 100 ? v : DEFAULT_LOW_T;
}

/** 单次批量上限（防一次性批完 77 条；与 devListings 队列页 LIMIT 同量级） */
const BULK_LIMIT = 50;

/**
 * 师承占位记录特征：`masters.name = '传承建档中'`（台账 W4「masters 师承重录中」的实测形态）。
 * 命中即说明师承链**尚未建真**，但不因此判无效召回 —— 只扣分并如实标注。
 */
const LINEAGE_PLACEHOLDER_RE = /建档|待录|占位|待补|TODO|placeholder/i;

/** 师承链未建真时的扣分（0-100 分制；D5 本身给 60 分，故 d5 净贡献 = 10*0.6 − 12 = −6） */
export const LINEAGE_PLACEHOLDER_PENALTY = 12;

/** 五维权重（合计 1.00；简介/技能匹配权重最高 —— 这两维才是「上架前能判且与货架质量相关」的） */
export const DIMENSION_WEIGHTS = {
  completeness: 0.2, // 数据完整度
  intro: 0.22, // 简介质量
  tagFit: 0.26, // 技能与行业大类匹配
  pricing: 0.22, // 定价合理性
  lineage: 0.1, // 师承有效性
} as const;

export type ReviewTier = "high" | "mid" | "low";

export interface DimensionScore {
  key: "completeness" | "intro" | "tagFit" | "pricing" | "lineage";
  label: string;
  weight: number; // 0-1
  score: number; // 0-100
  /** 人话判据（进审计留痕，审核人看得懂为什么是这个分） */
  basis: string;
}

/** 参与初审的 agent 字段（list 查询投影；不用 any，字段显式声明） */
export interface ReviewCandidate {
  id: number;
  code: string;
  name: string;
  industry: string;
  industryGroup: string;
  introText: string;
  masterId: number;
  monthlyPrice: number;
  suggestedPrice: number;
  capabilityTags: string[];
  skillCount: number;
  listedAt: Date | null;
}

export interface ReviewScore {
  score: number; // 0-100（各维加权和 − 师承占位扣分，截断到 [0,100]）
  tier: ReviewTier;
  dimensions: DimensionScore[];
  flags: string[]; // 需人工注意项（占位师承/简介过短/标签与大类零匹配…）
  missing: string[]; // D1 缺失字段名
}

/**
 * 行业大类 → 关键词表（D3 判据源）。
 * 只收「该大类必含的业务词」，不用 LLM、不做语义相似度 —— 命中即计数，审核人可自行复核。
 * 未登记的大类 → D3 给 0 并在 basis 里如实说明「无关键词表」，不假装算过。
 */
export const GROUP_KEYWORDS: Record<string, string[]> = {
  工业制造: ["生产", "制造", "设备", "质检", "工艺", "产线", "cnc", "装配", "焊接", "模具", "仓储", "mes", "点检"],
  软件服务: ["api", "代码", "开发", "架构", "后端", "前端", "测试", "运维", "数据库", "算法", "部署", "技术方案", "重构"],
  法律合规: ["合同", "合规", "法务", "劳动", "风险", "诉讼", "审查", "知识产权", "条款", "监管", "证据"],
  财税服务: ["税", "账", "财务", "报表", "审计", "发票", "成本", "预算", "核算", "社保", "凭证"],
  跨境电商: ["跨境", "海外", "选品", "listing", "亚马逊", "物流", "清关", "汇率", "海外仓", "外贸", "申报"],
  教育培训: ["课程", "教学", "培训", "学习", "题库", "讲师", "考核", "教案", "知识点", "学员", "答疑"],
  医疗健康: ["诊断", "病历", "临床", "药", "健康", "医学", "护理", "问诊", "检验", "康复", "随访"],
  农业服务: ["病虫", "种植", "农事", "测土", "养殖", "作物", "用药", "田间", "农机", "收成", "施肥"],
  建筑工程: ["施工", "造价", "图纸", "工程", "验收", "结构", "监理", "招投标", "材料", "交底", "工期"],
  物流供应链: ["运输", "仓储", "配送", "库存", "调度", "承运", "运费", "干线", "仓配", "报关", "在途"],
  设计创意: ["设计", "视觉", "品牌", "创意", "排版", "插画", "ui", "配色", "文案", "动效", "logo"],
  通用经营: ["经营", "运营", "管理", "流程", "数据", "分析", "决策", "计划", "协同", "复盘", "指标"],
};

/** D1 数据完整度：8 个必填判据，按满足比例给分（缺一项 −12.5） */
const COMPLETENESS_CHECKS: { key: string; label: string }[] = [
  { key: "name", label: "名称" },
  { key: "industry", label: "行业" },
  { key: "industryGroup", label: "行业大类" },
  { key: "introText", label: "简介" },
  { key: "monthlyPrice", label: "月薪" },
  { key: "suggestedPrice", label: "建议价" },
  { key: "masterId", label: "师承" },
  { key: "capabilityTags", label: "能力标签" },
];

const hasText = (v: unknown): boolean => v != null && String(v).trim() !== "";
const hasPosNum = (v: unknown): boolean => Number.isFinite(Number(v)) && Number(v) > 0;

/** 定价锚点：同大类 active 存量中位月薪（大类样本不足时回落全站 active 中位，且分数减半） */
export interface PricingAnchor {
  group: string;
  median: number;
  sampleSize: number;
  /** true = 该大类无 active 存量，用了全站中位（置信度低，D4 得分 ×0.5） */
  scaled: boolean;
}

export interface ReviewContext {
  /** masters.id → name（D5 判据源；空 Map = masters 表不可用） */
  masterNames: Map<number, string>;
  /** 定价锚点（D4 判据源） */
  pricing: PricingAnchor;
}

export function scoreCompleteness(c: ReviewCandidate): { dim: DimensionScore; missing: string[] } {
  const okFlags: Record<string, boolean> = {
    name: hasText(c.name),
    industry: hasText(c.industry),
    industryGroup: hasText(c.industryGroup),
    introText: hasText(c.introText),
    monthlyPrice: hasPosNum(c.monthlyPrice),
    suggestedPrice: hasPosNum(c.suggestedPrice),
    masterId: hasPosNum(c.masterId),
    capabilityTags: Array.isArray(c.capabilityTags) && c.capabilityTags.length > 0,
  };
  const missing = COMPLETENESS_CHECKS.filter((x) => !okFlags[x.key]).map((x) => x.label);
  const score = Math.round(((COMPLETENESS_CHECKS.length - missing.length) / COMPLETENESS_CHECKS.length) * 100);
  return {
    dim: {
      key: "completeness",
      label: "数据完整度",
      weight: DIMENSION_WEIGHTS.completeness,
      score,
      basis:
        missing.length === 0
          ? `8/8 必填字段齐备（${COMPLETENESS_CHECKS.map((x) => x.label).join("·")}）`
          : `缺 ${missing.length}/8：${missing.join("·")}`,
    },
    missing,
  };
}

export function scoreIntro(c: ReviewCandidate): { dim: DimensionScore; flags: string[] } {
  const t = String(c.introText ?? "").trim();
  const len = [...t].length;
  // 长度分档：40-59 字 = 货架简介常见区间（实测 77 条均值 50 字，取 40 为及格线）
  let score = len >= 60 ? 100 : len >= 40 ? 70 : len >= 20 ? 40 : len > 0 ? 20 : 0;
  const punctuated = len > 0 && /[。！？.!?]$/.test(t);
  // 灌水检测只用「4 连同一字符」这种确凿形态（如「热热热热」「aaaa」）。
  // 不用 n-gram 重复：实测「合规体检 / 合规风险」里的「合规」是正常中文用词，
  // 用 2-gram 重复判灌水会把合法简介误判成瑕疵（本版施工中实测到的假阳性，已改正）。
  const padded = /(.)\1{3,}/.test(t);
  const spaced = /\s{2,}/.test(t);
  const clean = len > 0 && !spaced && !padded;
  if (punctuated) score += 10;
  if (clean) score += 10;
  else if (len > 0) score -= 10;
  score = Math.max(0, Math.min(100, score));
  const flags: string[] = [];
  if (len === 0) flags.push("简介缺失");
  else if (!punctuated) flags.push("简介缺结尾标点（疑模板截断）");
  if (padded) flags.push("简介含 4 连重复字符（疑灌水/占位）");
  if (spaced) flags.push("简介含连续空白（疑拼接残留）");
  if (len > 0 && len < 40) flags.push(`简介偏短（${len} 字）`);
  return {
    dim: {
      key: "intro",
      label: "简介质量",
      weight: DIMENSION_WEIGHTS.intro,
      score,
      basis: `${len} 字；${punctuated ? "结尾标点齐" : "缺结尾标点"}；${clean ? "无灌水/连空" : `有瑕疵（${[padded ? "4 连重复" : null, spaced ? "连续空白" : null].filter(Boolean).join("·")}）`}`,
    },
    flags,
  };
}

export function scoreTagFit(c: ReviewCandidate): { dim: DimensionScore; flags: string[] } {
  const tags = (Array.isArray(c.capabilityTags) ? c.capabilityTags : []).map((t) => String(t));
  const kws = GROUP_KEYWORDS[c.industryGroup];
  if (!kws) {
    return {
      dim: {
        key: "tagFit",
        label: "技能与行业大类匹配",
        weight: DIMENSION_WEIGHTS.tagFit,
        score: 0,
        basis: `大类「${c.industryGroup}」未建关键词表 → 不下判定（0 分，待人看）`,
      },
      flags: [`行业大类「${c.industryGroup}」无匹配关键词表`],
    };
  }
  const hits = new Set<string>();
  for (const tag of tags) {
    const low = tag.toLowerCase();
    for (const kw of kws) if (low.includes(kw)) hits.add(kw);
  }
  const n = hits.size;
  const score = n >= 3 ? 100 : n === 2 ? 70 : n === 1 ? 40 : 0;
  const flags: string[] = [];
  if (tags.length === 0) flags.push("能力标签为空");
  else if (n === 0) flags.push(`能力标签与该大类零匹配（${tags.length} 个标签无一命中）`);
  return {
    dim: {
      key: "tagFit",
      label: "技能与行业大类匹配",
      weight: DIMENSION_WEIGHTS.tagFit,
      score,
      basis: `${tags.length} 个标签命中 ${n} 个大类关键词（${[...hits].join("·") || "无"}）`,
    },
    flags,
  };
}

export function scorePricing(c: ReviewCandidate, anchor: PricingAnchor): { dim: DimensionScore; flags: string[] } {
  const price = Number(c.monthlyPrice);
  const ref = anchor.median;
  const dev = ref > 0 ? Math.abs(price - ref) / ref : 0;
  let score = dev <= 0.2 ? 100 : dev <= 0.4 ? 80 : dev <= 0.75 ? 50 : 20;
  const flags: string[] = [];
  const sp = Number(c.suggestedPrice);
  if (sp > 0 && price > sp * 1.5) {
    score -= 30;
    flags.push(`月薪 ${price} 高于建议价 ${sp} 的 1.5 倍`);
  }
  if (anchor.scaled) {
    score = Math.round(score * 0.5); // 无同类存量可比 → 置信度减半
    flags.push(`大类「${anchor.group}」无 active 存量，定价按全站中位比对（置信度减半）`);
  }
  score = Math.max(0, Math.min(100, score));
  const refText = anchor.scaled
    ? `全站 active 中位 ${ref}`
    : `同类「${anchor.group}」active 中位 ${ref}（n=${anchor.sampleSize}）`;
  return {
    dim: {
      key: "pricing",
      label: "定价合理性",
      weight: DIMENSION_WEIGHTS.pricing,
      score,
      basis: `月薪 ${price} vs ${refText}，偏离 ${(dev * 100).toFixed(1)}%`,
    },
    flags,
  };
}

export function scoreLineage(
  c: ReviewCandidate,
  masterNames: Map<number, string>,
): { dim: DimensionScore; flags: string[]; penalty: number } {
  const mid = Number(c.masterId);
  if (!Number.isFinite(mid) || mid <= 0) {
    return {
      dim: { key: "lineage", label: "师承有效性", weight: DIMENSION_WEIGHTS.lineage, score: 0, basis: "师承字段缺失" },
      flags: ["师承缺失"],
      penalty: 0,
    };
  }
  const nm = masterNames.get(mid);
  if (nm === undefined) {
    return {
      dim: {
        key: "lineage",
        label: "师承有效性",
        weight: DIMENSION_WEIGHTS.lineage,
        score: 0,
        basis: `师承 ${mid} 在 masters 表查无记录（悬空引用）`,
      },
      flags: [`师承 ${mid} 悬空`],
      penalty: 0,
    };
  }
  if (LINEAGE_PLACEHOLDER_RE.test(nm)) {
    return {
      dim: {
        key: "lineage",
        label: "师承有效性",
        weight: DIMENSION_WEIGHTS.lineage,
        score: 60,
        basis: `师承 ${mid}「${nm}」为占位记录（台账 W4 师承重录中），非真师承`,
      },
      flags: [`师承 ${mid}「${nm}」为占位记录，待 W4 师承重录`],
      penalty: LINEAGE_PLACEHOLDER_PENALTY,
    };
  }
  return {
    dim: {
      key: "lineage",
      label: "师承有效性",
      weight: DIMENSION_WEIGHTS.lineage,
      score: 100,
      basis: `师承 ${mid}「${nm}」有效`,
    },
    flags: [],
    penalty: 0,
  };
}

/** 初审总分 + 三档判定（纯函数：同输入同输出，可写进审计复盘） */
export function scoreCandidate(c: ReviewCandidate, ctx: ReviewContext): ReviewScore {
  const d1 = scoreCompleteness(c);
  const d2 = scoreIntro(c);
  const d3 = scoreTagFit(c);
  const d4 = scorePricing(c, ctx.pricing);
  const d5 = scoreLineage(c, ctx.masterNames);
  const dims = [d1.dim, d2.dim, d3.dim, d4.dim, d5.dim];
  const raw = dims.reduce((sum, d) => sum + (d.weight * d.score) / 100, 0) * 100;
  const score = Math.max(0, Math.min(100, Math.round(raw - d5.penalty)));
  return {
    score,
    tier: tierOf(score),
    dimensions: dims,
    flags: [...d2.flags, ...d3.flags, ...d4.flags, ...d5.flags],
    missing: d1.missing,
  };
}

export function tierOf(score: number): ReviewTier {
  if (score >= highThreshold()) return "high";
  if (score >= lowThreshold()) return "mid";
  return "low";
}

/**
 * 分流汇总（供 stats / 决策台角标）：三档计数 + 阈值 + **HIGH 档是否真会自动跑**。
 * autoApproveEnabled 由服务端显式给出 —— 前端不得自行推断开关状态。
 */
export function summarizeTiers(scores: number[]): {
  high: number;
  mid: number;
  low: number;
  highT: number;
  lowT: number;
  autoApproveEnabled: boolean;
} {
  let high = 0;
  let mid = 0;
  let low = 0;
  for (const s of scores) {
    const t = tierOf(s);
    if (t === "high") high++;
    else if (t === "mid") mid++;
    else low++;
  }
  return { high, mid, low, highT: highThreshold(), lowT: lowThreshold(), autoApproveEnabled: autoApproveHighEnabled() };
}

// ─── DB 读取 ─────────────────────────────────────────────────────────────────

/** 审核留痕列是否存在（C 级双签面未签时列缺席 → 写回自动降级，不 500） */
async function hasReviewColumns(): Promise<boolean> {
  try {
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT COLUMN_NAME FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agents'
              AND COLUMN_NAME IN ('reviewedAt','reviewedBy','rejectReason')`,
      ),
    );
    return rows.length >= 3;
  } catch {
    return false; // 探测失败按未就位处理（宁可少写留痕，不可报错阻塞审核）
  }
}

function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const s = String(v);
  const d = new Date(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") {
    try {
      const parsed: unknown = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

const CANDIDATE_SELECT = sql`SELECT id, code, name, industry, industryGroup, masterId,
       monthlyPrice, suggestedPrice, skillCount, intro_text AS introText, capabilityTags, listedAt
  FROM agents WHERE status = 'pending'`;

function mapCandidate(r: Record<string, unknown>): ReviewCandidate {
  return {
    id: Number(r.id),
    code: String(r.code ?? ""),
    name: String(r.name ?? ""),
    industry: String(r.industry ?? ""),
    industryGroup: String(r.industryGroup ?? ""),
    introText: r.introText == null ? "" : String(r.introText),
    masterId: Number(r.masterId ?? 0),
    monthlyPrice: Number(r.monthlyPrice ?? 0),
    suggestedPrice: Number(r.suggestedPrice ?? 0),
    capabilityTags: toStrArray(r.capabilityTags),
    skillCount: Number(r.skillCount ?? 0),
    listedAt: toDate(r.listedAt),
  };
}

/** masters 可用性：{ id: name }（真师承判断的唯一数据源） */
async function loadMasterNames(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const rows = rawRows(await getDb().execute(sql`SELECT id, name FROM masters`));
    for (const r of rows) map.set(Number(r.id), String(r.name ?? ""));
  } catch {
    // masters 未建 → 空 Map，D5 一律按悬空处理（如实反映，不假装有效）
  }
  return map;
}

/**
 * 定价锚点：同大类 active 存量中位月薪；该大类无存量 → 全站 active 中位（scaled=true）。
 * 中位取法：ORDER BY monthlyPrice 后取中间位（偶数取偏小者），与标定实验口径一致。
 */
async function loadPricingAnchor(group: string): Promise<PricingAnchor> {
  try {
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT monthlyPrice FROM agents WHERE status = 'active' AND industryGroup = ${group} ORDER BY monthlyPrice`,
      ),
    );
    const prices = rows.map((r) => Number(r.monthlyPrice)).filter((n) => Number.isFinite(n) && n > 0);
    if (prices.length > 0) {
      return { group, median: prices[Math.floor((prices.length - 1) / 2)], sampleSize: prices.length, scaled: false };
    }
    const all = rawRows(
      await getDb().execute(sql`SELECT monthlyPrice FROM agents WHERE status = 'active' ORDER BY monthlyPrice`),
    );
    const allPrices = all.map((r) => Number(r.monthlyPrice)).filter((n) => Number.isFinite(n) && n > 0);
    const median = allPrices.length > 0 ? allPrices[Math.floor((allPrices.length - 1) / 2)] : 0;
    return { group, median, sampleSize: 0, scaled: true };
  } catch {
    return { group, median: 0, sampleSize: 0, scaled: true };
  }
}

/** 待审队列全量候选 + 初审分（list / stats / bulkApprove 共用单点） */
async function loadScoredQueue(): Promise<{
  candidates: ReviewCandidate[];
  scores: ReviewScore[];
  masterCount: number;
}> {
  const [candRows, masterNames] = await Promise.all([getDb().execute(CANDIDATE_SELECT), loadMasterNames()]);
  const candidates = rawRows(candRows).map(mapCandidate);
  const anchorCache = new Map<string, PricingAnchor>(); // 同一大类只查一次
  const scores: ReviewScore[] = [];
  for (const c of candidates) {
    let anchor = anchorCache.get(c.industryGroup);
    if (!anchor) {
      anchor = await loadPricingAnchor(c.industryGroup);
      anchorCache.set(c.industryGroup, anchor);
    }
    scores.push(scoreCandidate(c, { masterNames, pricing: anchor }));
  }
  return { candidates, scores, masterCount: masterNames.size };
}

// ─── 写回 ────────────────────────────────────────────────────────────────────

// 门禁 PR#35 票（maintainability/low）：`AdminActor.username` 原在 actorOf 里被填充，
//   但**全模块无人读取**（migrate/writeAdminAudit 只用 id 与 displayName）—— 死字段。
//   已删除。**未顺手改成「写 username 留痕」**：那会改变审计记录内容（行为变更），
//   不属「删死代码」范围；若日后要改留痕口径，应作为独立变更走门禁。
//   现状留痕：`reviewedBy = String(actor.id)`（与 agents 表列注释「admin id 或 username」的 id 口径一致）。
interface AdminActor {
  id: number;
  displayName: string;
}

function actorOf(admin: { id: unknown; displayName?: unknown }): AdminActor {
  return {
    id: Number(admin.id),
    displayName: adminDisplayName(admin as never),
  };
}

/** drizzle mysql2 execute 的 affectedRows 提取（返回 [ResultSetHeader, fields]） */
function affectedOf(result: unknown): number {
  if (Array.isArray(result) && result[0] && typeof result[0] === "object") {
    const h = result[0] as { affectedRows?: unknown };
    if (h.affectedRows !== undefined) return Number(h.affectedRows);
  }
  return 0;
}

/**
 * 状态迁移（**仅限 pending → active/rejected**）。返回受影响行数：
 * 0 = 该 id 不存在或已不在 pending（防重复审核/并发覆盖 —— 比 devListings 的
 * `UPDATE ... WHERE id=?` 多一道 status 守卫，因为此处有并发审核面）。
 */
async function migrate(
  id: number,
  to: "active" | "rejected",
  actor: AdminActor,
  reason: string | null,
  withColumns: boolean,
): Promise<number> {
  const db = getDb();
  if (withColumns) {
    const res = rawRows(
      await db.execute(
        sql`UPDATE agents SET status = ${to}, reviewedAt = UTC_TIMESTAMP(),
              reviewedBy = ${String(actor.id)}, rejectReason = ${reason}
            WHERE id = ${id} AND status = 'pending'`,
      ),
    );
    return affectedOf(res);
  }
  // 三列未签（C 级双签面）→ 只迁状态；审计照写，留痕不丢（在 detail_json 里）
  const res = rawRows(await db.execute(sql`UPDATE agents SET status = ${to} WHERE id = ${id} AND status = 'pending'`));
  return affectedOf(res);
}

// ─── router ──────────────────────────────────────────────────────────────────

/** token 请求体（与 admin.ts / devListings 同款：token 只在请求体，不入 header） */
const tokenInput = z.object({ token: z.string().trim().min(1) });

/**
 * 输入 schema 单源导出（供负向用例直测 zod 层，避免「绕过编译期约束去测运行时」）。
 * - rejectInput：**rejectReason 必填**（判据 6 的编译期与运行期同源）
 * - bulkApproveInput：agentIds 上限 BULK_LIMIT
 */
export const rejectInput = tokenInput.extend({
  agentId: z.number().int().positive(),
  // 必填且非空：trim 后 >=2 字（1 个字无法构成理由，避免「.」/「x」式敷衍留痕）
  rejectReason: z.string().trim().min(2, "驳回必须填写理由（至少 2 个字）").max(255),
});

export const approveInput = tokenInput.extend({ agentId: z.number().int().positive() });

export const listInput = tokenInput.extend({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(64).optional(),
  tier: z.enum(["high", "mid", "low"]).optional(),
});

export const bulkApproveInput = tokenInput.extend({
  agentIds: z.array(z.number().int().positive()).min(1).max(BULK_LIMIT),
  acknowledgeAutoHigh: z.boolean().default(false),
});

export const agentReviewQueueRouter = createRouter({
  /**
   * list：pending 审核队列（分页 + 搜索），每条带 AI 初审判定与可解释分项。
   * 排序：初审分降序（先看最该放行的）→ id 升序（同分按入队顺序，稳定可复现）。
   */
  list: publicQuery
    .input(listInput)
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const { candidates, scores, masterCount } = await loadScoredQueue();
      const needle = input.search?.toLowerCase();
      const rows = candidates
        .map((c, i) => ({ c, s: scores[i] }))
        .filter(({ c }) => {
          if (!needle) return true;
          return (
            c.name.toLowerCase().includes(needle) ||
            c.code.toLowerCase().includes(needle) ||
            c.industry.toLowerCase().includes(needle) ||
            c.industryGroup.toLowerCase().includes(needle)
          );
        })
        .filter(({ s }) => (input.tier ? s.tier === input.tier : true))
        .sort((a, b) => b.s.score - a.s.score || a.c.id - b.c.id);

      const total = rows.length;
      const start = (input.page - 1) * input.pageSize;
      const pageRows = rows.slice(start, start + input.pageSize);
      return {
        total,
        page: input.page,
        pageSize: input.pageSize,
        thresholds: { high: highThreshold(), low: lowThreshold(), autoApproveEnabled: autoApproveHighEnabled() },
        masterCount,
        items: pageRows.map(({ c, s }) => ({
          id: c.id,
          code: c.code,
          name: c.name,
          industry: c.industry,
          industryGroup: c.industryGroup,
          monthlyPrice: c.monthlyPrice,
          suggestedPrice: c.suggestedPrice,
          skillCount: c.skillCount,
          masterId: c.masterId,
          capabilityTags: c.capabilityTags,
          listedAt: c.listedAt,
          ai: { score: s.score, tier: s.tier, dimensions: s.dimensions, flags: s.flags, missing: s.missing },
        })),
      };
    }),

  /** stats：队列口径（决策台第 5 组「待审员工」角标数据源）+ 已审留痕计数 */
  stats: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const { candidates, scores, masterCount } = await loadScoredQueue();
    const db = getDb();
    const columnsReady = await hasReviewColumns();

    const reviewedRecently = { approved7d: 0, rejected7d: 0 };
    if (columnsReady) {
      try {
        const rows = rawRows(
          await db.execute(
            sql`SELECT status, COUNT(*) AS c FROM agents
                 WHERE reviewedAt IS NOT NULL AND reviewedAt >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)
                 GROUP BY status`,
          ),
        );
        for (const r of rows) {
          const n = Number(r.c ?? 0);
          if (String(r.status) === "active") reviewedRecently.approved7d = n;
          if (String(r.status) === "rejected") reviewedRecently.rejected7d = n;
        }
      } catch {
        // 留痕列在但查询失败 → 保持 0，不阻塞角标
      }
    }

    // 存量口径（审核只搬状态不增删，此处如实列出，供施工前后比对）
    let activeTotal = -1;
    try {
      const rows = rawRows(await db.execute(sql`SELECT COUNT(*) AS c FROM agents WHERE status = 'active'`));
      activeTotal = Number(rows[0]?.c ?? 0);
    } catch {
      activeTotal = -1;
    }

    return {
      pending: candidates.length,
      activeTotal,
      tiers: summarizeTiers(scores.map((s) => s.score)),
      reviewedRecently,
      mastersUsable: masterCount,
      reviewColumnsReady: columnsReady,
      thresholds: {
        high: highThreshold(),
        low: lowThreshold(),
        autoApproveEnabled: autoApproveHighEnabled(),
        basisNote:
          // 门禁 PR#35 票（maint/low）：原文硬编码字面值 88/60，而阈值实际由 highThreshold()/lowThreshold()
          //   运行时解析（支持 env 覆盖）。若设了 env，上屏 tiers 用新值、本说明仍报旧值
          //   ⇒ **给审计看的依据是错的**。改引解析后的真值，从源头杜绝分叉。
          `HIGH_T=${highThreshold()} / LOW_T=${lowThreshold()} 由 77 条 pending 实数标定（实测分区间 37-72，HIGH 档当前为空）；` +
          "但 D1(完整度) 与 D5(师承) 实测零方差，校准样本不足 —— 人工抽检 10 条后应复核阈值。",
      },
    };
  }),

  /** approve：pending → active + 写 reviewedAt/reviewedBy + st_admin_audit 留痕 */
  approve: publicQuery
    .input(approveInput)
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const actor = actorOf(admin as never);
      const withColumns = await hasReviewColumns();
      const n = await migrate(input.agentId, "active", actor, null, withColumns);
      if (n === 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `员工 #${input.agentId} 不在待审状态（已审过或不存在），本次未改动`,
        });
      }
      writeAdminAudit(actor.id, actor.displayName, "agentReview.approve", `agent#${input.agentId}`, {
        from: "pending",
        to: "active",
        reviewColumnsReady: withColumns,
      });
      return { ok: true as const, agentId: input.agentId, status: "active" as const, reviewedBy: actor.id };
    }),

  /**
   * reject：pending → rejected + **rejectReason 必填（服务端 zod 强制非空）**
   * + 写 reviewedAt/reviewedBy/rejectReason + st_admin_audit 留痕。
   */
  reject: publicQuery
    .input(rejectInput)
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const actor = actorOf(admin as never);
      const withColumns = await hasReviewColumns();
      const n = await migrate(input.agentId, "rejected", actor, input.rejectReason, withColumns);
      if (n === 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `员工 #${input.agentId} 不在待审状态（已审过或不存在），本次未改动`,
        });
      }
      writeAdminAudit(actor.id, actor.displayName, "agentReview.reject", `agent#${input.agentId}`, {
        from: "pending",
        to: "rejected",
        rejectReason: input.rejectReason,
        reviewColumnsReady: withColumns,
      });
      return {
        ok: true as const,
        agentId: input.agentId,
        status: "rejected" as const,
        rejectReason: input.rejectReason,
        reviewedBy: actor.id,
      };
    }),

  /**
   * bulkApprove：批量通过（HIGH 档自动通过档专用）。
   *
   * 双闸（方案「首次上线不做全自动」）：
   * ① 服务端开关 AGENT_REVIEW_AUTO_APPROVE_HIGH=1（默认关）—— 未开则**任何**批量调用被拒；
   * ② 请求层 acknowledgeAutoHigh 必须显式为 true —— 调用方必须明确表达「我知道这是自动档」。
   * 另：本端点**不自己决定审谁**，只审调用方显式传的 id（前端从 list 的 high 档勾选而来），
   * 因此开关即使打开也永远不吞掉人工判断。
   */
  bulkApprove: publicQuery
    .input(bulkApproveInput)
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      if (!autoApproveHighEnabled()) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "HIGH 档自动通过未开启（AGENT_REVIEW_AUTO_APPROVE_HIGH≠1）。首次上线须先人工抽检 10 条校准阈值 —— 请改用逐条 approve。",
        });
      }
      if (!input.acknowledgeAutoHigh) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "批量通过需显式 acknowledgeAutoHigh=true（确认走自动通过档）",
        });
      }
      // 门禁 PR#35 票（bug/medium）：**服务端必须自己校验档位**。
      //   原实现只查两个开关，然后对传入的每个 id 直接 migrate —— 若调用方传 low/mid 档 id，
      //   设计上「必须人工确认」的那些**会被自动通过**。开关契约写的是「HIGH 档专用」，
      //   服务端却不验，等于把这道门禁交给了客户端（而客户端恰是不可信的一方）。
      //   注：HIGH_T 由实测标定，当前 HIGH 档为空 ⇒ 正常情况下此处必拒 ——
      //   这是**正确**形状（数据够不到自动线），不是 bug。
      const { candidates, scores } = await loadScoredQueue();
      const tierById = new Map<number, ReviewTier>();
      for (let i = 0; i < candidates.length; i++) tierById.set(candidates[i].id, scores[i].tier);
      // 只拦「**在待审队列里、且不是 HIGH 档**」的 id：
      //   · 队列内 mid/low → 必须拒（设计上要人工确认，不能走自动档）
      //   · 队列外的 id → 交回 migrate 处理（它返回 0 → 计入 skipped），本闸不管
      const notHigh = input.agentIds.filter((id) => {
        const t = tierById.get(id);
        return t !== undefined && t !== "high";
      });
      if (notHigh.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `批量通过仅限 HIGH 档（以下 id 在待审队列中但不是 HIGH 档）：${notHigh.join(", ")} —— 请改用逐条 approve。`,
        });
      }
      const actor = actorOf(admin as never);
      const withColumns = await hasReviewColumns();
      const approved: number[] = [];
      const skipped: number[] = [];
      // 门禁 PR#35 票（bug/low）：原实现在循环**跑完之后**才写一条审计 ——
      //   若中途某次 migrate 抛错（如瞬时 DB 错误），**前面已提交为 active 的 id 无法回滚**
      //   （无事务），而审计**一条都没写**，调用方还收到「什么都不像发生过」的错误。
      //   已改为：**无论成败都在 finally 落审计**，并显式标出是否部分完成 ——
      //   至少让「已改了什么」有据可查。
      //   注：真正的原子性需把整个批次包进事务，而 migrate 目前不接事务句柄（改动面较大），
      //   故本轮先保证**审计不失真**；事务化另立后续项（见 PR 说明的未做清单）。
      let partial = false;
      try {
        for (const id of input.agentIds) {
          const n = await migrate(id, "active", actor, null, withColumns);
          if (n > 0) approved.push(id);
          else skipped.push(id);
        }
      } catch (e) {
        partial = true;
        throw e;
      } finally {
        writeAdminAudit(actor.id, actor.displayName, "agentReview.bulkApprove", `agents#${approved.length}`, {
          requested: input.agentIds.length,
          approved,
          skipped,
          reviewColumnsReady: withColumns,
          partial,
        });
      }
      return { ok: true as const, approved, skipped };
    }),
});

