/**
 * sync-iter75h —— 静默失败观测表（iter75.5-A3）
 * 幂等：CREATE TABLE IF NOT EXISTS。跑两遍应无差异。
 */
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");

const conn = await mysql.createConnection(url);
await conn.execute(`
CREATE TABLE IF NOT EXISTS st_silent_errors (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tag VARCHAR(64) NOT NULL,
  message VARCHAR(300) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tag (tag),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_silent_errors ensured");
await conn.end();
