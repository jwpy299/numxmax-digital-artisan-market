/**
 * M55 迁移「词元经济」：个人词元钱包 + 数字人钱包（幂等）。
 * 1. wb_users + tokenBalance INT（个人词元钱包，兑数字人民币出金走 st_withdrawals 既有管线）
 * 2. st_persona_wallets —— 灵枢/星云数字人词元钱包（人充值词元→数字人分润赚钱→回馈用户）
 * 幂等：information_schema 逐项探测。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-m55.mts
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Conn = { query: (q: string, params?: unknown[]) => Promise<unknown>; end?: () => Promise<void> };

async function tableExists(conn: Conn, name: string): Promise<boolean> {
  const rows = (await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [name],
  )) as unknown;
  const found = (Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows) as Array<Record<string, unknown>>;
  return found.length > 0;
}

async function columnExists(conn: Conn, table: string, column: string): Promise<boolean> {
  const rows = (await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  )) as unknown;
  const found = (Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows) as Array<Record<string, unknown>>;
  return found.length > 0;
}

async function main(conn: Conn): Promise<void> {
  if (!(await columnExists(conn, "wb_users", "tokenBalance"))) {
    await conn.query(
      `ALTER TABLE wb_users ADD COLUMN tokenBalance INT NOT NULL DEFAULT 0 COMMENT '个人词元钱包（M55 词元经济）'`,
    );
    console.log("wb_users.tokenBalance: added");
  } else {
    console.log("wb_users.tokenBalance: exists, skip");
  }

  if (!(await tableExists(conn, "st_persona_wallets"))) {
    await conn.query(`
      CREATE TABLE st_persona_wallets (
        persona VARCHAR(16) NOT NULL PRIMARY KEY COMMENT 'lingshu/xingyun',
        tokenBalance INT NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await conn.query(
      `INSERT INTO st_persona_wallets (persona, tokenBalance) VALUES ('lingshu', 0), ('xingyun', 0)`,
    );
    console.log("st_persona_wallets: created + seeded (lingshu/xingyun)");
  } else {
    console.log("st_persona_wallets: exists, skip");
  }
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
