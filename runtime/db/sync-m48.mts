/**
 * M48 迁移「插件仓技能层」：st_skills.layer 枚举扩 'store'（幂等）。
 * store 层 = 从 dsh-plugin-store 安装进系统的插件技能（超终一键装机，全员工具面可见）。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-m48.mts
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Conn = { query: (q: string, params?: unknown[]) => Promise<unknown>; end?: () => Promise<void> };

async function main(conn: Conn): Promise<void> {
  const rows = (await conn.query(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_skills' AND COLUMN_NAME = 'layer'`,
  )) as unknown;
  const found = (Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows) as Array<Record<string, unknown>>;
  const colType = String(found[0]?.COLUMN_TYPE ?? "");
  if (colType.includes("'store'")) {
    console.log("st_skills.layer: store already in enum, skip");
    return;
  }
  await conn.query(
    `ALTER TABLE st_skills MODIFY COLUMN layer ENUM('general','professional','industry','evo','store') NOT NULL`,
  );
  console.log("st_skills.layer: enum extended with 'store'");
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
