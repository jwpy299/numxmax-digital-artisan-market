/**
 * 幂等同步开发者生态（dev_ 前缀 3 表）+ 旗舰数字员工种子。
 * TiDB 下 drizzle-kit push 不可用，故用 mysql2 直连（参照 sync-workbench.mts 模式）。
 * 用法：DATABASE_URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2-) npx tsx db/sync-dev-ecosystem.mts
 *
 * - CREATE TABLE IF NOT EXISTS ×3（dev_accounts / dev_listings / dev_earnings）
 * - 幂等键：masters 按 name、agents 按 slug、skills 按 agentId+name、
 *   devAccounts 按 username、devListings 按 devId+name、wb_evo_identities 按 did、
 *   devEarnings 按 listingId 计数跳过（已有流水不重复生成）
 * - 种子：master「灵枢智造研究院」+ 5 旗舰数字员工（昊枢/锱铢/千询/揽月/淬锋）
 *   + 每旗舰 3-5 个 skill + 5 条链上身份卡 + 3 开发者账号 + 6 上架作品
 *   （4 listed / 2 pending_review）+ listed 作品收益流水
 */
import { createHash, randomBytes, scryptSync } from "node:crypto";
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const conn = await mysql.createConnection(url);

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function sha256(plain: string): string {
  return createHash("sha256").update(plain, "utf8").digest("hex");
}

const DAY = 24 * 3600 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

// ── 1. 建表（IF NOT EXISTS，可重复执行）─────────────────────────────────────
const ddls: [string, string][] = [
  [
    "dev_accounts",
    `CREATE TABLE IF NOT EXISTS dev_accounts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      passwordHash VARCHAR(256) NOT NULL,
      displayName VARCHAR(64) NOT NULL,
      contact VARCHAR(128) NULL,
      status ENUM('active','suspended') NOT NULL DEFAULT 'active',
      authToken VARCHAR(64) NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY dev_accounts_username_uniq (username)
    )`,
  ],
  [
    "dev_listings",
    `CREATE TABLE IF NOT EXISTS dev_listings (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      devId BIGINT UNSIGNED NOT NULL,
      kind ENUM('agent','skill') NOT NULL,
      name VARCHAR(64) NOT NULL,
      summary VARCHAR(256) NULL,
      category VARCHAR(32) NULL,
      priceToken INT NOT NULL DEFAULT 0,
      icon VARCHAR(256) NULL,
      status ENUM('pending_review','listed','rejected','delisted') NOT NULL DEFAULT 'pending_review',
      usageCount INT NOT NULL DEFAULT 0,
      revenueToken INT NOT NULL DEFAULT 0,
      ratingSum INT NOT NULL DEFAULT 0,
      ratingCount INT NOT NULL DEFAULT 0,
      weeklyUsageTrend JSON NULL,
      listedAt TIMESTAMP NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX dev_listings_dev_idx (devId),
      INDEX dev_listings_status_idx (status)
    )`,
  ],
  [
    "dev_earnings",
    `CREATE TABLE IF NOT EXISTS dev_earnings (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      devId BIGINT UNSIGNED NOT NULL,
      listingId BIGINT UNSIGNED NULL,
      amountToken INT NOT NULL,
      source ENUM('usage','hire') NOT NULL,
      note VARCHAR(128) NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX dev_earnings_dev_idx (devId),
      INDEX dev_earnings_listing_idx (listingId)
    )`,
  ],
];

for (const [name, ddl] of ddls) {
  await conn.query(ddl);
  console.log(`${name}: table ok`);
}

// ── 2. master「灵枢智造研究院」（按 name 幂等）──────────────────────────────
let masterId: number;
{
  const [rows] = await conn.query(
    "SELECT id FROM masters WHERE name = ? LIMIT 1",
    ["灵枢智造研究院"],
  );
  const existing = (rows as { id: number }[])[0];
  if (existing) {
    masterId = existing.id;
    console.log(`masters: 灵枢智造研究院 exists (id=${masterId}), skip`);
  } else {
    const [res] = await conn.query(
      `INSERT INTO masters (name, signature, specialty, yearsExperience, title, reputation)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "灵枢智造研究院",
        "灵枢智造研究院 · 工业智能体官方认证",
        "工业智能体认证",
        12,
        "官方认证机构",
        98,
      ],
    );
    masterId = (res as { insertId: number }).insertId;
    console.log(`masters: seeded 灵枢智造研究院 (id=${masterId})`);
  }
}

// ── 3. 5 个旗舰数字员工（按 slug 幂等）───────────────────────────────────────
interface FlagshipAgent {
  slug: string;
  code: string;
  name: string;
  avatar: string;
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

const flagships: FlagshipAgent[] = [
  {
    slug: "haoshu",
    code: "ART-0101",
    name: "昊枢",
    avatar: "/avatar-haoshu.png",
    capabilityTags: ["工厂数字大脑", "老板Agent", "经营决策", "全域调度"],
    monthlyPrice: 19999,
    suggestedPrice: 24999,
    tasksCompleted: 1286,
    successRate: 99.2,
    avgRating: 4.9,
    ratingCount: 218,
    experienceMonths: 36,
    skillCount: 12,
    memoryCount: 620,
    weeklyHires: 14,
    weeklyHireTrend: [6, 8, 9, 10, 11, 12, 14],
    listedDaysAgo: 30,
    recommended: true,
  },
  {
    slug: "zizhu",
    code: "ART-0102",
    name: "锱铢",
    avatar: "/avatar-zizhu.png",
    capabilityTags: ["财务Agent", "成本核算", "应收应付", "税务合规"],
    monthlyPrice: 8999,
    suggestedPrice: 10999,
    tasksCompleted: 2360,
    successRate: 99.6,
    avgRating: 4.9,
    ratingCount: 342,
    experienceMonths: 30,
    skillCount: 9,
    memoryCount: 480,
    weeklyHires: 11,
    weeklyHireTrend: [5, 6, 7, 8, 9, 10, 11],
    listedDaysAgo: 26,
  },
  {
    slug: "qianxun",
    code: "ART-0103",
    name: "千询",
    avatar: "/avatar-qianxun.png",
    capabilityTags: ["采购Agent", "询价比价", "供应商管理", "合同审阅"],
    monthlyPrice: 7999,
    suggestedPrice: 9999,
    tasksCompleted: 1874,
    successRate: 98.8,
    avgRating: 4.8,
    ratingCount: 265,
    experienceMonths: 28,
    skillCount: 8,
    memoryCount: 410,
    weeklyHires: 9,
    weeklyHireTrend: [4, 5, 6, 6, 7, 8, 9],
    listedDaysAgo: 22,
  },
  {
    slug: "lanyue",
    code: "ART-0104",
    name: "揽月",
    avatar: "/avatar-lanyue.png",
    capabilityTags: ["销售Agent", "商机跟进", "报价生成", "客户洞察"],
    monthlyPrice: 7999,
    suggestedPrice: 9999,
    tasksCompleted: 2103,
    successRate: 98.5,
    avgRating: 4.8,
    ratingCount: 291,
    experienceMonths: 26,
    skillCount: 8,
    memoryCount: 390,
    weeklyHires: 10,
    weeklyHireTrend: [4, 6, 6, 7, 8, 9, 10],
    listedDaysAgo: 18,
  },
  {
    slug: "cuifeng",
    code: "ART-0105",
    name: "淬锋",
    avatar: "/avatar-cuifeng.png",
    capabilityTags: ["研发Agent", "工艺设计", "图纸解析", "BOM管理"],
    monthlyPrice: 9999,
    suggestedPrice: 12999,
    tasksCompleted: 1542,
    successRate: 99.0,
    avgRating: 4.9,
    ratingCount: 187,
    experienceMonths: 32,
    skillCount: 10,
    memoryCount: 450,
    weeklyHires: 8,
    weeklyHireTrend: [3, 4, 5, 6, 6, 7, 8],
    listedDaysAgo: 14,
  },
];

const agentIds: Record<string, number> = {};
for (const a of flagships) {
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
     (slug, code, name, avatar, industry, capabilityTags, masterId, status, delistRisk,
      monthlyPrice, suggestedPrice, tasksCompleted, successRate, avgRating, ratingCount,
      experienceMonths, skillCount, memoryCount, weeklyHires, weeklyHireTrend,
      recommended, certified, listedAt)
     VALUES (?, ?, ?, ?, '离散制造', CAST(? AS JSON), ?, 'active', false,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, true, ?)`,
    [
      a.slug,
      a.code,
      a.name,
      a.avatar,
      JSON.stringify(a.capabilityTags),
      masterId,
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
  console.log(`agents: seeded ${a.name}(${a.slug}, ${a.code})`);
}

// ── 4. 每旗舰 3-5 个 skill（按 agentId+name 幂等）────────────────────────────
interface SeedSkill {
  name: string;
  type: "V" | "U";
  complexity: number;
  pricePerCall: number;
  callCount: number;
  successRate: number;
  description: string;
}

const flagshipSkills: Record<string, SeedSkill[]> = {
  haoshu: [
    { name: "全域产线调度", type: "V", complexity: 5, pricePerCall: 320, callCount: 4120, successRate: 99.1, description: "跨车间工单排程与设备负载均衡，输出调度指令序列。" },
    { name: "经营指标看板解读", type: "U", complexity: 4, pricePerCall: 180, callCount: 3860, successRate: 99.4, description: "汇总产能/良品率/交付达成率，生成老板视角经营结论。" },
    { name: "异常升级决策", type: "U", complexity: 5, pricePerCall: 260, callCount: 2140, successRate: 98.9, description: "对产线异常按影响面分级，给出处置路径与升级建议。" },
    { name: "月度经营复盘", type: "V", complexity: 4, pricePerCall: 220, callCount: 980, successRate: 99.3, description: "自动生成月度经营复盘报告，含趋势与偏差归因。" },
    { name: "跨部门任务分派", type: "V", complexity: 4, pricePerCall: 200, callCount: 2650, successRate: 99.0, description: "按角色与负载将任务分派至各部门数字员工并跟踪闭环。" },
  ],
  zizhu: [
    { name: "成本卷积核算", type: "V", complexity: 5, pricePerCall: 240, callCount: 5230, successRate: 99.7, description: "按 BOM 与工时分层卷积，输出订单级成本明细。" },
    { name: "应收应付账龄分析", type: "U", complexity: 4, pricePerCall: 150, callCount: 4680, successRate: 99.6, description: "账龄分段与坏账风险提示，生成催收优先级清单。" },
    { name: "税务合规校验", type: "U", complexity: 5, pricePerCall: 280, callCount: 3120, successRate: 99.5, description: "进项销项匹配校验，标记申报异常项与整改建议。" },
    { name: "月度结账流水线", type: "V", complexity: 4, pricePerCall: 210, callCount: 1450, successRate: 99.6, description: "自动执行结账检查清单，输出差异调节表。" },
  ],
  qianxun: [
    { name: "多供应商询价比价", type: "V", complexity: 4, pricePerCall: 170, callCount: 4380, successRate: 98.9, description: "批量发起询价并归集报价，输出比价矩阵与推荐供应商。" },
    { name: "供应商绩效评分", type: "U", complexity: 3, pricePerCall: 120, callCount: 3560, successRate: 98.7, description: "按交付及时率/合格率/响应速度给供应商季度评分。" },
    { name: "采购合同条款审阅", type: "U", complexity: 5, pricePerCall: 260, callCount: 1890, successRate: 98.6, description: "识别付款/违约/交期条款风险点，给出修订建议。" },
    { name: "安全库存测算", type: "V", complexity: 4, pricePerCall: 140, callCount: 2740, successRate: 99.0, description: "按消耗波动与采购周期测算安全库存与补货点。" },
  ],
  lanyue: [
    { name: "商机跟进编排", type: "V", complexity: 4, pricePerCall: 160, callCount: 4920, successRate: 98.6, description: "按商机阶段自动生成跟进计划与提醒节奏。" },
    { name: "报价单智能生成", type: "V", complexity: 4, pricePerCall: 190, callCount: 3810, successRate: 98.8, description: "结合成本与竞争水位自动生成报价单与让利区间。" },
    { name: "客户画像洞察", type: "U", complexity: 3, pricePerCall: 130, callCount: 3270, successRate: 98.4, description: "汇总成交/拜访/工单数据生成客户画像与成交概率。" },
    { name: "赢单复盘归因", type: "U", complexity: 4, pricePerCall: 150, callCount: 1540, successRate: 98.5, description: "对赢单/输单案例做归因分析，沉淀打单打法。" },
  ],
  cuifeng: [
    { name: "工艺路线设计", type: "V", complexity: 5, pricePerCall: 280, callCount: 2980, successRate: 99.1, description: "按零件特征自动生成工艺路线与工序参数建议。" },
    { name: "图纸要素解析", type: "V", complexity: 5, pricePerCall: 240, callCount: 3420, successRate: 99.0, description: "解析二维图纸尺寸/公差/形位要素，结构化输出。" },
    { name: "BOM 一致性校验", type: "U", complexity: 4, pricePerCall: 170, callCount: 2610, successRate: 98.9, description: "校验设计 BOM 与制造 BOM 差异，标记缺漏件。" },
    { name: "可制造性评审", type: "U", complexity: 5, pricePerCall: 260, callCount: 1330, successRate: 98.8, description: "对新设计做可制造性评审，输出风险清单与改进建议。" },
    { name: "工艺知识沉淀", type: "V", complexity: 3, pricePerCall: 110, callCount: 1980, successRate: 99.2, description: "将试制问题与对策沉淀为工艺知识条目。" },
  ],
};

for (const [slug, skillList] of Object.entries(flagshipSkills)) {
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

// ── 5. wb_evo_identities 5 条（按 did 幂等；factoryId=0 表示平台级，无工厂归属）──
for (const a of flagships) {
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
        issuedBy: "灵枢智造研究院",
        trustLevel: 3,
      }),
    ],
  );
  console.log(`wb_evo_identities: seeded ${did}`);
}

// ── 6. 3 个开发者账号（按 username 幂等，不重置密码/token）───────────────────
const seedDevs = [
  { username: "dev_chen", displayName: "陈工·工业视觉", contact: null as string | null },
  { username: "dev_lin", displayName: "林晚·流程自动化", contact: null as string | null },
  { username: "dev_su", displayName: "苏子航·数据洞察", contact: null as string | null },
];

const devIds: Record<string, number> = {};
for (const d of seedDevs) {
  const [rows] = await conn.query(
    "SELECT id FROM dev_accounts WHERE username = ? LIMIT 1",
    [d.username],
  );
  const existing = (rows as { id: number }[])[0];
  if (existing) {
    devIds[d.username] = existing.id;
    console.log(`dev_accounts: ${d.username} exists (id=${existing.id}), skip（不重置密码/token）`);
    continue;
  }
  const [res] = await conn.query(
    `INSERT INTO dev_accounts (username, passwordHash, displayName, contact, status)
     VALUES (?, ?, ?, ?, 'active')`,
    [d.username, hashPassword("Dev123456"), d.displayName, d.contact],
  );
  devIds[d.username] = (res as { insertId: number }).insertId;
  console.log(`dev_accounts: seeded ${d.username}（${d.displayName}）`);
}

// ── 7. 6 个上架作品（按 devId+name 幂等）─────────────────────────────────────
interface SeedListing {
  dev: string;
  kind: "agent" | "skill";
  name: string;
  summary: string;
  category: string;
  priceToken: number;
  status: "listed" | "pending_review";
  usageCount?: number;
  revenueToken?: number;
  ratingSum?: number;
  ratingCount?: number;
  weeklyUsageTrend?: number[];
  listedDaysAgo?: number;
}

const seedListings: SeedListing[] = [
  {
    dev: "dev_chen", kind: "agent", name: "焊点缺陷视觉检测 Agent",
    summary: "面向焊装产线的焊点缺陷在线检测数字员工，支持气孔/虚焊/偏焊分级与返修指引。",
    category: "质检视觉", priceToken: 1200, status: "listed",
    usageCount: 532, revenueToken: 8640, ratingSum: 179, ratingCount: 38,
    weeklyUsageTrend: [42, 51, 58, 66, 71, 83, 96], listedDaysAgo: 20,
  },
  {
    dev: "dev_chen", kind: "skill", name: "OCR 工单识别 Skill",
    summary: "纸质工单拍照转结构化数据，适配手写体与油污模糊场景，秒级回填系统。",
    category: "数据采集", priceToken: 180, status: "listed",
    usageCount: 2103, revenueToken: 3154, ratingSum: 239, ratingCount: 52,
    weeklyUsageTrend: [210, 246, 272, 301, 335, 368, 402], listedDaysAgo: 18,
  },
  {
    dev: "dev_lin", kind: "skill", name: "设备巡检日报 Skill",
    summary: "按巡检点位自动汇总设备状态，生成标准日报并推送设备主管。",
    category: "设备管理", priceToken: 90, status: "listed",
    usageCount: 1180, revenueToken: 1593, ratingSum: 307, ratingCount: 64,
    weeklyUsageTrend: [96, 110, 128, 143, 159, 176, 194], listedDaysAgo: 12,
  },
  {
    dev: "dev_su", kind: "agent", name: "产线能耗洞察 Agent",
    summary: "接入能耗计量数据，识别异常耗能时段与设备空转，输出节能改造建议。",
    category: "能源管理", priceToken: 960, status: "listed",
    usageCount: 305, revenueToken: 4024, ratingSum: 103, ratingCount: 21,
    weeklyUsageTrend: [18, 24, 29, 35, 41, 48, 56], listedDaysAgo: 8,
  },
  {
    dev: "dev_lin", kind: "agent", name: "AGV 调度助手 Agent",
    summary: "车间 AGV 任务派发与路径协同，支持与现有 WMS 对接。",
    category: "物流调度", priceToken: 1500, status: "pending_review",
  },
  {
    dev: "dev_su", kind: "skill", name: "刀具寿命预测 Skill",
    summary: "基于切削负载与材料批次预测刀具剩余寿命，提前触发换刀工单。",
    category: "设备管理", priceToken: 220, status: "pending_review",
  },
];

const listingIds: Record<string, number> = {};
const listingDevIds: Record<string, number> = {};
for (const l of seedListings) {
  const devId = devIds[l.dev];
  const [dup] = await conn.query(
    "SELECT id FROM dev_listings WHERE devId = ? AND name = ? LIMIT 1",
    [devId, l.name],
  );
  const existing = (dup as { id: number }[])[0];
  if (existing) {
    listingIds[l.name] = existing.id;
    listingDevIds[l.name] = devId;
    console.log(`dev_listings: 「${l.name}」exists, skip`);
    continue;
  }
  const [res] = await conn.query(
    `INSERT INTO dev_listings
     (devId, kind, name, summary, category, priceToken, status,
      usageCount, revenueToken, ratingSum, ratingCount, weeklyUsageTrend, listedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?)`,
    [
      devId,
      l.kind,
      l.name,
      l.summary,
      l.category,
      l.priceToken,
      l.status,
      l.usageCount ?? 0,
      l.revenueToken ?? 0,
      l.ratingSum ?? 0,
      l.ratingCount ?? 0,
      JSON.stringify(l.weeklyUsageTrend ?? [0, 0, 0, 0, 0, 0, 0]),
      l.status === "listed" ? daysAgo(l.listedDaysAgo ?? 7) : null,
    ],
  );
  listingIds[l.name] = (res as { insertId: number }).insertId;
  listingDevIds[l.name] = devId;
  console.log(`dev_listings: seeded 「${l.name}」(${l.kind}/${l.status})`);
}

// ── 8. 收益流水（每个 listed listing 5-10 条；已有流水则跳过）────────────────
const earningSeeds: {
  listing: string;
  parts: number[]; // 权重，按 revenueToken 折算
  notes: string[];
}[] = [
  {
    listing: "焊点缺陷视觉检测 Agent",
    parts: [980, 1050, 1120, 1180, 1090, 1130, 1040, 1050],
    notes: [
      "星云华东工厂·调用结算", "华辰精工·调用结算", "蓝岭汽配·调用结算",
      "星云苏州工厂·调用结算", "恒力锻压·调用结算", "明川机械·调用结算",
      "星云华东工厂·调用结算", "启源重工·调用结算",
    ],
  },
  {
    listing: "OCR 工单识别 Skill",
    parts: [420, 460, 390, 450, 410, 480, 544],
    notes: [
      "华辰精工·调用结算", "星云华东工厂·调用结算", "蓝岭汽配·调用结算",
      "明川机械·调用结算", "恒力锻压·调用结算", "启源重工·调用结算",
      "星云苏州工厂·调用结算",
    ],
  },
  {
    listing: "设备巡检日报 Skill",
    parts: [180, 210, 230, 250, 240, 243, 240],
    notes: [
      "星云华东工厂·调用结算", "华辰精工·调用结算", "明川机械·调用结算",
      "蓝岭汽配·调用结算", "恒力锻压·调用结算", "星云苏州工厂·调用结算",
      "启源重工·调用结算",
    ],
  },
  {
    listing: "产线能耗洞察 Agent",
    parts: [520, 560, 610, 640, 580, 560, 554],
    notes: [
      "星云华东工厂·调用结算", "启源重工·调用结算", "华辰精工·调用结算",
      "蓝岭汽配·调用结算", "星云苏州工厂·调用结算", "明川机械·调用结算",
      "恒力锻压·调用结算",
    ],
  },
];

for (const e of earningSeeds) {
  const listingId = listingIds[e.listing];
  const devId = listingDevIds[e.listing];
  const [cnt] = await conn.query(
    "SELECT COUNT(*) AS c FROM dev_earnings WHERE listingId = ?",
    [listingId],
  );
  if (Number((cnt as { c: number }[])[0].c) > 0) {
    console.log(`dev_earnings: 「${e.listing}」已有流水, skip`);
    continue;
  }
  const n = e.parts.length;
  for (let i = 0; i < n; i++) {
    // createdAt 近 20 天分布（旧 → 新）
    const createdAt = daysAgo(Math.max(1, Math.round((20 * (n - 1 - i)) / n)));
    await conn.query(
      `INSERT INTO dev_earnings (devId, listingId, amountToken, source, note, createdAt)
       VALUES (?, ?, ?, 'usage', ?, ?)`,
      [devId, listingId, e.parts[i], e.notes[i % e.notes.length], createdAt],
    );
  }
  console.log(`dev_earnings: seeded 「${e.listing}」${n} 条流水`);
}

// ── 9. 汇总 ──────────────────────────────────────────────────────────────────
const checks: [string, string][] = [
  ["agents(flagship)", "SELECT COUNT(*) AS c FROM agents WHERE slug IN ('haoshu','zizhu','qianxun','lanyue','cuifeng')"],
  ["dev_accounts", "SELECT COUNT(*) AS c FROM dev_accounts"],
  ["dev_listings", "SELECT COUNT(*) AS c FROM dev_listings"],
  ["dev_listings(listed)", "SELECT COUNT(*) AS c FROM dev_listings WHERE status='listed'"],
  ["dev_listings(pending_review)", "SELECT COUNT(*) AS c FROM dev_listings WHERE status='pending_review'"],
  ["dev_earnings", "SELECT COUNT(*) AS c FROM dev_earnings"],
  ["wb_evo_identities(flagship)", "SELECT COUNT(*) AS c FROM wb_evo_identities WHERE did LIKE 'did:nebula:agent-%'"],
];
for (const [label, q] of checks) {
  const [rows] = await conn.query(q);
  console.log(`${label}: ${(rows as { c: number }[])[0].c} row(s)`);
}

await conn.end();
console.log("sync-dev-ecosystem done.");
