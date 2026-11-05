/**
 * 幂等同步多行业扩展（迭代 13）：
 * agents 表新增 industryGroup 行业大类列 + 跨境电商/设计创意/财税服务
 * 3 个研究院 master + 18 位行业数字员工 + 每人 4 个 skill + 18 条链上身份卡。
 * TiDB 下 drizzle-kit push 不可用，故用 mysql2 直连（参照 sync-dev-ecosystem.mts 模式）。
 * 用法：DATABASE_URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2-) npx tsx db/sync-industries.mts
 * 语法自检：DRY_RUN=1 npx tsx db/sync-industries.mts（不连库，直接退出）
 *
 * - 加列：information_schema 检测后 ALTER TABLE（additive，可重复执行）
 * - 幂等键：masters 按 name、agents 按 slug、skills 按 agentId+name、
 *   wb_evo_identities 按 did
 */
if (process.env.DRY_RUN) {
  console.log("dry run ok");
  process.exit(0);
}

import { createHash } from "node:crypto";
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const conn = await mysql.createConnection(url);

function sha256(plain: string): string {
  return createHash("sha256").update(plain, "utf8").digest("hex");
}

const DAY = 24 * 3600 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

// ── 1. agents 表加 industryGroup 列（additive，幂等）────────────────────────
{
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agents' AND COLUMN_NAME = 'industryGroup'`,
  );
  if ((cols as unknown[]).length > 0) {
    console.log("agents.industryGroup: column exists, skip");
  } else {
    await conn.query(
      `ALTER TABLE agents ADD COLUMN industryGroup VARCHAR(32) NOT NULL DEFAULT '工业制造' AFTER industry`,
    );
    console.log("agents.industryGroup: column added");
  }
  // 防御回填：历史数据若为空串/NULL 一律归入工业制造
  const [upd] = await conn.query(
    `UPDATE agents SET industryGroup = '工业制造' WHERE industryGroup = '' OR industryGroup IS NULL`,
  );
  console.log(`agents.industryGroup: backfill ok (affected=${(upd as { affectedRows: number }).affectedRows})`);
}

// ── 2. 3 个行业研究院 master（按 name 幂等）─────────────────────────────────
const seedMasters = [
  {
    name: "星澜跨境商贸研究院",
    signature: "星澜跨境商贸研究院 · 跨境贸易智能体官方认证",
    specialty: "跨境贸易智能体认证",
    yearsExperience: 10,
    reputation: 96,
  },
  {
    name: "彩云设计创新研究院",
    signature: "彩云设计创新研究院 · 设计智能体官方认证",
    specialty: "设计智能体认证",
    yearsExperience: 9,
    reputation: 95,
  },
  {
    name: "金穗财税研究院",
    signature: "金穗财税研究院 · 财税智能体官方认证",
    specialty: "财税智能体认证",
    yearsExperience: 11,
    reputation: 97,
  },
];

const masterIds: Record<string, number> = {};
for (const m of seedMasters) {
  const [rows] = await conn.query(
    "SELECT id FROM masters WHERE name = ? LIMIT 1",
    [m.name],
  );
  const existing = (rows as { id: number }[])[0];
  if (existing) {
    masterIds[m.name] = existing.id;
    console.log(`masters: ${m.name} exists (id=${existing.id}), skip`);
    continue;
  }
  const [res] = await conn.query(
    `INSERT INTO masters (name, signature, specialty, yearsExperience, title, reputation)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [m.name, m.signature, m.specialty, m.yearsExperience, "官方认证机构", m.reputation],
  );
  masterIds[m.name] = (res as { insertId: number }).insertId;
  console.log(`masters: seeded ${m.name} (id=${masterIds[m.name]})`);
}

// ── 3. 18 位行业数字员工（按 slug 幂等）─────────────────────────────────────
interface IndustryAgent {
  slug: string;
  code: string;
  name: string;
  industry: string; // 细分行业
  industryGroup: string; // 行业大类
  masterName: string; // 对应研究院
  capabilityTags: string[];
  monthlyPrice: number;
  suggestedPrice: number;
  tasksCompleted: number;
  successRate: number;
  avgRating: number;
  ratingCount: number;
  experienceMonths: number;
  skillCount: number;
  memoryCount: number;
  weeklyHires: number;
  weeklyHireTrend: number[];
  listedDaysAgo: number;
  recommended?: boolean;
}

const industryAgents: IndustryAgent[] = [
  // ── 跨境电商馆（星澜跨境商贸研究院）──
  {
    slug: "duyang", code: "ART-0201", name: "渡洋", industry: "跨境平台运营",
    industryGroup: "跨境电商", masterName: "星澜跨境商贸研究院",
    capabilityTags: ["运营总管", "多平台统筹", "利润看板", "库存联动"],
    monthlyPrice: 15999, suggestedPrice: 19999, tasksCompleted: 1120,
    successRate: 99.1, avgRating: 4.9, ratingCount: 176, experienceMonths: 34,
    skillCount: 4, memoryCount: 430, weeklyHires: 12,
    weeklyHireTrend: [5, 6, 7, 8, 9, 10, 12], listedDaysAgo: 18, recommended: true,
  },
  {
    slug: "milan", code: "ART-0202", name: "觅澜", industry: "跨境选品",
    industryGroup: "跨境电商", masterName: "星澜跨境商贸研究院",
    capabilityTags: ["选品Agent", "趋势捕捉", "蓝海挖掘", "竞品监测"],
    monthlyPrice: 6999, suggestedPrice: 8999, tasksCompleted: 1980,
    successRate: 98.7, avgRating: 4.8, ratingCount: 243, experienceMonths: 26,
    skillCount: 4, memoryCount: 380, weeklyHires: 10,
    weeklyHireTrend: [4, 5, 6, 6, 7, 8, 10], listedDaysAgo: 16,
  },
  {
    slug: "yifan", code: "ART-0203", name: "译帆", industry: "Listing本地化",
    industryGroup: "跨境电商", masterName: "星澜跨境商贸研究院",
    capabilityTags: ["多语Listing", "文案本地化", "A+页面", "关键词优化"],
    monthlyPrice: 5999, suggestedPrice: 7999, tasksCompleted: 2340,
    successRate: 98.9, avgRating: 4.8, ratingCount: 268, experienceMonths: 24,
    skillCount: 4, memoryCount: 350, weeklyHires: 9,
    weeklyHireTrend: [4, 5, 5, 6, 7, 8, 9], listedDaysAgo: 15,
  },
  {
    slug: "tuoling", code: "ART-0204", name: "驼铃", industry: "跨境物流",
    industryGroup: "跨境电商", masterName: "星澜跨境商贸研究院",
    capabilityTags: ["物流Agent", "头程海空派", "海外仓", "清关追踪"],
    monthlyPrice: 7999, suggestedPrice: 9999, tasksCompleted: 1650,
    successRate: 98.5, avgRating: 4.7, ratingCount: 198, experienceMonths: 28,
    skillCount: 4, memoryCount: 360, weeklyHires: 8,
    weeklyHireTrend: [3, 4, 5, 5, 6, 7, 8], listedDaysAgo: 13,
  },
  {
    slug: "xingdun", code: "ART-0205", name: "星盾", industry: "跨境合规",
    industryGroup: "跨境电商", masterName: "星澜跨境商贸研究院",
    capabilityTags: ["合规风控", "知识产权", "平台规则", "VAT合规"],
    monthlyPrice: 9999, suggestedPrice: 12999, tasksCompleted: 980,
    successRate: 99.3, avgRating: 4.9, ratingCount: 142, experienceMonths: 30,
    skillCount: 4, memoryCount: 390, weeklyHires: 7,
    weeklyHireTrend: [3, 3, 4, 5, 5, 6, 7], listedDaysAgo: 11,
  },
  {
    slug: "chaoming", code: "ART-0206", name: "潮鸣", industry: "跨境广告",
    industryGroup: "跨境电商", masterName: "星澜跨境商贸研究院",
    capabilityTags: ["广告投手", "站内PPC", "站外引流", "ACOS优化"],
    monthlyPrice: 8999, suggestedPrice: 11999, tasksCompleted: 1420,
    successRate: 98.4, avgRating: 4.7, ratingCount: 167, experienceMonths: 22,
    skillCount: 4, memoryCount: 330, weeklyHires: 9,
    weeklyHireTrend: [4, 5, 5, 6, 7, 8, 9], listedDaysAgo: 9,
  },
  // ── 设计创意馆（彩云设计创新研究院）──
  {
    slug: "danqing", code: "ART-0301", name: "丹青", industry: "平面设计",
    industryGroup: "设计创意", masterName: "彩云设计创新研究院",
    capabilityTags: ["平面设计", "海报KV", "VI物料", "版式网格"],
    monthlyPrice: 5999, suggestedPrice: 7999, tasksCompleted: 2150,
    successRate: 98.8, avgRating: 4.8, ratingCount: 286, experienceMonths: 25,
    skillCount: 4, memoryCount: 370, weeklyHires: 11,
    weeklyHireTrend: [5, 6, 7, 7, 8, 9, 11], listedDaysAgo: 17, recommended: true,
  },
  {
    slug: "liubai", code: "ART-0302", name: "留白", industry: "品牌设计",
    industryGroup: "设计创意", masterName: "彩云设计创新研究院",
    capabilityTags: ["品牌设计", "品牌策略", "视觉系统", "VI规范"],
    monthlyPrice: 9999, suggestedPrice: 13999, tasksCompleted: 1240,
    successRate: 99.2, avgRating: 4.9, ratingCount: 158, experienceMonths: 31,
    skillCount: 4, memoryCount: 410, weeklyHires: 8,
    weeklyHireTrend: [3, 4, 5, 5, 6, 7, 8], listedDaysAgo: 14,
  },
  {
    slug: "chisu", code: "ART-0303", name: "尺素", industry: "UI/UX设计",
    industryGroup: "设计创意", masterName: "彩云设计创新研究院",
    capabilityTags: ["UI设计", "交互原型", "设计系统", "可用性走查"],
    monthlyPrice: 7999, suggestedPrice: 10999, tasksCompleted: 1730,
    successRate: 98.9, avgRating: 4.8, ratingCount: 204, experienceMonths: 26,
    skillCount: 4, memoryCount: 380, weeklyHires: 10,
    weeklyHireTrend: [4, 5, 6, 6, 7, 8, 10], listedDaysAgo: 12,
  },
  {
    slug: "sunmao", code: "ART-0304", name: "榫卯", industry: "工业设计",
    industryGroup: "设计创意", masterName: "彩云设计创新研究院",
    capabilityTags: ["工业设计", "产品外观", "结构CMF", "爆炸图"],
    monthlyPrice: 11999, suggestedPrice: 15999, tasksCompleted: 890,
    successRate: 99.0, avgRating: 4.9, ratingCount: 121, experienceMonths: 33,
    skillCount: 4, memoryCount: 420, weeklyHires: 6,
    weeklyHireTrend: [2, 3, 3, 4, 5, 5, 6], listedDaysAgo: 10,
  },
  {
    slug: "qijing", code: "ART-0305", name: "栖境", industry: "空间设计",
    industryGroup: "设计创意", masterName: "彩云设计创新研究院",
    capabilityTags: ["空间设计", "室内方案", "展陈设计", "动线规划"],
    monthlyPrice: 8999, suggestedPrice: 11999, tasksCompleted: 760,
    successRate: 98.6, avgRating: 4.8, ratingCount: 98, experienceMonths: 27,
    skillCount: 4, memoryCount: 340, weeklyHires: 5,
    weeklyHireTrend: [2, 2, 3, 3, 4, 4, 5], listedDaysAgo: 8,
  },
  {
    slug: "moyun", code: "ART-0306", name: "墨韵", industry: "包装设计",
    industryGroup: "设计创意", masterName: "彩云设计创新研究院",
    capabilityTags: ["包装设计", "瓶贴标签", "礼盒结构", "系列插画"],
    monthlyPrice: 6999, suggestedPrice: 8999, tasksCompleted: 1580,
    successRate: 98.7, avgRating: 4.7, ratingCount: 176, experienceMonths: 23,
    skillCount: 4, memoryCount: 320, weeklyHires: 8,
    weeklyHireTrend: [3, 4, 5, 5, 6, 7, 8], listedDaysAgo: 7,
  },
  // ── 财税服务馆（金穗财税研究院）──
  {
    slug: "siku", code: "ART-0401", name: "司库", industry: "财税统筹",
    industryGroup: "财税服务", masterName: "金穗财税研究院",
    capabilityTags: ["财税总管", "全盘账税", "资金计划", "报表解读"],
    monthlyPrice: 16999, suggestedPrice: 21999, tasksCompleted: 1080,
    successRate: 99.4, avgRating: 4.9, ratingCount: 164, experienceMonths: 36,
    skillCount: 4, memoryCount: 460, weeklyHires: 11,
    weeklyHireTrend: [5, 6, 7, 8, 8, 9, 11], listedDaysAgo: 19, recommended: true,
  },
  {
    slug: "mingzhang", code: "ART-0402", name: "明账", industry: "代理记账",
    industryGroup: "财税服务", masterName: "金穗财税研究院",
    capabilityTags: ["智能记账", "凭证生成", "账簿管理", "银行对账"],
    monthlyPrice: 6999, suggestedPrice: 8999, tasksCompleted: 2680,
    successRate: 99.5, avgRating: 4.8, ratingCount: 312, experienceMonths: 29,
    skillCount: 4, memoryCount: 440, weeklyHires: 12,
    weeklyHireTrend: [5, 6, 7, 8, 9, 10, 12], listedDaysAgo: 16,
  },
  {
    slug: "chouheng", code: "ART-0403", name: "筹衡", industry: "税务合规筹划",
    industryGroup: "财税服务", masterName: "金穗财税研究院",
    capabilityTags: ["合规筹划", "优惠政策适配", "税负测算", "风险提示"],
    monthlyPrice: 12999, suggestedPrice: 16999, tasksCompleted: 920,
    successRate: 99.2, avgRating: 4.9, ratingCount: 138, experienceMonths: 32,
    skillCount: 4, memoryCount: 410, weeklyHires: 7,
    weeklyHireTrend: [3, 3, 4, 5, 5, 6, 7], listedDaysAgo: 13,
  },
  {
    slug: "shenwei", code: "ART-0404", name: "审微", industry: "智能审计",
    industryGroup: "财税服务", masterName: "金穗财税研究院",
    capabilityTags: ["审计Agent", "风险扫描", "凭证抽查", "底稿生成"],
    monthlyPrice: 11999, suggestedPrice: 15999, tasksCompleted: 840,
    successRate: 98.9, avgRating: 4.8, ratingCount: 116, experienceMonths: 30,
    skillCount: 4, memoryCount: 390, weeklyHires: 6,
    weeklyHireTrend: [2, 3, 3, 4, 5, 5, 6], listedDaysAgo: 11,
  },
  {
    slug: "piaoshu", code: "ART-0405", name: "票枢", industry: "发票管理",
    industryGroup: "财税服务", masterName: "金穗财税研究院",
    capabilityTags: ["发票管理", "进销项匹配", "真伪查验", "票账归档"],
    monthlyPrice: 5999, suggestedPrice: 7999, tasksCompleted: 2240,
    successRate: 99.3, avgRating: 4.7, ratingCount: 245, experienceMonths: 24,
    skillCount: 4, memoryCount: 350, weeklyHires: 9,
    weeklyHireTrend: [4, 5, 5, 6, 7, 8, 9], listedDaysAgo: 9,
  },
  {
    slug: "huisuan", code: "ART-0406", name: "汇算", industry: "汇算清缴",
    industryGroup: "财税服务", masterName: "金穗财税研究院",
    capabilityTags: ["汇算清缴", "年度申报", "税前扣除校验", "纳税调整"],
    monthlyPrice: 9999, suggestedPrice: 13999, tasksCompleted: 690,
    successRate: 98.8, avgRating: 4.8, ratingCount: 94, experienceMonths: 28,
    skillCount: 4, memoryCount: 360, weeklyHires: 5,
    weeklyHireTrend: [2, 2, 3, 3, 4, 4, 5], listedDaysAgo: 6,
  },
];

const agentIds: Record<string, number> = {};
for (const a of industryAgents) {
  const [rows] = await conn.query(
    "SELECT id FROM agents WHERE slug = ? LIMIT 1",
    [a.slug],
  );
  const existing = (rows as { id: number }[])[0];
  if (existing) {
    agentIds[a.slug] = existing.id;
    console.log(`agents: ${a.name}(${a.slug}) exists (id=${existing.id}), skip`);
    continue;
  }
  const [res] = await conn.query(
    `INSERT INTO agents
     (slug, code, name, avatar, industry, industryGroup, capabilityTags, masterId, status, delistRisk,
      monthlyPrice, suggestedPrice, tasksCompleted, successRate, avgRating, ratingCount,
      experienceMonths, skillCount, memoryCount, weeklyHires, weeklyHireTrend,
      recommended, certified, listedAt)
     VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, 'active', false,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, true, ?)`,
    [
      a.slug,
      a.code,
      a.name,
      `/avatar-${a.slug}.png`,
      a.industry,
      a.industryGroup,
      JSON.stringify(a.capabilityTags),
      masterIds[a.masterName],
      a.monthlyPrice,
      a.suggestedPrice,
      a.tasksCompleted,
      a.successRate,
      a.avgRating,
      a.ratingCount,
      a.experienceMonths,
      a.skillCount,
      a.memoryCount,
      a.weeklyHires,
      JSON.stringify(a.weeklyHireTrend),
      a.recommended === true,
      daysAgo(a.listedDaysAgo),
    ],
  );
  agentIds[a.slug] = (res as { insertId: number }).insertId;
  console.log(`agents: seeded ${a.name}(${a.slug}, ${a.code}, ${a.industryGroup})`);
}

// ── 4. 每 agent 4 个 skill（按 agentId+name 幂等）────────────────────────────
interface SeedSkill {
  name: string;
  type: "V" | "U";
  complexity: number;
  pricePerCall: number;
  callCount: number;
  successRate: number;
  description: string;
}

const industrySkills: Record<string, SeedSkill[]> = {
  duyang: [
    { name: "多平台店铺统筹", type: "V", complexity: 5, pricePerCall: 280, callCount: 4200, successRate: 99.2, description: "统筹多平台店铺运营节奏，输出统一排期与分工指令。" },
    { name: "利润看板解读", type: "U", complexity: 4, pricePerCall: 180, callCount: 3600, successRate: 99.5, description: "汇总各店铺毛利、广告占比与汇率损益，生成老板视角利润结论。" },
    { name: "库存滞销预警", type: "U", complexity: 4, pricePerCall: 160, callCount: 2900, successRate: 99.0, description: "按动销天数与库龄识别滞销 SKU，给出清仓与补货建议。" },
    { name: "跨境经营周报复盘", type: "V", complexity: 4, pricePerCall: 220, callCount: 980, successRate: 99.3, description: "自动生成跨境经营周报，含平台表现、利润归因与下周动作清单。" },
  ],
  milan: [
    { name: "蓝海品类扫描", type: "V", complexity: 4, pricePerCall: 240, callCount: 5100, successRate: 98.8, description: "扫描平台品类供需缺口，输出蓝海品类候选清单。" },
    { name: "竞品榜单监测", type: "V", complexity: 3, pricePerCall: 150, callCount: 4800, successRate: 98.9, description: "跟踪竞品榜单与价格变动，标注异常动作与上新节奏。" },
    { name: "趋势词云分析", type: "U", complexity: 3, pricePerCall: 120, callCount: 3900, successRate: 98.6, description: "聚合搜索趋势词与社媒热词，生成选品趋势词云。" },
    { name: "选品机会打分", type: "U", complexity: 4, pricePerCall: 180, callCount: 2600, successRate: 98.7, description: "按市场容量、竞争度与利润率对候选品打分排序。" },
  ],
  yifan: [
    { name: "多语Listing生成", type: "V", complexity: 4, pricePerCall: 200, callCount: 5200, successRate: 98.9, description: "一键生成多语言标题、五点与详情文案，适配各站点规范。" },
    { name: "关键词埋词优化", type: "V", complexity: 4, pricePerCall: 170, callCount: 4100, successRate: 98.8, description: "按搜索量与相关度优化埋词结构，提升自然排名。" },
    { name: "A+页面文案撰写", type: "V", complexity: 3, pricePerCall: 160, callCount: 2800, successRate: 98.7, description: "撰写 A+ 页面模块化文案，突出卖点与品牌故事。" },
    { name: "本地化语感校验", type: "U", complexity: 3, pricePerCall: 110, callCount: 2400, successRate: 99.1, description: "校验译文的本地化语感与禁忌词，标记生硬表达。" },
  ],
  tuoling: [
    { name: "头程方案比价", type: "V", complexity: 4, pricePerCall: 190, callCount: 3800, successRate: 98.9, description: "归集海派、空派与铁路头程报价，输出时效与成本比价矩阵。" },
    { name: "海外仓补货测算", type: "V", complexity: 4, pricePerCall: 170, callCount: 3100, successRate: 99.0, description: "按销量预测与在途库存测算海外仓补货量与发运窗口。" },
    { name: "清关异常预警", type: "U", complexity: 4, pricePerCall: 200, callCount: 1500, successRate: 98.6, description: "识别清关查验与申报异常，推送处置指引与所需单证。" },
    { name: "在途轨迹追踪", type: "V", complexity: 3, pricePerCall: 100, callCount: 4600, successRate: 99.2, description: "聚合头程、干线与尾程轨迹，输出在途状态看板。" },
  ],
  xingdun: [
    { name: "知识产权排查", type: "U", complexity: 5, pricePerCall: 320, callCount: 2100, successRate: 99.3, description: "排查商标、专利与版权侵权风险，输出高风险清单。" },
    { name: "平台规则巡检", type: "U", complexity: 4, pricePerCall: 220, callCount: 2600, successRate: 99.4, description: "巡检店铺绩效与平台规则变更，标记违规隐患。" },
    { name: "VAT申报校验", type: "V", complexity: 5, pricePerCall: 280, callCount: 1300, successRate: 99.5, description: "校验欧洲 VAT 申报数据一致性，标记申报差异。" },
    { name: "侵权风险处置建议", type: "V", complexity: 5, pricePerCall: 300, callCount: 900, successRate: 99.0, description: "针对投诉与下架事件生成申诉材料与处置路径。" },
  ],
  chaoming: [
    { name: "广告结构搭建", type: "V", complexity: 4, pricePerCall: 210, callCount: 3400, successRate: 98.7, description: "按品类与预算搭建站内广告账户结构。" },
    { name: "关键词竞价调优", type: "V", complexity: 4, pricePerCall: 190, callCount: 4100, successRate: 98.6, description: "按转化与点击数据动态调整关键词竞价与预算分配。" },
    { name: "ACOS异常诊断", type: "U", complexity: 4, pricePerCall: 180, callCount: 2200, successRate: 98.5, description: "诊断 ACOS 异常波动，定位问题广告组与关键词。" },
    { name: "投放日报生成", type: "V", complexity: 3, pricePerCall: 120, callCount: 2900, successRate: 99.1, description: "自动生成投放日报，含曝光、点击、转化与 ACOS 趋势。" },
  ],
  danqing: [
    { name: "海报KV设计", type: "V", complexity: 4, pricePerCall: 230, callCount: 4600, successRate: 98.9, description: "按主题与版式规范输出海报主视觉 KV 方案。" },
    { name: "VI物料延展", type: "V", complexity: 3, pricePerCall: 160, callCount: 3800, successRate: 99.0, description: "基于品牌 VI 规范延展名片、信纸与周边物料。" },
    { name: "版式网格校验", type: "U", complexity: 3, pricePerCall: 110, callCount: 3200, successRate: 99.2, description: "校验版面栅格、留白与对齐，标记版式问题。" },
    { name: "多尺寸适配输出", type: "V", complexity: 3, pricePerCall: 140, callCount: 4100, successRate: 98.8, description: "一键输出多尺寸适配版本，保持视觉一致性。" },
  ],
  liubai: [
    { name: "品牌定位梳理", type: "U", complexity: 5, pricePerCall: 300, callCount: 1600, successRate: 99.2, description: "梳理目标人群与竞争格局，输出品牌定位与核心价值。" },
    { name: "标志概念草案", type: "V", complexity: 5, pricePerCall: 320, callCount: 1400, successRate: 98.8, description: "生成标志概念方向草案，附设计推演说明。" },
    { name: "VI规范手册生成", type: "V", complexity: 4, pricePerCall: 280, callCount: 1100, successRate: 99.3, description: "输出 VI 规范手册，含标志用法、标准色与字体规范。" },
    { name: "品牌触点巡检", type: "U", complexity: 4, pricePerCall: 200, callCount: 1300, successRate: 99.0, description: "巡检线上线下品牌触点一致性，标记偏差项。" },
  ],
  chisu: [
    { name: "高保真界面设计", type: "V", complexity: 4, pricePerCall: 240, callCount: 3900, successRate: 98.9, description: "按产品需求输出高保真界面与视觉规范。" },
    { name: "交互原型串联", type: "V", complexity: 4, pricePerCall: 200, callCount: 3300, successRate: 98.8, description: "串联页面流转与交互状态，输出可点击原型。" },
    { name: "设计系统维护", type: "V", complexity: 4, pricePerCall: 220, callCount: 2100, successRate: 99.1, description: "维护组件库与设计令牌，保障多端一致性。" },
    { name: "可用性走查", type: "U", complexity: 4, pricePerCall: 180, callCount: 1700, successRate: 99.0, description: "按可用性原则走查界面，输出问题清单与优先级。" },
  ],
  sunmao: [
    { name: "产品外观推演", type: "V", complexity: 5, pricePerCall: 300, callCount: 1400, successRate: 99.0, description: "推演产品外观形态与比例，输出多方向草案。" },
    { name: "CMF方案搭配", type: "V", complexity: 4, pricePerCall: 260, callCount: 1200, successRate: 98.9, description: "搭配颜色、材料与工艺方案，输出 CMF 板与成本预估。" },
    { name: "可制造性评审", type: "U", complexity: 5, pricePerCall: 280, callCount: 1000, successRate: 99.1, description: "评审外观方案的可制造性，标记工艺与模具风险。" },
    { name: "结构爆炸图绘制", type: "V", complexity: 4, pricePerCall: 240, callCount: 1100, successRate: 99.2, description: "绘制结构爆炸图，标注装配关系与关键零件。" },
  ],
  qijing: [
    { name: "户型动线规划", type: "V", complexity: 4, pricePerCall: 220, callCount: 1300, successRate: 98.8, description: "规划户型功能分区与动线，输出平面布局方案。" },
    { name: "软装方案搭配", type: "V", complexity: 3, pricePerCall: 180, callCount: 1500, successRate: 98.7, description: "搭配家具、灯具与布艺，输出软装清单与效果图。" },
    { name: "展陈叙事设计", type: "V", complexity: 4, pricePerCall: 240, callCount: 900, successRate: 98.6, description: "设计展陈空间叙事节奏与观展动线。" },
    { name: "光照氛围模拟", type: "U", complexity: 4, pricePerCall: 200, callCount: 800, successRate: 98.9, description: "模拟不同时段光照氛围，校验照明方案。" },
  ],
  moyun: [
    { name: "包装结构设计", type: "V", complexity: 4, pricePerCall: 210, callCount: 2900, successRate: 98.9, description: "设计包装结构与刀版，兼顾保护与开合体验。" },
    { name: "瓶贴标签排版", type: "V", complexity: 3, pricePerCall: 150, callCount: 3400, successRate: 98.8, description: "按法规要素与版式规范排版瓶贴标签。" },
    { name: "礼盒工艺适配", type: "U", complexity: 4, pricePerCall: 190, callCount: 1600, successRate: 98.7, description: "校验烫金、UV 与击凸等工艺可行性，给出成本建议。" },
    { name: "系列插画生成", type: "V", complexity: 4, pricePerCall: 230, callCount: 2400, successRate: 98.6, description: "生成系列化包装插画，保持统一画风与延展性。" },
  ],
  siku: [
    { name: "全盘账务统筹", type: "V", complexity: 5, pricePerCall: 300, callCount: 2600, successRate: 99.5, description: "统筹总账、成本与往来核算，把控全盘账务质量。" },
    { name: "资金计划编制", type: "V", complexity: 4, pricePerCall: 260, callCount: 1900, successRate: 99.4, description: "编制滚动资金计划，预警资金缺口与闲置。" },
    { name: "报表异常解读", type: "U", complexity: 5, pricePerCall: 280, callCount: 2100, successRate: 99.3, description: "解读三大报表异常波动，定位经营与账务成因。" },
    { name: "月度财税复盘", type: "V", complexity: 4, pricePerCall: 220, callCount: 1100, successRate: 99.6, description: "生成月度财税复盘报告，含指标趋势与改进建议。" },
  ],
  mingzhang: [
    { name: "凭证智能生成", type: "V", complexity: 4, pricePerCall: 180, callCount: 5200, successRate: 99.6, description: "按业务单据智能生成记账凭证，自动匹配科目。" },
    { name: "银行流水对账", type: "V", complexity: 3, pricePerCall: 140, callCount: 5000, successRate: 99.5, description: "银行流水与账面自动对账，标记未达账项。" },
    { name: "账簿期末结转", type: "V", complexity: 4, pricePerCall: 200, callCount: 2400, successRate: 99.4, description: "自动执行期末结转流程，输出结转核对表。" },
    { name: "科目余额校验", type: "U", complexity: 3, pricePerCall: 120, callCount: 3100, successRate: 99.7, description: "校验科目余额方向与勾稽关系，标记异常余额。" },
  ],
  chouheng: [
    { name: "优惠政策适配", type: "U", complexity: 5, pricePerCall: 300, callCount: 1700, successRate: 99.4, description: "匹配企业适用的财税优惠政策，测算可享红利。" },
    { name: "税负压力测算", type: "V", complexity: 4, pricePerCall: 260, callCount: 1500, successRate: 99.2, description: "测算不同业务结构下的税负水平与敏感点。" },
    { name: "合规筹划方案输出", type: "V", complexity: 5, pricePerCall: 320, callCount: 1200, successRate: 99.3, description: "在合法合规边界内输出合规筹划方案与落地路径。" },
    { name: "风险边界提示", type: "U", complexity: 5, pricePerCall: 280, callCount: 1000, successRate: 99.5, description: "识别筹划动作的风险边界，出具合规风险提示。" },
  ],
  shenwei: [
    { name: "凭证风险扫描", type: "U", complexity: 4, pricePerCall: 260, callCount: 2200, successRate: 99.0, description: "批量扫描凭证风险特征，标记高风险分录。" },
    { name: "异常分录定位", type: "U", complexity: 4, pricePerCall: 240, callCount: 1800, successRate: 98.9, description: "定位异常科目组合与金额异常分录，附核查指引。" },
    { name: "审计底稿生成", type: "V", complexity: 5, pricePerCall: 300, callCount: 1300, successRate: 99.1, description: "按审计程序自动生成标准化工作底稿。" },
    { name: "整改建议输出", type: "V", complexity: 4, pricePerCall: 220, callCount: 900, successRate: 99.0, description: "针对审计发现输出整改建议与责任分工清单。" },
  ],
  piaoshu: [
    { name: "进销项发票匹配", type: "V", complexity: 4, pricePerCall: 170, callCount: 4800, successRate: 99.4, description: "进销项发票自动匹配勾稽，标记缺票与错配。" },
    { name: "发票真伪查验", type: "V", complexity: 3, pricePerCall: 130, callCount: 5100, successRate: 99.5, description: "批量查验发票真伪与状态，输出查验台账。" },
    { name: "异常发票预警", type: "U", complexity: 4, pricePerCall: 190, callCount: 2300, successRate: 99.2, description: "识别失控、红冲异常与敏感类目发票并预警。" },
    { name: "票账归档同步", type: "V", complexity: 3, pricePerCall: 110, callCount: 3200, successRate: 99.3, description: "发票影像与账务凭证归档同步，保证票账一致。" },
  ],
  huisuan: [
    { name: "税前扣除校验", type: "U", complexity: 5, pricePerCall: 280, callCount: 1300, successRate: 99.0, description: "校验税前扣除凭证与限额，标记不合规扣除项。" },
    { name: "年度申报表生成", type: "V", complexity: 5, pricePerCall: 320, callCount: 1100, successRate: 99.1, description: "自动生成企业所得税年度申报表及附表。" },
    { name: "纳税调整归集", type: "V", complexity: 4, pricePerCall: 260, callCount: 900, successRate: 98.9, description: "归集纳税调整事项，输出调整明细与依据。" },
    { name: "汇算差异说明", type: "V", complexity: 4, pricePerCall: 220, callCount: 800, successRate: 99.0, description: "生成汇算清缴差异说明，解释税会差异成因。" },
  ],
};

for (const [slug, skillList] of Object.entries(industrySkills)) {
  const agentId = agentIds[slug];
  for (const s of skillList) {
    const [dup] = await conn.query(
      "SELECT id FROM skills WHERE agentId = ? AND name = ? LIMIT 1",
      [agentId, s.name],
    );
    if ((dup as unknown[]).length > 0) {
      console.log(`skills: ${slug}/「${s.name}」exists, skip`);
      continue;
    }
    await conn.query(
      `INSERT INTO skills (agentId, name, type, complexity, pricePerCall, callCount, successRate, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, s.name, s.type, s.complexity, s.pricePerCall, s.callCount, s.successRate, s.description],
    );
    console.log(`skills: seeded ${slug}/「${s.name}」`);
  }
}

// ── 5. wb_evo_identities 18 条（按 did 幂等；factoryId=0 表示平台级）──────────
for (const a of industryAgents) {
  const did = `did:nebula:agent-${a.slug}`;
  const [dup] = await conn.query(
    "SELECT id FROM wb_evo_identities WHERE did = ? LIMIT 1",
    [did],
  );
  if ((dup as unknown[]).length > 0) {
    console.log(`wb_evo_identities: ${did} exists, skip`);
    continue;
  }
  const prevHash = sha256(`nebula:genesis:${a.slug}`);
  const blockHash = sha256(`${did}:${agentIds[a.slug]}:1:${prevHash}`);
  await conn.query(
    `INSERT INTO wb_evo_identities
     (did, agentId, factoryId, keyState, quota, blockHash, prevHash, blockHeight, card)
     VALUES (?, ?, 0, 'ADDED', 1000, ?, ?, 1, CAST(? AS JSON))`,
    [
      did,
      agentIds[a.slug],
      blockHash,
      prevHash,
      JSON.stringify({
        name: a.name,
        role: a.capabilityTags[0],
        skillFingerprint: sha256(`${a.slug}:${a.capabilityTags.join(",")}`).slice(0, 16),
        issuedBy: a.masterName,
        trustLevel: 3,
      }),
    ],
  );
  console.log(`wb_evo_identities: seeded ${did}`);
}

// ── 6. 汇总 ──────────────────────────────────────────────────────────────────
const checks: [string, string][] = [
  ["agents(industryGroup=跨境电商)", "SELECT COUNT(*) AS c FROM agents WHERE industryGroup='跨境电商'"],
  ["agents(industryGroup=设计创意)", "SELECT COUNT(*) AS c FROM agents WHERE industryGroup='设计创意'"],
  ["agents(industryGroup=财税服务)", "SELECT COUNT(*) AS c FROM agents WHERE industryGroup='财税服务'"],
  ["agents(industryGroup=工业制造)", "SELECT COUNT(*) AS c FROM agents WHERE industryGroup='工业制造'"],
  ["skills(18位新馆员工)", "SELECT COUNT(*) AS c FROM skills WHERE agentId IN (SELECT id FROM agents WHERE industryGroup IN ('跨境电商','设计创意','财税服务'))"],
  ["wb_evo_identities(all)", "SELECT COUNT(*) AS c FROM wb_evo_identities WHERE did LIKE 'did:nebula:agent-%'"],
];
for (const [label, q] of checks) {
  const [rows] = await conn.query(q);
  console.log(`${label}: ${(rows as { c: number }[])[0].c} row(s)`);
}

await conn.end();
console.log("sync-industries done.");
