/**
 * 幂等同步 M69「Nebula Harness 双运行时融合」所需新表：
 *   st_harness_runs —— 统一运行台账（元数据级：tier/lane/ok/时延/宪章指纹/文本长度；
 *                     绝不落任务正文，与 dsh 服务化封装同一纪律）
 * 全部为 st_ 前缀新表（additive），不改 drizzle schema.ts，由 api/harness/orchestrator.ts 用 raw SQL 访问。
 *
 * 风格仿 db/sync-staff.mts：raw mysql2 直连、information_schema 检测、DRY_RUN 早退。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-harness.mts
 * 语法自检：DRY_RUN=1 npx tsx db/sync-harness.mts（不连库，直接退出）
 */
if (process.env.DRY_RUN) {
  console.log("dry run ok");
  process.exit(0);
}

import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const conn = await mysql.createConnection(url);

async function ensureTable(name: string, ddl: string) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [name],
  );
  if ((rows as unknown[]).length > 0) {
    console.log(`${name}: table exists, skip`);
  } else {
    await conn.query(ddl);
    console.log(`${name}: table created`);
  }
}

await ensureTable(
  "st_harness_runs",
  `CREATE TABLE st_harness_runs (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tier VARCHAR(16) NOT NULL,
    lane VARCHAR(24) NOT NULL,
    factory_id BIGINT NULL,
    ok TINYINT NOT NULL DEFAULT 0,
    error VARCHAR(200) NULL,
    duration_ms INT NULL,
    charter_fp VARCHAR(32) NULL,
    text_len INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_harness_runs_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

await conn.end();
console.log("sync-harness done");
