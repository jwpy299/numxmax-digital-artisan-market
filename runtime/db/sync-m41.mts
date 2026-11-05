/**
 * M41 迁移「二期·边缘网关」：st_device_plugins 加 via_edge 列（幂等）。
 *
 * 口径：via_edge=1 表示设备在厂区 LAN（云上不可达），读数/控制经边缘网关
 * （st_device_commands plugin_invoke 命令，M12 通道复用）执行；=0 云上直连。
 * 幂等：information_schema 查列后再 ALTER。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-m41.mts
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Conn = { query: (q: string, params?: unknown[]) => Promise<unknown>; end?: () => Promise<void> };

async function main(conn: Conn): Promise<void> {
  const rows = (await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_device_plugins' AND COLUMN_NAME = 'via_edge'`,
  )) as unknown;
  const cols = (Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows) as Array<Record<string, unknown>>;
  if (cols.length > 0) {
    console.log("st_device_plugins.via_edge: already exists, skip");
    return;
  }
  await conn.query(
    `ALTER TABLE st_device_plugins ADD COLUMN via_edge TINYINT NOT NULL DEFAULT 0 AFTER endpoint`,
  );
  console.log("st_device_plugins.via_edge: added (default 0 云直连)");
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
