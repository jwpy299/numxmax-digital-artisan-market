/**
 * M53 迁移「企业级部门工作台」：st_dept_consoles 扩 factory_id（幂等）。
 * factory_id NULL = 平台三部门（运营/品牌/市场）；非空 = 该企业的部门工作台。
 * 唯一键从 dept_code 单列改为 (factory_id, dept_code) 复合（MySQL 唯一键允许多个 NULL，
 * 平台三行仍是唯一一组 NULL 集合）。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-m53.mts
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Conn = { query: (q: string, params?: unknown[]) => Promise<unknown>; end?: () => Promise<void> };

async function main(conn: Conn): Promise<void> {
  const cols = (await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_dept_consoles' AND COLUMN_NAME = 'factory_id'`,
  )) as unknown;
  const found = (Array.isArray(cols) && Array.isArray(cols[0]) ? cols[0] : cols) as Array<Record<string, unknown>>;
  if (found.length > 0) {
    console.log("st_dept_consoles.factory_id: already exists, skip");
    return;
  }
  await conn.query(`ALTER TABLE st_dept_consoles ADD COLUMN factory_id BIGINT UNSIGNED NULL AFTER id`);
  await conn.query(`ALTER TABLE st_dept_consoles DROP INDEX uk_dept_consoles_code`);
  await conn.query(
    `ALTER TABLE st_dept_consoles ADD UNIQUE KEY uk_dept_consoles_factory_code (factory_id, dept_code)`,
  );
  await conn.query(
    `ALTER TABLE st_dept_consoles ADD KEY idx_dept_consoles_factory (factory_id)`,
  );
  console.log("st_dept_consoles: factory_id added + composite unique key");
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
