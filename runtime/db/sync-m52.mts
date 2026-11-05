/**
 * M52 迁移「跨部门协作台账」：st_dept_collabs 表（幂等）。
 * 部门间协作通道：发起部门主官 → 目标部门主官 的委派/会商记录（含回执全文），
 * 三部门工作台共享可见（协作是组织资产，不做部门间隔离）。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-m52.mts
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Conn = { query: (q: string, params?: unknown[]) => Promise<unknown>; end?: () => Promise<void> };

async function main(conn: Conn): Promise<void> {
  const rows = (await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_dept_collabs'`,
  )) as unknown;
  const found = (Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows) as Array<Record<string, unknown>>;
  if (found.length > 0) {
    console.log("st_dept_collabs: already exists, skip");
    return;
  }
  await conn.query(`
    CREATE TABLE st_dept_collabs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      from_dept VARCHAR(16) NOT NULL,
      to_dept VARCHAR(16) NOT NULL,
      from_agent VARCHAR(64) NOT NULL,
      to_agent VARCHAR(64) NOT NULL,
      message VARCHAR(2000) NOT NULL,
      reply TEXT NULL,
      runtime VARCHAR(8) NOT NULL DEFAULT 'dsh',
      status VARCHAR(16) NOT NULL DEFAULT 'answered',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_collabs_created (created_at),
      KEY idx_collabs_pair (from_dept, to_dept)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  console.log("st_dept_collabs: created");
}

const isDirectRun =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isDirectRun) {
  if (process.env.DRY_RUN === "1") {
    console.log("DRY_RUN ok: syntax parsed");
    process.exit(0);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL 未配置");
    process.exit(1);
  }
  const { createConnection } = await import("mysql2/promise");
  const u = new URL(url);
  const conn = await createConnection({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
  });
  await main(conn);
  await conn.end();
}
