/** Runtime P1 canonical outbox/lease/checkpoint schema。additive/idempotent；当前仅允许隔离测试库。 */
import mysql from 'mysql2/promise'
import { AGENT_TEST_DATABASE_PREFIX } from '../api/lib/agentEconomy'

const url = process.argv[2] ?? process.env.DATABASE_URL
if (!url) throw new Error('必须显式传库 URL 或设置 DATABASE_URL')
const conn = await mysql.createConnection(url)
const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT DATABASE() AS name')
const databaseName = String(rows[0]?.name ?? '')
if (!databaseName.startsWith(AGENT_TEST_DATABASE_PREFIX)) throw new Error('RUNTIME_OUTBOX_TEST_DATABASE_REQUIRED')

async function ensureColumn(table: string, column: string, definition: string): Promise<void> {
  const [existing] = await conn.query<mysql.RowDataPacket[]>(
    'SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?',
    [table, column],
  )
  if (existing.length === 0) await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
}

await conn.query(`CREATE TABLE IF NOT EXISTS st_runtime_leases (
  lease_id VARCHAR(128) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(128) NOT NULL,
  factory_id BIGINT UNSIGNED NOT NULL,
  department_id VARCHAR(128) NOT NULL,
  task_id BIGINT UNSIGNED NOT NULL,
  lease_epoch BIGINT UNSIGNED NOT NULL,
  worker_id VARCHAR(128) NOT NULL,
  status VARCHAR(24) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_runtime_lease_task (task_id, lease_epoch),
  KEY idx_runtime_lease_worker (worker_id, status, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
await ensureColumn('st_runtime_leases', 'last_heartbeat_at', 'DATETIME NULL')

await conn.query(`CREATE TABLE IF NOT EXISTS st_runtime_outbox_claims (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  dedupe_key VARCHAR(128) NOT NULL,
  event_id VARCHAR(128) NOT NULL,
  lease_id VARCHAR(128) NOT NULL,
  lease_epoch BIGINT UNSIGNED NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'claimed',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_runtime_outbox_dedupe (dedupe_key),
  UNIQUE KEY uk_runtime_outbox_event (event_id),
  KEY idx_runtime_outbox_lease (lease_id, lease_epoch)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

await conn.query(`CREATE TABLE IF NOT EXISTS st_runtime_execution_evidence (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id VARCHAR(128) NOT NULL,
  dedupe_key VARCHAR(128) NOT NULL,
  lease_id VARCHAR(128) NOT NULL,
  lease_epoch BIGINT UNSIGNED NOT NULL,
  status VARCHAR(32) NOT NULL,
  delivered TINYINT(1) NOT NULL DEFAULT 0,
  evidence_sha256 CHAR(64) NULL,
  summary TEXT NULL,
  failure_code VARCHAR(128) NULL,
  untrusted_content TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_runtime_evidence_event (event_id, id),
  KEY idx_runtime_evidence_lease (lease_id, lease_epoch, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='执行证据而非交付；不得由此表直接结算'`)

await conn.query(`CREATE TABLE IF NOT EXISTS st_runtime_checkpoints (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id VARCHAR(128) NOT NULL,
  checkpoint_seq BIGINT UNSIGNED NOT NULL,
  lease_id VARCHAR(128) NOT NULL,
  lease_epoch BIGINT UNSIGNED NOT NULL,
  worker_id VARCHAR(128) NOT NULL,
  state VARCHAR(32) NOT NULL,
  evidence_sha256 CHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_runtime_checkpoint_event_seq (event_id, checkpoint_seq),
  KEY idx_runtime_checkpoint_lease (lease_id, lease_epoch, checkpoint_seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

console.log('runtime outbox schema ready (leases/claims/evidence/checkpoints; additive test-only)')
await conn.end()
