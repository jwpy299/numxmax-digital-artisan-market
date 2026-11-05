/**
 * sync-iter55 —— 员工个体记忆：st_agent_memories。幂等。
 */
import mysql from "mysql2/promise";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);
await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_memories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agent_code VARCHAR(32) NOT NULL,
  actor VARCHAR(64) NOT NULL,
  kind ENUM('preference','fact','note') NOT NULL DEFAULT 'fact',
  content VARCHAR(255) NOT NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'auto',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mem (agent_code, actor, content)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
await conn.end();
console.log("SYNC_ITER55_OK");
