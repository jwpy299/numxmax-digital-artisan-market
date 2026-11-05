/**
 * 迭代44 增量同步：B1 反馈环（st_artifact_feedback）。幂等，可重复执行。
 */
import mysql from "mysql2/promise";

const url = new URL(process.env.DATABASE_URL!);
const conn = await mysql.createConnection({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ""),
});

await conn.query(`
  CREATE TABLE IF NOT EXISTS st_artifact_feedback (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    artifact_id INT UNSIGNED NOT NULL,
    actor VARCHAR(64) NOT NULL,
    channel ENUM('admin','staff','meeting') NOT NULL,
    fb_signal ENUM('adopted','rejected') NOT NULL,
    note VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_artifact_actor (artifact_id, actor),
    KEY idx_signal_time (fb_signal, created_at),
    KEY idx_artifact (artifact_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`);
console.log("iter44 sync ok: st_artifact_feedback");
await conn.end();
