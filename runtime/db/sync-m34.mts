/**
 * M34b 迁移「DAG 运行时双轨」：st_dag_runs 加 runtime 列（幂等）。
 *
 * 口径：runtime ∈ bridge（默认，现有 agentBridge 管线）/ dsh（DSH 底座试点 lane）。
 * 幂等：information_schema 查列后再 ALTER。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-m34.mts
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Conn = { query: (q: string, params?: unknown[]) => Promise<unknown>; end?: () => Promise<void> };

async function main(conn: Conn): Promise<void> {
  const rows = (await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_dag_runs' AND COLUMN_NAME = 'runtime'`,
  )) as unknown;
  const cols = (Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows) as Array<Record<string, unknown>>;
  if (cols.length > 0) {
    console.log("st_dag_runs.runtime: already exists, skip");
    return;
  }
  await conn.query(
    `ALTER TABLE st_dag_runs ADD COLUMN runtime VARCHAR(16) NOT NULL DEFAULT 'bridge' AFTER status`,
  );
  console.log("st_dag_runs.runtime: added (default bridge)");
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
