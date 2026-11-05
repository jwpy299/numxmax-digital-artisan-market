/**
 * 幂等同步 recruitment_applications 表（TiDB 下 drizzle-kit push 不可用，故用 mysql2 直连）。
 * 用法：DATABASE_URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2-) npx tsx db/sync-applications.mts
 * - CREATE TABLE IF NOT EXISTS
 * - 逐列/逐索引检查，缺失才 ALTER（可重复执行）
 * - agents.status 枚举补 'rejected'（审核驳回态）
 * - 幂等种子：为华辰精工的招募单预置 pending 应征（按 recruitmentId+agentId 判重）
 */
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const conn = await mysql.createConnection(url);

async function columnExists(table: string, column: string) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return (rows as { c: number }[])[0].c > 0;
}

async function indexExists(table: string, index: string) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, index],
  );
  return (rows as { c: number }[])[0].c > 0;
}

// ── 0. agents.status 枚举补 'rejected'（审核驳回态）─────────────────────────
const [statusCols] = await conn.query(
  `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agents' AND COLUMN_NAME = 'status'`,
);
const columnType = (statusCols as { t: string }[])[0]?.t ?? "";
if (columnType && !columnType.includes("'rejected'")) {
  await conn.query(
    `ALTER TABLE agents MODIFY COLUMN status ENUM('pending','active','suspended','rejected') NOT NULL DEFAULT 'active'`,
  );
  console.log("agents: status enum extended with 'rejected'");
} else {
  console.log("agents: status enum ok");
}

// ── 1. 建表 ──────────────────────────────────────────────────────────────────
await conn.query(`
  CREATE TABLE IF NOT EXISTS recruitment_applications (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    recruitmentId BIGINT UNSIGNED NOT NULL,
    agentId BIGINT UNSIGNED NOT NULL,
    applicantUserId BIGINT UNSIGNED NULL,
    message TEXT NOT NULL,
    status ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
    decidedAt TIMESTAMP NULL,
    createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
console.log("recruitment_applications: table ok");

// ── 2. 补列（老版本表存在但缺列时）──────────────────────────────────────────
const columns: [string, string][] = [
  ["recruitmentId", "ALTER TABLE recruitment_applications ADD COLUMN recruitmentId BIGINT UNSIGNED NOT NULL AFTER id"],
  ["agentId", "ALTER TABLE recruitment_applications ADD COLUMN agentId BIGINT UNSIGNED NOT NULL AFTER recruitmentId"],
  ["applicantUserId", "ALTER TABLE recruitment_applications ADD COLUMN applicantUserId BIGINT UNSIGNED NULL AFTER agentId"],
  ["message", "ALTER TABLE recruitment_applications ADD COLUMN message TEXT NOT NULL"],
  ["status", "ALTER TABLE recruitment_applications ADD COLUMN status ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending'"],
  ["decidedAt", "ALTER TABLE recruitment_applications ADD COLUMN decidedAt TIMESTAMP NULL"],
  ["createdAt", "ALTER TABLE recruitment_applications ADD COLUMN createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP"],
];
for (const [col, ddl] of columns) {
  if (!(await columnExists("recruitment_applications", col))) {
    await conn.query(ddl);
    console.log(`recruitment_applications: added column ${col}`);
  }
}

// ── 3. 补索引 ────────────────────────────────────────────────────────────────
const indexes: [string, string][] = [
  ["applications_recruitment_idx", "ALTER TABLE recruitment_applications ADD INDEX applications_recruitment_idx (recruitmentId)"],
  ["applications_agent_idx", "ALTER TABLE recruitment_applications ADD INDEX applications_agent_idx (agentId)"],
  ["applications_applicant_idx", "ALTER TABLE recruitment_applications ADD INDEX applications_applicant_idx (applicantUserId)"],
  ["applications_status_idx", "ALTER TABLE recruitment_applications ADD INDEX applications_status_idx (status)"],
];
for (const [idx, ddl] of indexes) {
  if (!(await indexExists("recruitment_applications", idx))) {
    await conn.query(ddl);
    console.log(`recruitment_applications: added index ${idx}`);
  }
}

// ── 4. 幂等种子（按 recruitmentId + agentId 判重）────────────────────────────
// 为华辰精工（enterpriseId=1）在招的招募单预置 pending 应征，关联现有 Agent。
const seeds = [
  {
    recruitmentTitle: "急招：数控车间振动诊断数字工匠",
    agentSlug: "zhenheng", // 振衡
    message:
      "振衡应征：32 年数控设备经验沉淀，擅长主轴/丝杠振动频谱分析与动平衡校正，可按 7×24 值守模式接入贵司 CNC 一车间，首月交付 12 台加工中心健康基线报告。",
  },
  {
    recruitmentTitle: "急招：数控车间振动诊断数字工匠",
    agentSlug: "celu", // 策炉（跨领域自荐，作为对比项）
    message:
      "策炉自荐：热处理工艺优化为主业，同时具备设备劣化趋势研判能力，可配合振动类工匠做炉-机联动分析，愿以副岗身份参与。",
  },
  {
    recruitmentTitle: "热处理炉温曲线优化顾问（长期）",
    agentSlug: "celu", // 策炉
    message:
      "策炉应征：专注模具钢热处理十五年，可基于历史炉温曲线做工艺参数寻优，承诺三个月内将批次合格率稳定至 97% 以上，并接受按季度复盘调价。",
  },
  {
    recruitmentTitle: "招募焊缝质量在线评估 Agent",
    agentSlug: "chimou", // 炽眸
    message:
      "炽眸应征：压力容器焊缝 RT/UT 二次判读经验丰富，缺陷分级与返修建议单次 5 分钟内输出，可先试用一周再签约。",
  },
];

let inserted = 0;
for (const s of seeds) {
  const [recRows] = await conn.query(
    "SELECT id FROM recruitments WHERE title = ? LIMIT 1",
    [s.recruitmentTitle],
  );
  const recruitmentId = (recRows as { id: number }[])[0]?.id;
  if (!recruitmentId) {
    console.log(`recruitment_applications: skip (recruitment not found) ${s.recruitmentTitle}`);
    continue;
  }
  const [agentRows] = await conn.query(
    "SELECT id FROM agents WHERE slug = ? LIMIT 1",
    [s.agentSlug],
  );
  const agentId = (agentRows as { id: number }[])[0]?.id;
  if (!agentId) {
    console.log(`recruitment_applications: skip (agent not found) ${s.agentSlug}`);
    continue;
  }
  const [dup] = await conn.query(
    "SELECT id FROM recruitment_applications WHERE recruitmentId = ? AND agentId = ? LIMIT 1",
    [recruitmentId, agentId],
  );
  if ((dup as unknown[]).length > 0) continue;
  await conn.query(
    `INSERT INTO recruitment_applications (recruitmentId, agentId, applicantUserId, message, status)
     VALUES (?, ?, NULL, ?, 'pending')`,
    [recruitmentId, agentId, s.message],
  );
  inserted++;
}
console.log(`recruitment_applications: seeded ${inserted} row(s) (skipped existing)`);

const [count] = await conn.query(
  "SELECT COUNT(*) AS c FROM recruitment_applications",
);
console.log(
  `recruitment_applications: total ${(count as { c: number }[])[0].c} row(s)`,
);

await conn.end();
console.log("sync-applications done.");
