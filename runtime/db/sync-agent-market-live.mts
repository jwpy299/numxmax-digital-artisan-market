import mysql from 'mysql2/promise'
import { AGENT_TEST_DATABASE_PREFIX } from '../api/lib/agentEconomy'
const url = process.argv[2] ?? process.env.DATABASE_URL
if (!url) throw new Error('必须显式传库 URL 或设置 DATABASE_URL')
const conn = await mysql.createConnection(url)
const economyMode = process.env.ECONOMY_MODE ?? 'production'
if (!['production', 'test'].includes(economyMode)) throw new Error('ECONOMY_MODE_INVALID')
if (economyMode === 'test' && process.env.NODE_ENV === 'production') throw new Error('ECONOMY_MODE_TEST_FORBIDDEN_IN_PRODUCTION')
if (economyMode === 'test' && process.env.AGENT_EMPLOYMENT_TEST_DATABASE !== '1') throw new Error('AGENT_EMPLOYMENT_TEST_DATABASE_REQUIRED')
const [rows]=await conn.query<mysql.RowDataPacket[]>('SELECT DATABASE() AS name')
if (economyMode === 'test' && !String(rows[0]?.name ?? '').startsWith(AGENT_TEST_DATABASE_PREFIX)) throw new Error('AGENT_MARKET_LIVE_TEST_DATABASE_REQUIRED')
const [columns] = await conn.query<mysql.RowDataPacket[]>("SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='st_agent_registrations' AND column_name IN ('showcase_opt_in','public_display_name')")
const registrationColumnNames = new Set(columns.map((row) => String(row.COLUMN_NAME)))
if (!registrationColumnNames.has('showcase_opt_in')) await conn.query("ALTER TABLE st_agent_registrations ADD COLUMN showcase_opt_in TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Agent 是否授权公开训练实习成绩；默认不公开'")
if (!registrationColumnNames.has('public_display_name')) await conn.query("ALTER TABLE st_agent_registrations ADD COLUMN public_display_name VARCHAR(80) NULL COMMENT '训练实习公开显示名，与 Agent 自填名称分离'")
const [taskColumns] = await conn.query<mysql.RowDataPacket[]>("SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='st_agent_work_tasks' AND column_name IN ('public_feed','public_actor_name')")
const taskColumnNames = new Set(taskColumns.map((row) => String(row.COLUMN_NAME)))
if (!taskColumnNames.has('public_feed')) await conn.query("ALTER TABLE st_agent_work_tasks ADD COLUMN public_feed TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否由企业显式授权进入公开实时大屏；默认不公开' AFTER status")
if (!taskColumnNames.has('public_actor_name')) await conn.query("ALTER TABLE st_agent_work_tasks ADD COLUMN public_actor_name VARCHAR(80) NULL COMMENT '企业自行填写的公开显示名，不直接暴露工商名称' AFTER public_feed")
await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_task_visibility_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  task_id BIGINT UNSIGNED NOT NULL,
  factory_id BIGINT UNSIGNED NOT NULL,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  from_feed TINYINT(1) NOT NULL,
  to_feed TINYINT(1) NOT NULL,
  public_actor_name VARCHAR(80) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_agent_task_visibility_task (task_id, id),
  KEY idx_agent_task_visibility_factory (factory_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='企业任务公开范围变更审计'`)
await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_showcase_visibility_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  registration_id BIGINT UNSIGNED NOT NULL,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  from_opt_in TINYINT(1) NOT NULL,
  to_opt_in TINYINT(1) NOT NULL,
  public_display_name VARCHAR(80) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_agent_showcase_visibility_registration (registration_id, id),
  KEY idx_agent_showcase_visibility_owner (owner_user_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='训练实习成绩公开授权变更审计'`)

const [feedIndexes] = await conn.query<mysql.RowDataPacket[]>("SELECT INDEX_NAME FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='st_agent_work_tasks' AND index_name='idx_agent_work_public_feed'")
if (feedIndexes.length === 0) await conn.query("ALTER TABLE st_agent_work_tasks ADD KEY idx_agent_work_public_feed (public_feed, status, deadline_at, created_at)")
console.log(`agent market live visibility ready (additive; mode=${economyMode})`)
await conn.end()
