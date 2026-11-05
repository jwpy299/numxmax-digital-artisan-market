/**
 * M45 迁移「Agent 支付闭环」三件套（幂等）：
 *
 * 背景缺口（彭总原话）：只有人类充值 Token 的单向链路，没有 Agent/供给侧的支付闭环——
 * 雇佣只记台账从不真扣企业钱包，供给侧（大师/平台）分账从不真入账。
 *
 * 本迁移：
 * 1. masters.tokenBalance —— 供给侧钱包（大师/平台官方），分账 85% 真实入账；
 * 2. st_withdrawals —— 提现管线（企业兑回/供给侧结算）：pending→approved→paid/rejected，
 *    渠道字段（ecny 数字人民币/bank 银行卡/ewallet 数字钱包）+ 凭证 + 双人复核留痕；
 *    （真实出金通道需支付牌照/商户号——挂债，本表是合规管线骨架）；
 * 3. st_wallet_flows —— 钱包流水台账（每笔进出留痕，可回放审计，等保友好）。
 *
 * 幂等：information_schema 逐项探测。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-m45.mts
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Conn = { query: (q: string, params?: unknown[]) => Promise<unknown>; end?: () => Promise<void> };

async function tableExists(conn: Conn, name: string): Promise<boolean> {
  const rows = (await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [name],
  )) as unknown;
  return (((Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows) as unknown[]).length > 0);
}

async function columnExists(conn: Conn, table: string, col: string): Promise<boolean> {
  const rows = (await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, col],
  )) as unknown;
  return (((Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows) as unknown[]).length > 0);
}

async function main(conn: Conn): Promise<void> {
  if (!(await columnExists(conn, "masters", "tokenBalance"))) {
    await conn.query(`ALTER TABLE masters ADD COLUMN tokenBalance INT NOT NULL DEFAULT 0`);
    console.log("masters.tokenBalance: added");
  } else {
    console.log("masters.tokenBalance: exists, skip");
  }

  if (!(await tableExists(conn, "st_withdrawals"))) {
    await conn.query(`
      CREATE TABLE st_withdrawals (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        owner_type VARCHAR(16) NOT NULL COMMENT 'enterprise/master',
        owner_id BIGINT NOT NULL,
        amount INT NOT NULL COMMENT 'Token',
        channel VARCHAR(16) NOT NULL COMMENT 'ecny/bank/ewallet',
        account_masked VARCHAR(128) NOT NULL COMMENT '脱敏账号（仅尾号）',
        status VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending/approved/paid/rejected',
        requested_by VARCHAR(64) NOT NULL,
        reviewed_by VARCHAR(64) NULL,
        review_note VARCHAR(255) NULL,
        proof VARCHAR(255) NULL COMMENT '结算凭证（回单号/截图路径）',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reviewed_at DATETIME NULL,
        paid_at DATETIME NULL,
        KEY idx_withdraw_owner (owner_type, owner_id, status),
        KEY idx_withdraw_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log("st_withdrawals: created");
  } else {
    console.log("st_withdrawals: exists, skip");
  }

  if (!(await tableExists(conn, "st_wallet_flows"))) {
    await conn.query(`
      CREATE TABLE st_wallet_flows (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        owner_type VARCHAR(16) NOT NULL COMMENT 'enterprise/master',
        owner_id BIGINT NOT NULL,
        direction VARCHAR(8) NOT NULL COMMENT 'in/out',
        amount INT NOT NULL,
        balance_after INT NOT NULL,
        biz_type VARCHAR(32) NOT NULL COMMENT 'hire_debit/hire_credit/purchase_debit/purchase_credit/topup/withdraw_debit/withdraw_refund/adjust',
        ref_id VARCHAR(64) NULL,
        note VARCHAR(255) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_flows_owner (owner_type, owner_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log("st_wallet_flows: created");
  } else {
    console.log("st_wallet_flows: exists, skip");
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
  try {
    await main(conn as unknown as Conn);
  } finally {
    await conn.end();
  }
}
