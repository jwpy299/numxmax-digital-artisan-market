/**
 * M46 迁移「客户端信标」：st_client_logs 表（幂等）。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-m46.mts
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Conn = { query: (q: string, params?: unknown[]) => Promise<unknown>; end?: () => Promise<void> };

async function main(conn: Conn): Promise<void> {
  const rows = (await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_client_logs'`,
  )) as unknown;
  const found = (Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows) as Array<Record<string, unknown>>;
  if (found.length > 0) {
    console.log("st_client_logs: already exists, skip");
    return;
  }
  await conn.query(`
    CREATE TABLE st_client_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      version VARCHAR(16) NOT NULL,
      phase VARCHAR(16) NOT NULL,
      error VARCHAR(800) NULL,
      device VARCHAR(64) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_client_logs_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  console.log("st_client_logs: created");
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
  try {
    await main(conn as unknown as Conn);
  } finally {
    await conn.end();
  }
}
