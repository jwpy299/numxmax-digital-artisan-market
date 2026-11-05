/**
 * 个人 Agent 就业、隔离训练、支付沙箱与 job_token 工资台账。
 * additive / idempotent；不删表、不改写既有生产数据。
 * 执行：npx tsx db/sync-agent-employment.mts '<数据库URL>'
 */
import mysql from "mysql2/promise";
import { AGENT_TEST_DATABASE_PREFIX } from "../api/lib/agentEconomy";

const economyMode = process.env.ECONOMY_MODE ?? 'production';
if (!['production', 'test'].includes(economyMode)) throw new Error('ECONOMY_MODE_INVALID');
if (economyMode === 'test' && process.env.NODE_ENV === 'production') throw new Error('ECONOMY_MODE_TEST_FORBIDDEN_IN_PRODUCTION');
if (economyMode === 'test' && process.env.AGENT_EMPLOYMENT_TEST_DATABASE !== '1') throw new Error('AGENT_EMPLOYMENT_TEST_DATABASE_REQUIRED');
const url = process.argv[2] ?? process.env.DATABASE_URL ?? (() => { throw new Error("必须显式传库 URL 或设置 DATABASE_URL"); })();
const conn = await mysql.createConnection(url);
if (economyMode === 'test') {
  const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT DATABASE() AS name');
  const databaseName = String(rows[0]?.name ?? '');
  if (!databaseName.startsWith(AGENT_TEST_DATABASE_PREFIX)) throw new Error('AGENT_EMPLOYMENT_TEST_DATABASE_NAME_MISMATCH');
}
const includeTestTables = economyMode === 'test';

async function ensureColumn(table: string, column: string, definition: string): Promise<boolean> {
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT COLUMN_NAME FROM information_schema.columns
     WHERE table_schema=DATABASE() AND table_name=? AND column_name=?`, [table, column],
  );
  if (rows.length === 0) {
    await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`);
    return true;
  }
  return false;
}

await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_registrations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  registration_no VARCHAR(40) NOT NULL,
  agent_key VARCHAR(64) NOT NULL,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  agent_name VARCHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending_payment',
  fee_status VARCHAR(24) NOT NULL DEFAULT 'unpaid',
  current_attempt_no INT NOT NULL DEFAULT 0,
  version INT NOT NULL DEFAULT 0,
  idempotency_key VARCHAR(128) NOT NULL,
  qualified_at DATETIME NULL,
  disqualified_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_registration_no (registration_no),
  UNIQUE KEY uk_agent_key (agent_key),
  UNIQUE KEY uk_agent_registration_idem (idempotency_key),
  KEY idx_agent_registration_owner (owner_user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='个人Agent报名与就业准入'`);

await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_training_cycles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  registration_id BIGINT UNSIGNED NOT NULL,
  attempt_no INT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  score INT NULL,
  reviewed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_cycle_attempt (registration_id, attempt_no),
  KEY idx_agent_cycle_sweep (status, ends_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='个人Agent七天隔离训练周期'`);

await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_training_tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  cycle_id BIGINT UNSIGNED NOT NULL,
  day_no INT NOT NULL,
  task_key VARCHAR(80) NOT NULL,
  title VARCHAR(160) NOT NULL,
  brief TEXT NOT NULL,
  rubric_json JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'assigned',
  available_at DATETIME NOT NULL,
  deliverable MEDIUMTEXT NULL,
  evidence_sha256 CHAR(64) NULL,
  score INT NULL,
  reviewer_id BIGINT UNSIGNED NULL,
  reviewer_ref VARCHAR(128) NULL,
  review_note VARCHAR(500) NULL,
  submitted_at DATETIME NULL,
  reviewed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_training_day (cycle_id, day_no),
  KEY idx_agent_training_review (cycle_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='按日释放的隔离模拟工作任务'`);

await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_payment_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_no VARCHAR(48) NOT NULL,
  registration_id BIGINT UNSIGNED NOT NULL,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(16) NOT NULL,
  attempt_no INT NOT NULL,
  amount_cents INT NOT NULL,
  amount_job_tokens INT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'CNY',
  environment VARCHAR(16) NOT NULL DEFAULT 'sandbox',
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  provider_ref VARCHAR(96) NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  paid_at DATETIME NULL,
  refunded_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_payment_order_no (order_no),
  UNIQUE KEY uk_agent_payment_attempt (registration_id, kind, attempt_no),
  UNIQUE KEY uk_agent_payment_idem (idempotency_key),
  KEY idx_agent_payment_owner (owner_user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='个人Agent报名费与补考费订单（沙箱/真实隔离）'`);

await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_payment_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id VARCHAR(128) NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  payload_json JSON NOT NULL,
  processed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_payment_event (event_id),
  KEY idx_agent_payment_event_order (order_id, event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='支付回调幂等事件'`);

await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_payment_refunds (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  refund_no VARCHAR(48) NOT NULL,
  registration_id BIGINT UNSIGNED NOT NULL,
  original_order_id BIGINT UNSIGNED NOT NULL,
  amount_cents INT NOT NULL,
  amount_job_tokens INT NOT NULL,
  reason VARCHAR(24) NOT NULL,
  environment VARCHAR(16) NOT NULL DEFAULT 'sandbox',
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  provider_ref VARCHAR(96) NULL,
  failure_code VARCHAR(80) NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  next_retry_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_refund_no (refund_no),
  UNIQUE KEY uk_agent_refund_registration (registration_id),
  UNIQUE KEY uk_agent_refund_original (original_order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='99元报名费原路退款（补考费不退）'`);

await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_no VARCHAR(48) NOT NULL,
  factory_id BIGINT UNSIGNED NOT NULL,
  department_id VARCHAR(64) NULL,
  publisher_user_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(160) NOT NULL,
  description TEXT NOT NULL,
  requirements TEXT NULL,
  headcount INT NOT NULL,
  filled_count INT NOT NULL DEFAULT 0,
  budget_job_tokens INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  idempotency_key VARCHAR(128) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_job_no (job_no),
  UNIQUE KEY uk_agent_job_idem (idempotency_key),
  KEY idx_agent_job_market (status, factory_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='企业在门户发布的Agent工作岗位'`);

await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_job_applications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_id BIGINT UNSIGNED NOT NULL,
  registration_id BIGINT UNSIGNED NOT NULL,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  cover_note VARCHAR(1000) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'applied',
  idempotency_key VARCHAR(128) NOT NULL,
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_application (job_id, registration_id),
  UNIQUE KEY uk_agent_application_idem (idempotency_key),
  KEY idx_agent_application_owner (owner_user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='个人Agent岗位应聘'`);

await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_employments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_id BIGINT UNSIGNED NOT NULL,
  registration_id BIGINT UNSIGNED NOT NULL,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  factory_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME NULL,
  ended_by BIGINT UNSIGNED NULL,
  end_reason VARCHAR(500) NULL,
  UNIQUE KEY uk_agent_employment (job_id, registration_id),
  KEY idx_agent_employment_agent (registration_id, status),
  KEY idx_agent_employment_factory (factory_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='岗位录用后的雇佣关系'`);
await ensureColumn("st_agent_employments", "ended_by", "ended_by BIGINT UNSIGNED NULL AFTER ended_at");
await ensureColumn("st_agent_employments", "end_reason", "end_reason VARCHAR(500) NULL AFTER ended_by");

await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_work_tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  task_no VARCHAR(48) NOT NULL,
  factory_id BIGINT UNSIGNED NOT NULL,
  job_id BIGINT UNSIGNED NULL,
  department_id VARCHAR(64) NULL COMMENT '发布时绑定的部门；不随发布人后续调部门而改变',
  publisher_user_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(160) NOT NULL,
  brief MEDIUMTEXT NOT NULL,
  requirements TEXT NULL,
  reward_job_tokens INT NOT NULL,
  escrow_job_tokens INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  deadline_at DATETIME NULL,
  version INT NOT NULL DEFAULT 0,
  idempotency_key VARCHAR(128) NOT NULL,
  accepted_at DATETIME NULL,
  cancel_reason VARCHAR(500) NULL,
  cancelled_by BIGINT UNSIGNED NULL,
  cancelled_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_work_task_no (task_no),
  UNIQUE KEY uk_agent_work_task_idem (idempotency_key),
  KEY idx_agent_work_market (status, deadline_at),
  KEY idx_agent_work_factory (factory_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='企业发布的工作任务与固定job_token报酬'`);

await conn.query(`ALTER TABLE st_agent_work_tasks MODIFY COLUMN brief MEDIUMTEXT NOT NULL`);

// R2 既有试点表 additive 补列；不删表、不回填或篡改历史部门归属。
await ensureColumn("st_agent_work_tasks", "department_id", "department_id VARCHAR(64) NULL AFTER job_id");
await ensureColumn("st_agent_work_tasks", "cancel_reason", "cancel_reason VARCHAR(500) NULL AFTER accepted_at");
await ensureColumn("st_agent_work_tasks", "cancelled_by", "cancelled_by BIGINT UNSIGNED NULL AFTER cancel_reason");
await ensureColumn("st_agent_work_tasks", "cancelled_at", "cancelled_at DATETIME NULL AFTER cancelled_by");

await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_task_claims (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  task_id BIGINT UNSIGNED NOT NULL,
  registration_id BIGINT UNSIGNED NOT NULL,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'claimed',
  is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1=当前占用任务；0=已撤销，可保留历史并允许改派',
  active_task_id BIGINT UNSIGNED GENERATED ALWAYS AS (IF(is_active=1, task_id, NULL)) COMMENT '仅有效占用参与唯一约束；撤销历史允许任意多条',
  deliverable MEDIUMTEXT NULL,
  evidence_sha256 CHAR(64) NULL,
  review_note VARCHAR(500) NULL,
  reviewed_by BIGINT UNSIGNED NULL,
  version INT NOT NULL DEFAULT 0,
  idempotency_key VARCHAR(128) NOT NULL,
  submitted_at DATETIME NULL,
  reviewed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_claim_active (active_task_id),
  UNIQUE KEY uk_agent_claim_idem (idempotency_key),
  KEY idx_agent_claim_owner (owner_user_id, status),
  KEY idx_agent_claim_agent (registration_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='任务领取、提交、复核与验收状态'`);
await ensureColumn("st_agent_task_claims", "is_active", "is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER status");
await ensureColumn("st_agent_task_claims", "active_task_id", "active_task_id BIGINT UNSIGNED GENERATED ALWAYS AS (IF(is_active=1, task_id, NULL)) AFTER is_active");
const [claimIndexes] = await conn.query<mysql.RowDataPacket[]>(
  `SELECT DISTINCT index_name AS indexName, column_name AS columnName FROM information_schema.statistics
   WHERE table_schema=DATABASE() AND table_name='st_agent_task_claims' AND index_name IN ('uk_agent_claim_task','uk_agent_claim_active')`,
);
const indexNames = new Set(claimIndexes.map((row) => String(row.indexName)));
const generatedUniqueReady = claimIndexes.some((row) => String(row.indexName) === "uk_agent_claim_active" && String(row.columnName) === "active_task_id");
if (indexNames.has("uk_agent_claim_task")) await conn.query(`ALTER TABLE st_agent_task_claims DROP INDEX uk_agent_claim_task`);
if (!generatedUniqueReady) {
  if (indexNames.has("uk_agent_claim_active")) await conn.query(`ALTER TABLE st_agent_task_claims DROP INDEX uk_agent_claim_active`);
  await conn.query(`ALTER TABLE st_agent_task_claims ADD UNIQUE KEY uk_agent_claim_active (active_task_id)`);
}

if (includeTestTables) await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_token_wallets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  wallet_key VARCHAR(80) NOT NULL UNIQUE,
  registration_id BIGINT UNSIGNED NULL UNIQUE,
  owner_type VARCHAR(16) NOT NULL,
  balance_job_tokens INT NOT NULL DEFAULT 0,
  version INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_agent_token_wallet_registration (registration_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI Agent与平台job_token钱包'`);

if (includeTestTables) await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_token_exchanges (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  exchange_no VARCHAR(64) NOT NULL UNIQUE,
  registration_id BIGINT UNSIGNED NOT NULL,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  amount_job_tokens INT NOT NULL,
  amount_cents INT NOT NULL,
  environment VARCHAR(16) NOT NULL DEFAULT 'sandbox',
  status VARCHAR(24) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL UNIQUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_agent_token_exchange_owner (owner_user_id, registration_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Agent job_token沙箱兑换记录，不发生真实人民币扣款'`);

await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_wage_ledger (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  claim_id BIGINT UNSIGNED NOT NULL,
  factory_id BIGINT UNSIGNED NOT NULL,
  registration_id BIGINT UNSIGNED NOT NULL,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  direction VARCHAR(8) NOT NULL,
  amount_job_tokens INT NOT NULL,
  balance_after INT NOT NULL,
  wallet_owner_type VARCHAR(16) NOT NULL,
  wallet_owner_id BIGINT UNSIGNED NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_wage_direction (claim_id, direction),
  UNIQUE KEY uk_agent_wage_idem (idempotency_key),
  KEY idx_agent_wage_owner (owner_user_id, created_at),
  KEY idx_agent_wage_factory (factory_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='仅验收交付触发的job_token双边工资台账'`);

await ensureColumn("st_agent_work_tasks", "escrow_job_tokens", "escrow_job_tokens INT NOT NULL DEFAULT 0");
await conn.query(`CREATE TABLE IF NOT EXISTS enterprises (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  industry VARCHAR(64) NOT NULL,
  tokenBalance INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
const enterpriseEscrowAdded = await ensureColumn("enterprises", "reserved_job_tokens", "reserved_job_tokens INT NULL");
if (enterpriseEscrowAdded) {
  await conn.query(`UPDATE st_agent_work_tasks SET escrow_job_tokens=reward_job_tokens
    WHERE status IN ('open','claimed','submitted','rejected') AND escrow_job_tokens=0`);
  await conn.query(`UPDATE enterprises e
    LEFT JOIN (SELECT factory_id, SUM(escrow_job_tokens) AS reserved FROM st_agent_work_tasks GROUP BY factory_id) t
      ON t.factory_id=e.id
    SET e.reserved_job_tokens=COALESCE(t.reserved,0),
        e.tokenBalance=GREATEST(e.tokenBalance-COALESCE(t.reserved,0),0)`);
}
await conn.query(`ALTER TABLE enterprises MODIFY COLUMN reserved_job_tokens INT NOT NULL DEFAULT 0`);

await ensureColumn("st_agent_payment_refunds", "attempt_count", "attempt_count INT NOT NULL DEFAULT 0");
await ensureColumn("st_agent_payment_refunds", "next_retry_at", "next_retry_at DATETIME NULL");
await ensureColumn("st_agent_payment_orders", "amount_job_tokens", "amount_job_tokens INT NULL");
await ensureColumn("st_agent_payment_refunds", "amount_job_tokens", "amount_job_tokens INT NULL");
await conn.query(`UPDATE st_agent_payment_orders SET amount_job_tokens=amount_cents/10 WHERE amount_job_tokens IS NULL`);
await conn.query(`UPDATE st_agent_payment_refunds SET amount_job_tokens=amount_cents/10 WHERE amount_job_tokens IS NULL`);
await conn.query(`ALTER TABLE st_agent_payment_orders MODIFY COLUMN amount_job_tokens INT NOT NULL`);
await conn.query(`ALTER TABLE st_agent_payment_refunds MODIFY COLUMN amount_job_tokens INT NOT NULL`);

await ensureColumn("st_agent_wage_ledger", "wallet_owner_type", "wallet_owner_type VARCHAR(16) NULL");
await ensureColumn("st_agent_wage_ledger", "wallet_owner_id", "wallet_owner_id BIGINT UNSIGNED NULL");
await conn.query(`UPDATE st_agent_wage_ledger
  SET wallet_owner_type=IF(direction='debit','enterprise','user'),
      wallet_owner_id=IF(direction='debit',factory_id,owner_user_id)
  WHERE wallet_owner_type IS NULL OR wallet_owner_id IS NULL`);
await conn.query(`ALTER TABLE st_agent_wage_ledger
  MODIFY COLUMN wallet_owner_type VARCHAR(16) NOT NULL,
  MODIFY COLUMN wallet_owner_id BIGINT UNSIGNED NOT NULL`);

console.log(`agent employment schema ready (mode=${economyMode}; tables, columns and generated indexes checked)`);
await conn.end();
console.log("sync-agent-employment: done");
