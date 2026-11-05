/**
 * 迭代47 增量同步：龙虾 P1 操作审计（st_claw_operations）。幂等。
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
  CREATE TABLE IF NOT EXISTS st_claw_operations (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    op_no VARCHAR(24) NOT NULL UNIQUE,
    actor VARCHAR(64) NOT NULL,
    task VARCHAR(1000) NOT NULL,
    domain VARCHAR(128) NULL,
    risk ENUM('low','high') NOT NULL DEFAULT 'low',
    status ENUM('pending','rejected','running','done','failed') NOT NULL DEFAULT 'pending',
    reply TEXT NULL,
    evidence_artifact_id INT UNSIGNED NULL,
    error VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    finished_at TIMESTAMP NULL,
    KEY idx_status (status),
    KEY idx_actor (actor)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`);
console.log("iter47 sync ok: st_claw_operations");
await conn.end();
