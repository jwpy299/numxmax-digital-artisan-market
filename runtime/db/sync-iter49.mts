/**
 * sync-iter49 —— 龙虾 P2 第一刀：实例注册表 + 操作单实例维度。
 * 幂等：可重复执行。运行：set -a && . ./.env && set +a && npx tsx db/sync-iter49.mts
 */
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");

const conn = await mysql.createConnection(url);

await conn.query(`CREATE TABLE IF NOT EXISTS st_claw_instances (
  id INT AUTO_INCREMENT PRIMARY KEY,
  instance_key VARCHAR(32) NOT NULL UNIQUE,
  display_name VARCHAR(64) NOT NULL,
  container_name VARCHAR(64) NOT NULL,
  agent_id VARCHAR(32) NOT NULL DEFAULT 'main',
  status ENUM('active','paused','retired') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

// 操作单加实例维度（幂等：先查 information_schema）
const [cols] = await conn.query(
  `SELECT COLUMN_NAME FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_claw_operations' AND COLUMN_NAME = 'instance_key'`,
);
if ((cols as unknown[]).length === 0) {
  await conn.query(
    `ALTER TABLE st_claw_operations ADD COLUMN instance_key VARCHAR(32) NOT NULL DEFAULT 'main' AFTER op_no`,
  );
  await conn.query(`ALTER TABLE st_claw_operations ADD INDEX idx_instance_status (instance_key, status)`);
}

// 默认实例落账（幂等）
await conn.query(
  `INSERT IGNORE INTO st_claw_instances (instance_key, display_name, container_name, agent_id)
   VALUES ('main', '龙虾·主实例', 'orgclaw-p0', 'main')`,
);

await conn.end();
console.log("SYNC_ITER49_OK");
