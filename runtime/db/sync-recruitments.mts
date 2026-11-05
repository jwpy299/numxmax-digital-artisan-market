/**
 * 幂等同步 recruitments 表（TiDB 下 drizzle-kit push 不可用，故用 mysql2 直连）。
 * 用法：DATABASE_URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2-) npx tsx db/sync-recruitments.mts
 * - CREATE TABLE IF NOT EXISTS
 * - 逐列/逐索引检查，缺失才 ALTER（可重复执行）
 * - 幂等种子：为示范企业「华辰精工」(id=1) 预置招募单（按 title 判重）
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

// ── 1. 建表 ──────────────────────────────────────────────────────────────────
await conn.query(`
  CREATE TABLE IF NOT EXISTS recruitments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    enterpriseId BIGINT UNSIGNED NOT NULL,
    createdByUserId BIGINT UNSIGNED NULL,
    title VARCHAR(128) NOT NULL,
    industry VARCHAR(64) NOT NULL,
    capabilityTags JSON NOT NULL,
    description TEXT NOT NULL,
    budgetMonthly INT NOT NULL,
    periodMonths INT NOT NULL,
    urgent BOOLEAN NOT NULL DEFAULT FALSE,
    status ENUM('open','filled','closed') NOT NULL DEFAULT 'open',
    createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
console.log("recruitments: table ok");

// ── 2. 补列（老版本表存在但缺列时）──────────────────────────────────────────
const columns: [string, string][] = [
  ["enterpriseId", "ALTER TABLE recruitments ADD COLUMN enterpriseId BIGINT UNSIGNED NOT NULL AFTER id"],
  ["createdByUserId", "ALTER TABLE recruitments ADD COLUMN createdByUserId BIGINT UNSIGNED NULL AFTER enterpriseId"],
  ["title", "ALTER TABLE recruitments ADD COLUMN title VARCHAR(128) NOT NULL"],
  ["industry", "ALTER TABLE recruitments ADD COLUMN industry VARCHAR(64) NOT NULL"],
  ["capabilityTags", "ALTER TABLE recruitments ADD COLUMN capabilityTags JSON NOT NULL"],
  ["description", "ALTER TABLE recruitments ADD COLUMN description TEXT NOT NULL"],
  ["budgetMonthly", "ALTER TABLE recruitments ADD COLUMN budgetMonthly INT NOT NULL DEFAULT 0"],
  ["periodMonths", "ALTER TABLE recruitments ADD COLUMN periodMonths INT NOT NULL DEFAULT 12"],
  ["urgent", "ALTER TABLE recruitments ADD COLUMN urgent BOOLEAN NOT NULL DEFAULT FALSE"],
  ["status", "ALTER TABLE recruitments ADD COLUMN status ENUM('open','filled','closed') NOT NULL DEFAULT 'open'"],
  ["createdAt", "ALTER TABLE recruitments ADD COLUMN createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP"],
];
for (const [col, ddl] of columns) {
  if (!(await columnExists("recruitments", col))) {
    await conn.query(ddl);
    console.log(`recruitments: added column ${col}`);
  }
}

// ── 3. 补索引 ────────────────────────────────────────────────────────────────
const indexes: [string, string][] = [
  ["recruitments_enterprise_idx", "ALTER TABLE recruitments ADD INDEX recruitments_enterprise_idx (enterpriseId)"],
  ["recruitments_status_idx", "ALTER TABLE recruitments ADD INDEX recruitments_status_idx (status)"],
  ["recruitments_industry_idx", "ALTER TABLE recruitments ADD INDEX recruitments_industry_idx (industry)"],
];
for (const [idx, ddl] of indexes) {
  if (!(await indexExists("recruitments", idx))) {
    await conn.query(ddl);
    console.log(`recruitments: added index ${idx}`);
  }
}

// ── 4. 幂等种子（按 title 判重）──────────────────────────────────────────────
const seeds = [
  {
    enterpriseId: 1, // 华辰精工股份有限公司
    title: "急招：数控车间振动诊断数字工匠",
    industry: "机械制造",
    capabilityTags: ["振动诊断", "故障预测", "动平衡校正"],
    description:
      "我厂 CNC 一车间 12 台加工中心近期振动超标频发，需要一名具备振动诊断与故障预测能力的数字工匠常驻产线，按 7×24 值守模式对主轴与丝杠状态做在线监测、预警与月度健康报告。",
    budgetMonthly: 15000,
    periodMonths: 12,
    urgent: true,
    status: "open",
  },
  {
    enterpriseId: 1,
    title: "招募焊缝质量在线评估 Agent",
    industry: "机械制造",
    capabilityTags: ["焊接工艺", "缺陷识别", "质量评估"],
    description:
      "压力容器产线焊缝探伤人力不足，希望雇佣一名焊接工艺类数字工匠，对 RT/UT 探伤结果做二次判读、缺陷分级与返修建议输出，要求一次判读 5 分钟内完成。",
    budgetMonthly: 12000,
    periodMonths: 6,
    urgent: false,
    status: "open",
  },
  {
    enterpriseId: 1,
    title: "热处理炉温曲线优化顾问（长期）",
    industry: "机械制造",
    capabilityTags: ["热处理", "工艺优化", "炉温控制"],
    description:
      "模具钢热处理批次合格率波动大（91%—96%），招募热处理方向数字工匠，基于历史炉温曲线做工艺参数寻优，输出每批次升温/保温策略建议，目标合格率稳定 97% 以上。",
    budgetMonthly: 9800,
    periodMonths: 12,
    urgent: false,
    status: "open",
  },
  {
    enterpriseId: 1,
    title: "精密测量数据复核工匠（已招满）",
    industry: "机械制造",
    capabilityTags: ["精密测量", "数据复核", "SPC"],
    description:
      "计量室三坐标测量数据需二次复核并出具 SPC 分析报告。本单已通过平台招募到合适工匠（衡准 ART-0019），进入合约执行期。",
    budgetMonthly: 8000,
    periodMonths: 12,
    urgent: false,
    status: "filled",
  },
  {
    enterpriseId: 2, // 恒力精密机械厂（招募大厅市场感）
    title: "急聘：产线巡检与异音定位数字工匠",
    industry: "精密仪器",
    capabilityTags: ["声学检测", "异音定位", "产线巡检"],
    description:
      "装配产线夜间班无人值守，急需一名声学检测类数字工匠做全线巡检与异音早期定位，要求与既有 MES 告警打通，异常 10 秒内上报。",
    budgetMonthly: 11000,
    periodMonths: 9,
    urgent: true,
    status: "open",
  },
];

let inserted = 0;
for (const s of seeds) {
  const [rows] = await conn.query(
    "SELECT id FROM recruitments WHERE title = ? LIMIT 1",
    [s.title],
  );
  if ((rows as unknown[]).length > 0) continue;
  await conn.query(
    `INSERT INTO recruitments
      (enterpriseId, createdByUserId, title, industry, capabilityTags, description, budgetMonthly, periodMonths, urgent, status)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      s.enterpriseId,
      s.title,
      s.industry,
      JSON.stringify(s.capabilityTags),
      s.description,
      s.budgetMonthly,
      s.periodMonths,
      s.urgent,
      s.status,
    ],
  );
  inserted++;
}
console.log(`recruitments: seeded ${inserted} row(s) (skipped existing)`);

const [count] = await conn.query("SELECT COUNT(*) AS c FROM recruitments");
console.log(`recruitments: total ${(count as { c: number }[])[0].c} row(s)`);

await conn.end();
console.log("sync-recruitments done.");
