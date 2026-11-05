/**
 * M43 迁移「进化按厂开关」：wb_factories 加 evo_opt_out 列（幂等）。
 *
 * 口径：=1 时本厂不接收进化落生技能（loadVisibleSkills 进化段跳过）；
 * 平台基础包/雇佣技能不受影响。默认 0（接收）。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-m43.mts
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Conn = { query: (q: string, params?: unknown[]) => Promise<unknown>; end?: () => Promise<void> };

async function main(conn: Conn): Promise<void> {
  const rows = (await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wb_factories' AND COLUMN_NAME = 'evo_opt_out'`,
  )) as unknown;
  const cols = (Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows) as Array<Record<string, unknown>>;
  if (cols.length > 0) {
    console.log("wb_factories.evo_opt_out: already exists, skip");
    return;
  }
  await conn.query(
    `ALTER TABLE wb_factories ADD COLUMN evo_opt_out TINYINT NOT NULL DEFAULT 0`,
  );
  console.log("wb_factories.evo_opt_out: added (default 0 接收进化技能)");
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
