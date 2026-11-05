/**
 * M37 迁移「万物皆可插件·扫一扫生成设备控制插件」：st_device_plugins 表（幂等）。
 *
 * 口径：
 * - 一行 = 一台由 APP 扫一扫生成的设备插件（plugin manifest + 校验和落库，源码级可审计）；
 * - factoryId 强隔离；slug 全厂唯一（MCP 工具命名空间后缀）；
 * - protocol ∈ http_api（MVP 真实执行）/ mqtt / modbus_tcp（模板已生成，适配器声明 pending，
 *   调用时明确报 adapter_pending，绝不假装成功）；
 * - actions[].level：B 级读类动作直接执行；C 级控制动作必须双签票据（st_gate_tickets），
 *   执行成功核销（与 devices.issueCommand 同款纪律）。
 *
 * 幂等：information_schema 查表后再 CREATE。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-m37.mts
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Conn = { query: (q: string, params?: unknown[]) => Promise<unknown>; end?: () => Promise<void> };

async function main(conn: Conn): Promise<void> {
  const rows = (await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_device_plugins'`,
  )) as unknown;
  const found = (Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows) as Array<Record<string, unknown>>;
  if (found.length > 0) {
    console.log("st_device_plugins: already exists, skip");
    return;
  }
  await conn.query(`
    CREATE TABLE st_device_plugins (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      factory_id BIGINT NOT NULL,
      slug VARCHAR(40) NOT NULL,
      name VARCHAR(128) NOT NULL,
      model VARCHAR(64) NOT NULL DEFAULT '',
      protocol VARCHAR(16) NOT NULL,
      endpoint VARCHAR(255) NOT NULL,
      metrics JSON NOT NULL,
      actions JSON NOT NULL,
      manifest JSON NOT NULL,
      checksum CHAR(64) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      source VARCHAR(16) NOT NULL DEFAULT 'scan',
      created_by BIGINT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_device_plugins_factory_slug (factory_id, slug),
      KEY idx_device_plugins_factory_status (factory_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  console.log("st_device_plugins: created");
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
