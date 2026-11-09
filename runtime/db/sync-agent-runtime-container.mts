import mysql from 'mysql2/promise'
import { AGENT_TEST_DATABASE_PREFIX } from '../api/lib/agentEconomy'
const economyMode = process.env.ECONOMY_MODE ?? 'production'
if (!['production', 'test'].includes(economyMode)) throw new Error('ECONOMY_MODE_INVALID')
if (economyMode === 'test' && process.env.NODE_ENV === 'production') throw new Error('ECONOMY_MODE_TEST_FORBIDDEN_IN_PRODUCTION')
if (economyMode === 'test' && process.env.AGENT_EMPLOYMENT_TEST_DATABASE !== '1') throw new Error('AGENT_EMPLOYMENT_TEST_DATABASE_REQUIRED')
const url = process.argv[2] ?? process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL required')
const conn = await mysql.createConnection(url)
if (economyMode === 'test') {
  const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT DATABASE() AS name')
  if (!String(rows[0]?.name ?? '').startsWith(AGENT_TEST_DATABASE_PREFIX)) throw new Error('AGENT_RUNTIME_CONTAINER_TEST_DATABASE_REQUIRED')
}
await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_runtime_identities (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factory_id BIGINT UNSIGNED NOT NULL, department_id VARCHAR(64) NOT NULL, owner_user_id BIGINT UNSIGNED NOT NULL,
  runtime VARCHAR(32) NOT NULL, registration_id BIGINT UNSIGNED NOT NULL, enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_runtime_identity (factory_id, owner_user_id, department_id, runtime),
  KEY idx_agent_runtime_identity_registration (registration_id),
  KEY idx_agent_runtime_identity_scope (factory_id, department_id, enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT=' runtime与其已达标个人Agent身份绑定；不保存登录token'`)
await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_runtime_plans (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  plan_no VARCHAR(48) NOT NULL, factory_id BIGINT UNSIGNED NOT NULL, department_id VARCHAR(64) NOT NULL,
  creator_user_id BIGINT UNSIGNED NOT NULL, natural_language TEXT NOT NULL, request_sha256 CHAR(64) NOT NULL,
  idempotency_key CHAR(64) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'planning',
  planner_provider VARCHAR(32) NULL, planner_model VARCHAR(96) NULL,
  planner_request_sha256 CHAR(64) NULL, planner_response_sha256 CHAR(64) NULL,
  planner_usage_tokens INT NOT NULL DEFAULT 0, planner_latency_ms INT NOT NULL DEFAULT 0, planner_error VARCHAR(96) NULL,
  version INT NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_runtime_plan_no (plan_no), UNIQUE KEY uk_agent_runtime_plan_idem (idempotency_key),
  KEY idx_agent_runtime_plan_scope (factory_id, department_id, id), KEY idx_agent_runtime_plan_status (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='多Agent自然语言编排计划；canonical MySQL唯一事实源'`)
await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_runtime_roles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  role_no VARCHAR(48) NOT NULL, plan_id BIGINT UNSIGNED NOT NULL, role_name VARCHAR(96) NOT NULL,
  title VARCHAR(160) NOT NULL, brief TEXT NOT NULL, reward_job_tokens INT NOT NULL,
  runtime_preference VARCHAR(32) NOT NULL, job_id BIGINT UNSIGNED NULL,
  selected_application_id BIGINT UNSIGNED NULL, employment_id BIGINT UNSIGNED NULL,
  work_task_id BIGINT UNSIGNED NULL, claim_id BIGINT UNSIGNED NULL, assigned_runtime VARCHAR(32) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'planned', result_text MEDIUMTEXT NULL, result_sha256 CHAR(64) NULL,
  result_provider VARCHAR(64) NULL, result_model VARCHAR(96) NULL, result_usage_tokens INT NOT NULL DEFAULT 0,
  result_latency_ms INT NOT NULL DEFAULT 0, error_code VARCHAR(96) NULL, wage_settled TINYINT(1) NOT NULL DEFAULT 0,
  version INT NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_runtime_role_no (role_no), KEY idx_agent_runtime_role_plan (plan_id, id),
  KEY idx_agent_runtime_role_claim (claim_id, status), KEY idx_agent_runtime_role_outbox (status, id),
  CONSTRAINT fk_agent_runtime_role_plan FOREIGN KEY (plan_id) REFERENCES st_agent_runtime_plans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='一岗位多Agent竞岗；录用后领取任务，独立验收后原工资链结算'`)
await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_runtime_candidates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  role_id BIGINT UNSIGNED NOT NULL, runtime VARCHAR(32) NOT NULL, registration_id BIGINT UNSIGNED NOT NULL,
  application_id BIGINT UNSIGNED NULL, status VARCHAR(32) NOT NULL DEFAULT 'pending', error_code VARCHAR(96) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_runtime_candidate (role_id, runtime, registration_id),
  KEY idx_agent_runtime_candidate_application (application_id, status),
  CONSTRAINT fk_agent_runtime_candidate_role FOREIGN KEY (role_id) REFERENCES st_agent_runtime_roles(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='岗位候选Agent；application_id映射既有竞岗事实'`)
await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_runtime_delegations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  role_id BIGINT UNSIGNED NOT NULL, claim_id BIGINT UNSIGNED NOT NULL, owner_user_id BIGINT UNSIGNED NOT NULL,
  factory_id BIGINT UNSIGNED NOT NULL, token_hash CHAR(64) NOT NULL, token_ciphertext TEXT NOT NULL,
  scope VARCHAR(32) NOT NULL DEFAULT 'submitTask', expires_at DATETIME NOT NULL, revoked_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_runtime_delegation_role (role_id), UNIQUE KEY uk_agent_runtime_delegation_hash (token_hash),
  KEY idx_agent_runtime_delegation_claim (claim_id, scope, expires_at),
  CONSTRAINT fk_agent_runtime_delegation_role FOREIGN KEY (role_id) REFERENCES st_agent_runtime_roles(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='仅限指定claim提交交付的短期AES-GCM委派；不明文存token'`)
await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_runtime_outbox (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  plan_id BIGINT UNSIGNED NOT NULL, role_id BIGINT UNSIGNED NOT NULL, event_type VARCHAR(64) NOT NULL,
  dedupe_key VARCHAR(128) NOT NULL, payload_json JSON NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'pending',
  lease_owner VARCHAR(96) NULL, lease_token CHAR(64) NULL, lease_expires_at DATETIME NULL,
  attempt_count INT NOT NULL DEFAULT 0, max_attempts INT NOT NULL DEFAULT 5,
  available_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, last_error VARCHAR(96) NULL, processed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_runtime_outbox_dedupe (dedupe_key),
  KEY idx_agent_runtime_outbox_claim (status, available_at, id),
  KEY idx_agent_runtime_outbox_lease (lease_owner, lease_token),
  CONSTRAINT fk_agent_runtime_outbox_plan FOREIGN KEY (plan_id) REFERENCES st_agent_runtime_plans(id),
  CONSTRAINT fk_agent_runtime_outbox_role FOREIGN KEY (role_id) REFERENCES st_agent_runtime_roles(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='事件驱动runtime执行；dedupe+lease+fencing+retry+cancel'`)
await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_runtime_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  plan_id BIGINT UNSIGNED NOT NULL, role_id BIGINT UNSIGNED NULL, event_type VARCHAR(64) NOT NULL,
  actor_user_id BIGINT UNSIGNED NULL, payload_json JSON NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_agent_runtime_event_outbox (plan_id, id), KEY idx_agent_runtime_event_role (role_id, id),
  CONSTRAINT fk_agent_runtime_event_plan FOREIGN KEY (plan_id) REFERENCES st_agent_runtime_plans(id),
  CONSTRAINT fk_agent_runtime_event_role FOREIGN KEY (role_id) REFERENCES st_agent_runtime_roles(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='编排审计事件；不存密钥'`)
console.log(`agent runtime container schema ready (additive; mode=${economyMode})`)
await conn.end()
