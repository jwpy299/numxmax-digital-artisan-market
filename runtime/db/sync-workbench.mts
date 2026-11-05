/**
 * 幂等同步灵枢星云智能工作台数据表（wb_ 前缀）+ 演示种子。
 * TiDB 下 drizzle-kit push 不可用，故用 mysql2 直连（参照 sync-applications.mts 模式）。
 * 用法：DATABASE_URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2-) npx tsx db/sync-workbench.mts
 * - CREATE TABLE IF NOT EXISTS ×9（wb_users/wb_factories/wb_dept_heads/wb_tickets/
 *   wb_publish_keys/wb_listings/wb_contracts/wb_showroom/wb_showroom_products）
 * - 幂等种子：演示工厂「华辰精工」+ 3 用户（demo/zhangwei/lijing，scrypt 哈希；
 *   已存在则跳过，不重置密码/token）+ 4 listings + 1 pending 合同 + showroom learning
 */
import { randomBytes, scryptSync } from "node:crypto";
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

// ── 1. 建表（IF NOT EXISTS，可重复执行）─────────────────────────────────────
const ddls: [string, string][] = [
  [
    "wb_users",
    `CREATE TABLE IF NOT EXISTS wb_users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      passwordHash VARCHAR(255) NOT NULL,
      displayName VARCHAR(64) NOT NULL,
      role ENUM('admin','owner','member') NOT NULL DEFAULT 'member',
      factoryId BIGINT UNSIGNED NOT NULL,
      departmentId VARCHAR(64) NULL,
      authToken VARCHAR(80) NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY wb_users_username_uniq (username)
    )`,
  ],
  [
    "wb_factories",
    `CREATE TABLE IF NOT EXISTS wb_factories (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      enterpriseName VARCHAR(128) NOT NULL,
      industry VARCHAR(64) NOT NULL,
      industryText VARCHAR(128) NULL,
      headcount VARCHAR(32) NOT NULL,
      departments JSON NOT NULL,
      painPoints TEXT NULL,
      profile JSON NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  ],
  [
    "wb_dept_heads",
    `CREATE TABLE IF NOT EXISTS wb_dept_heads (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      factoryId BIGINT UNSIGNED NOT NULL,
      deptId VARCHAR(64) NOT NULL,
      userId BIGINT UNSIGNED NOT NULL,
      routineLimit INT NULL,
      INDEX wb_dept_heads_factory_idx (factoryId)
    )`,
  ],
  [
    "wb_tickets",
    `CREATE TABLE IF NOT EXISTS wb_tickets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      ticketHash VARCHAR(64) NOT NULL,
      userId BIGINT UNSIGNED NOT NULL,
      factoryId BIGINT UNSIGNED NOT NULL,
      target VARCHAR(32) NOT NULL DEFAULT '/dept',
      source VARCHAR(64) NOT NULL DEFAULT 'craftsman-market',
      expiresAt TIMESTAMP NOT NULL,
      consumedAt TIMESTAMP NULL,
      UNIQUE KEY wb_tickets_hash_uniq (ticketHash),
      INDEX wb_tickets_user_idx (userId)
    )`,
  ],
  [
    "wb_publish_keys",
    `CREATE TABLE IF NOT EXISTS wb_publish_keys (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      keyHash VARCHAR(64) NOT NULL,
      factoryId BIGINT UNSIGNED NOT NULL,
      assetType ENUM('skill','agent','both') NOT NULL,
      expiresAt TIMESTAMP NOT NULL,
      revokedAt TIMESTAMP NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX wb_publish_keys_factory_idx (factoryId),
      INDEX wb_publish_keys_hash_idx (keyHash)
    )`,
  ],
  [
    "wb_listings",
    `CREATE TABLE IF NOT EXISTS wb_listings (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      factoryId BIGINT UNSIGNED NOT NULL,
      type ENUM('skill','agent') NOT NULL,
      title VARCHAR(128) NOT NULL,
      category VARCHAR(64) NULL,
      capabilities JSON NULL,
      description TEXT NOT NULL,
      delivery VARCHAR(128) NULL,
      employmentType VARCHAR(64) NULL,
      pricingModel VARCHAR(64) NOT NULL,
      price INT NOT NULL,
      accuracy DOUBLE NULL,
      operator VARCHAR(64) NULL,
      status ENUM('pending','listed','rejected') NOT NULL DEFAULT 'pending',
      hires INT NOT NULL DEFAULT 0,
      decidedBy BIGINT UNSIGNED NULL,
      decidedAt TIMESTAMP NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX wb_listings_factory_idx (factoryId),
      INDEX wb_listings_status_idx (status)
    )`,
  ],
  [
    "wb_contracts",
    `CREATE TABLE IF NOT EXISTS wb_contracts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      factoryId BIGINT UNSIGNED NOT NULL,
      listingId BIGINT UNSIGNED NOT NULL,
      roleScope VARCHAR(128) NOT NULL,
      workMode VARCHAR(64) NOT NULL,
      trialDays INT NULL,
      note TEXT NULL,
      status ENUM('pending','active','rejected') NOT NULL DEFAULT 'pending',
      decidedBy BIGINT UNSIGNED NULL,
      decidedAt TIMESTAMP NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX wb_contracts_factory_idx (factoryId),
      INDEX wb_contracts_listing_idx (listingId)
    )`,
  ],
  [
    "wb_showroom",
    `CREATE TABLE IF NOT EXISTS wb_showroom (
      factoryId BIGINT UNSIGNED NOT NULL PRIMARY KEY,
      status ENUM('learning','pending_confirm','published','rejected') NOT NULL DEFAULT 'learning',
      score INT NOT NULL DEFAULT 0,
      metrics JSON NULL,
      thresholds JSON NULL,
      requestedAt TIMESTAMP NULL,
      decidedAt TIMESTAMP NULL,
      productCount INT NOT NULL DEFAULT 0
    )`,
  ],
  [
    "wb_showroom_products",
    `CREATE TABLE IF NOT EXISTS wb_showroom_products (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      factoryId BIGINT UNSIGNED NOT NULL,
      title VARCHAR(128) NOT NULL,
      category VARCHAR(64) NULL,
      price INT NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX wb_showroom_products_factory_idx (factoryId)
    )`,
  ],
  [
    "wb_role_agents",
    `CREATE TABLE IF NOT EXISTS wb_role_agents (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      factoryId BIGINT UNSIGNED NOT NULL,
      role VARCHAR(64) NOT NULL,
      deptName VARCHAR(64) NOT NULL,
      agentId BIGINT UNSIGNED NULL,
      agentName VARCHAR(128) NOT NULL,
      agentSource ENUM('market','listing') NOT NULL,
      assignedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX wb_role_agents_factory_idx (factoryId)
    )`,
  ],
  [
    "wb_symbiosis_events",
    `CREATE TABLE IF NOT EXISTS wb_symbiosis_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      factoryId BIGINT UNSIGNED NOT NULL,
      title VARCHAR(128) NOT NULL,
      chain JSON NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX wb_symbiosis_events_factory_idx (factoryId)
    )`,
  ],
  [
    "wb_evo_memories",
    `CREATE TABLE IF NOT EXISTS wb_evo_memories (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      agentId BIGINT UNSIGNED NOT NULL,
      factoryId BIGINT UNSIGNED NOT NULL,
      store ENUM('events','entities','insights','domain','cases') NOT NULL,
      content JSON NOT NULL,
      embedding JSON NOT NULL,
      severity INT NOT NULL DEFAULT 3,
      validUntil TIMESTAMP NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX wb_evo_memories_agent_idx (agentId),
      INDEX wb_evo_memories_factory_idx (factoryId),
      INDEX wb_evo_memories_store_idx (store)
    )`,
  ],
  [
    "wb_evo_identities",
    `CREATE TABLE IF NOT EXISTS wb_evo_identities (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      did VARCHAR(128) NOT NULL,
      agentId BIGINT UNSIGNED NOT NULL,
      factoryId BIGINT UNSIGNED NOT NULL,
      keyState ENUM('NULL','ADDED','REMOVED') NOT NULL DEFAULT 'ADDED',
      quota INT NOT NULL DEFAULT 1000,
      blockHash VARCHAR(64) NOT NULL,
      prevHash VARCHAR(64) NOT NULL,
      blockHeight INT NOT NULL,
      card JSON NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY wb_evo_identities_did_uniq (did),
      INDEX wb_evo_identities_agent_idx (agentId),
      INDEX wb_evo_identities_factory_idx (factoryId)
    )`,
  ],
  [
    "wb_evo_plans",
    `CREATE TABLE IF NOT EXISTS wb_evo_plans (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      planId VARCHAR(64) NOT NULL,
      factoryId BIGINT UNSIGNED NOT NULL,
      agentId BIGINT UNSIGNED NOT NULL,
      goal VARCHAR(512) NOT NULL,
      schedule JSON NOT NULL,
      reasoning JSON NOT NULL,
      status ENUM('awaiting_confirm','executing','done','expired_rejected','rejected','exempted_auto') NOT NULL DEFAULT 'awaiting_confirm',
      confirmDeadline TIMESTAMP NULL,
      trustLevel INT NOT NULL DEFAULT 0,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY wb_evo_plans_planid_uniq (planId),
      INDEX wb_evo_plans_factory_idx (factoryId),
      INDEX wb_evo_plans_agent_idx (agentId)
    )`,
  ],
  [
    "wb_evo_trust",
    `CREATE TABLE IF NOT EXISTS wb_evo_trust (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      agentId BIGINT UNSIGNED NOT NULL,
      level INT NOT NULL DEFAULT 0,
      consecutiveApprovals INT NOT NULL DEFAULT 0,
      totalPlans INT NOT NULL DEFAULT 0,
      history JSON NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY wb_evo_trust_agent_uniq (agentId)
    )`,
  ],
];

for (const [name, ddl] of ddls) {
  await conn.query(ddl);
  console.log(`${name}: table ok`);
}

// ── 2. 种子：演示工厂「华辰精工」────────────────────────────────────────────
const DEPARTMENTS = [
  { id: "d1", name: "生产部" },
  { id: "d2", name: "质检部" },
  { id: "d3", name: "设备部" },
];

let factoryId: number;
{
  const [rows] = await conn.query(
    "SELECT id FROM wb_factories WHERE enterpriseName = ? LIMIT 1",
    ["华辰精工"],
  );
  const existing = (rows as { id: number }[])[0];
  if (existing) {
    factoryId = existing.id;
    console.log(`wb_factories: 华辰精工 exists (id=${factoryId}), skip`);
  } else {
    const [res] = await conn.query(
      `INSERT INTO wb_factories
       (enterpriseName, industry, industryText, headcount, departments, painPoints, profile)
       VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, CAST(? AS JSON))`,
      [
        "华辰精工",
        "机械制造",
        "精密机械零部件加工",
        "200-500",
        JSON.stringify(DEPARTMENTS),
        "数控设备振动故障定位慢、焊缝质检依赖老师傅经验、设备保养计划靠人工排程。",
        JSON.stringify({ source: "craftsman-market", seed: true }),
      ],
    );
    factoryId = (res as { insertId: number }).insertId;
    console.log(`wb_factories: seeded 华辰精工 (id=${factoryId})`);
  }
}

// ── 3. 种子：3 个用户（已存在则跳过，不重置密码/token）───────────────────────
const seedUsers = [
  {
    username: "demo",
    password: "demo123456",
    displayName: "华辰主管",
    role: "admin",
    departmentId: null as string | null,
  },
  {
    username: "zhangwei",
    password: "demo123456",
    displayName: "张伟",
    role: "member",
    departmentId: "d1", // 生产部
  },
  {
    username: "lijing",
    password: "demo123456",
    displayName: "李静",
    role: "owner",
    departmentId: "d2", // 质检部
  },
];

const userIds: Record<string, number> = {};
for (const u of seedUsers) {
  const [rows] = await conn.query(
    "SELECT id FROM wb_users WHERE username = ? LIMIT 1",
    [u.username],
  );
  const existing = (rows as { id: number }[])[0];
  if (existing) {
    userIds[u.username] = existing.id;
    console.log(`wb_users: ${u.username} exists (id=${existing.id}), skip（不重置密码/token）`);
    continue;
  }
  const [res] = await conn.query(
    `INSERT INTO wb_users (username, passwordHash, displayName, role, factoryId, departmentId)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [u.username, hashPassword(u.password), u.displayName, u.role, factoryId, u.departmentId],
  );
  userIds[u.username] = (res as { insertId: number }).insertId;
  console.log(`wb_users: seeded ${u.username} (${u.role})`);
}

// ── 4. 种子：李静 = 质检部 dept_head ─────────────────────────────────────────
{
  const [dup] = await conn.query(
    "SELECT id FROM wb_dept_heads WHERE factoryId = ? AND deptId = ? AND userId = ? LIMIT 1",
    [factoryId, "d2", userIds.lijing],
  );
  if ((dup as unknown[]).length > 0) {
    console.log("wb_dept_heads: 李静/质检部 exists, skip");
  } else {
    await conn.query(
      "INSERT INTO wb_dept_heads (factoryId, deptId, userId, routineLimit) VALUES (?, ?, ?, ?)",
      [factoryId, "d2", userIds.lijing, 20],
    );
    console.log("wb_dept_heads: seeded 李静 → 质检部（routineLimit=20）");
  }
}

// ── 5. 种子：4 条 listings（2 skill 1 listed+1 pending；2 agent 1 listed+1 pending）
const seedListings = [
  {
    type: "skill",
    title: "主轴振动频谱诊断技能",
    status: "listed",
    category: "设备诊断",
    description: "对数控机床主轴振动信号做频谱分析，定位不平衡/不对中/轴承损伤，输出故障类型与置信度。",
    delivery: "API 实时调用",
    pricingModel: "per_call",
    price: 120,
    accuracy: 96.5,
    operator: "华辰精工设备部",
    capabilities: null as string[] | null,
    employmentType: null as string | null,
  },
  {
    type: "skill",
    title: "焊缝外观质检技能",
    status: "pending",
    category: "质量检测",
    description: "基于视觉图像对焊缝外观缺陷（气孔/咬边/焊瘤）分级，辅助质检员二次判读。",
    delivery: "批量图像上传",
    pricingModel: "per_call",
    price: 80,
    accuracy: 93.2,
    operator: "华辰精工质检部",
    capabilities: null,
    employmentType: null,
  },
  {
    type: "agent",
    title: "设备振动诊断智能体",
    status: "listed",
    category: "智能体",
    description: "7×24 值守的设备健康诊断数字工匠：接入振动传感器数据，自动生成健康基线与劣化趋势报告。",
    delivery: null,
    pricingModel: "monthly",
    price: 12800,
    accuracy: null as number | null,
    operator: "华辰精工设备部",
    capabilities: ["振动诊断", "故障预测", "健康基线报告"],
    employmentType: "长期雇佣",
  },
  {
    type: "agent",
    title: "焊缝质检智能体",
    status: "pending",
    category: "智能体",
    description: "面向压力容器/结构件焊缝的在线质检数字工匠，缺陷分级与返修建议单次 5 分钟内输出。",
    delivery: null,
    pricingModel: "monthly",
    price: 9600,
    accuracy: null,
    operator: "华辰精工质检部",
    capabilities: ["焊缝质检", "缺陷分级", "返修建议"],
    employmentType: "项目制",
  },
];

const listingIds: Record<string, number> = {};
for (const l of seedListings) {
  const [dup] = await conn.query(
    "SELECT id FROM wb_listings WHERE factoryId = ? AND title = ? LIMIT 1",
    [factoryId, l.title],
  );
  const existing = (dup as { id: number }[])[0];
  if (existing) {
    listingIds[l.title] = existing.id;
    console.log(`wb_listings: 「${l.title}」exists, skip`);
    continue;
  }
  const [res] = await conn.query(
    `INSERT INTO wb_listings
     (factoryId, type, title, category, capabilities, description, delivery, employmentType,
      pricingModel, price, accuracy, operator, status, decidedAt)
     VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      factoryId,
      l.type,
      l.title,
      l.category,
      l.capabilities ? JSON.stringify(l.capabilities) : null,
      l.description,
      l.delivery,
      l.employmentType,
      l.pricingModel,
      l.price,
      l.accuracy,
      l.operator,
      l.status,
      l.status === "listed" ? new Date() : null,
    ],
  );
  listingIds[l.title] = (res as { insertId: number }).insertId;
  console.log(`wb_listings: seeded 「${l.title}」(${l.type}/${l.status})`);
}

// ── 6. 种子：1 条 pending 合同（雇主=华辰精工，目标=已上架智能体）────────────
{
  const listingId = listingIds["设备振动诊断智能体"];
  const [dup] = await conn.query(
    "SELECT id FROM wb_contracts WHERE factoryId = ? AND listingId = ? LIMIT 1",
    [factoryId, listingId],
  );
  if ((dup as unknown[]).length > 0) {
    console.log("wb_contracts: pending 合同 exists, skip");
  } else {
    await conn.query(
      `INSERT INTO wb_contracts (factoryId, listingId, roleScope, workMode, trialDays, note, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [
        factoryId,
        listingId,
        "数控一车间设备健康诊断",
        "7×24 远程值守",
        14,
        "先试用两周，覆盖 12 台加工中心健康基线建档。",
      ],
    );
    console.log("wb_contracts: seeded pending 合同（设备振动诊断智能体）");
  }
}

// ── 7. 种子：showroom 初始 learning 状态 ────────────────────────────────────
{
  const [dup] = await conn.query(
    "SELECT factoryId FROM wb_showroom WHERE factoryId = ? LIMIT 1",
    [factoryId],
  );
  if ((dup as unknown[]).length > 0) {
    console.log("wb_showroom: exists, skip");
  } else {
    await conn.query(
      `INSERT INTO wb_showroom (factoryId, status, score, metrics, thresholds)
       VALUES (?, 'learning', 100, CAST(? AS JSON), CAST(? AS JSON))`,
      [
        factoryId,
        JSON.stringify({ memberCount: 3, departmentCount: 3, listedCount: 2 }),
        JSON.stringify({ memberCount: 3, departmentCount: 2, listedCount: 1, readyScore: 80 }),
      ],
    );
    console.log("wb_showroom: seeded learning 状态（score=100）");
  }
}

// ── 8. 汇总 ──────────────────────────────────────────────────────────────────
for (const [name] of ddls) {
  const [rows] = await conn.query(`SELECT COUNT(*) AS c FROM ${name}`);
  console.log(`${name}: total ${(rows as { c: number }[])[0].c} row(s)`);
}

await conn.end();
console.log("sync-workbench done.");
