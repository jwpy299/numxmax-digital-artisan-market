/**
 * sync-ent-cabin：企业舱位制（2026-08-31 彭总定稿：按灵智枢分舱法给企业分舱）。
 * st_ent_cabins：企业舱位（行业预置 + x_ 自建）——舱主真人 + 数字员工责任人制。
 * st_cabin_tasks：舱内任务（双轨：assignee_user 真人 / assignee_agent 数字员工，二选一）。
 * additive 幂等。
 */
import mysql from "mysql2/promise";

const url = process.argv[2] ?? (() => { throw new Error("必须显式传库 URL"); })();
const conn = await mysql.createConnection(url);

await conn.query(`CREATE TABLE IF NOT EXISTS st_ent_cabins (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factory_id BIGINT UNSIGNED NOT NULL,
  code VARCHAR(24) NOT NULL COMMENT '舱码：行业预置（produce/quality/purchase/sales/finance/admin）或 x_ 自建',
  name VARCHAR(32) NOT NULL COMMENT '舱名（生产舱/质量舱…）',
  head_user_id BIGINT UNSIGNED NULL COMMENT '舱主（真人；验收签字归他）',
  sort INT NOT NULL DEFAULT 0,
  disabled TINYINT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_cabin (factory_id, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='企业舱位（舱位制）'`);

await conn.query(`CREATE TABLE IF NOT EXISTS st_cabin_tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factory_id BIGINT UNSIGNED NOT NULL,
  cabin_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(128) NOT NULL,
  brief TEXT NULL,
  assignee_user_id BIGINT UNSIGNED NULL COMMENT '派给真人',
  assignee_agent_id BIGINT UNSIGNED NULL COMMENT '派给数字员工（st_ent_agents.id）',
  status VARCHAR(12) NOT NULL DEFAULT 'open' COMMENT 'open/done/cancelled',
  done_by BIGINT UNSIGNED NULL,
  done_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ct_cabin (cabin_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='舱内任务（人机双轨）'`);

console.log("st_ent_cabins + st_cabin_tasks: ready");
await conn.end();
