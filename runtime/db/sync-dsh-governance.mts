/**
 * DSH 服务端治理适配器表结构（幂等）。
 *
 * 表边界：
 * - st_dsh_contracts：能力安装/雇佣合同与 shadow/active 状态；
 * - st_dsh_tickets：C 级 install/rollback/retire 一次性确认票据；
 * - st_dsh_budget_ledger：试用/正式调用预算台账；
 * - st_dsh_audit：治理审计。
 *
 * 本脚本只建 st_dsh_* 新表，不改旧表。用法：
 *   set -a && . ./.env && set +a && npx tsx db/sync-dsh-governance.mts
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

async function createTables(conn: Conn): Promise<void> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS st_dsh_contracts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      contract_no VARCHAR(40) NOT NULL,
      request_id VARCHAR(64) NOT NULL,
      factory_id INT NOT NULL,
      capability_key VARCHAR(96) NOT NULL,
      kind ENUM('skill','employee','workflow') NOT NULL,
      risk ENUM('A','B','C') NOT NULL,
      autonomy ENUM('L0','L1','L2','L3','L4') NOT NULL,
      permissions_json TEXT NOT NULL,
      budget_monthly INT NOT NULL DEFAULT 0,
      budget_used INT NOT NULL DEFAULT 0,
      status ENUM('proposed','shadow','active','retired','rolled_back') NOT NULL,
      success_count INT NOT NULL DEFAULT 0,
      fail_count INT NOT NULL DEFAULT 0,
      eval_score INT NOT NULL DEFAULT 0,
      created_by VARCHAR(64) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_dsh_contract_no (contract_no),
      UNIQUE KEY uq_dsh_contract_request (factory_id, request_id),
      KEY idx_dsh_contract_factory_status (factory_id, status),
      KEY idx_dsh_contract_capability (capability_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS st_dsh_tickets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      ticket_no VARCHAR(48) NOT NULL,
      factory_id INT NOT NULL,
      contract_id BIGINT UNSIGNED NOT NULL,
      action ENUM('install','rollback','retire') NOT NULL,
      status ENUM('pending','consumed','cancelled') NOT NULL DEFAULT 'pending',
      created_by VARCHAR(64) NOT NULL,
      confirmed_by VARCHAR(64) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      consumed_at DATETIME NULL,
      UNIQUE KEY uq_dsh_ticket_no (ticket_no),
      KEY idx_dsh_ticket_factory_contract (factory_id, contract_id),
      KEY idx_dsh_ticket_status (status),
      CONSTRAINT fk_dsh_ticket_contract FOREIGN KEY (contract_id) REFERENCES st_dsh_contracts (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS st_dsh_budget_ledger (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      factory_id INT NOT NULL,
      contract_id BIGINT UNSIGNED NOT NULL,
      kind ENUM('debit','refund','adjust') NOT NULL,
      amount INT NOT NULL,
      actor VARCHAR(64) NOT NULL,
      note VARCHAR(300) NOT NULL DEFAULT '',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_dsh_budget_factory_contract (factory_id, contract_id),
      CONSTRAINT fk_dsh_budget_contract FOREIGN KEY (contract_id) REFERENCES st_dsh_contracts (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS st_dsh_audit (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      factory_id INT NOT NULL,
      contract_id BIGINT UNSIGNED NULL,
      actor VARCHAR(64) NOT NULL,
      action VARCHAR(64) NOT NULL,
      risk ENUM('A','B','C') NULL,
      detail_json TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_dsh_audit_factory_time (factory_id, created_at),
      KEY idx_dsh_audit_contract (contract_id),
      CONSTRAINT fk_dsh_audit_contract FOREIGN KEY (contract_id) REFERENCES st_dsh_contracts (id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function main(conn: Conn): Promise<void> {
  for (const table of ["st_dsh_contracts", "st_dsh_tickets", "st_dsh_budget_ledger", "st_dsh_audit"]) {
    const existed = await tableExists(conn, table);
    console.log(`${table}: ${existed ? "exists, ensure/skip" : "create"}`);
  }
  await createTables(conn);
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
