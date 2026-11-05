/**
 * sync-iter101 —— M64 超终专属注册/登录通道两表（幂等）：
 * - st_admin_accounts：超终原生管理员账号（与 wb_users 解耦，scrypt，nt_ 单点 token）
 * - st_admin_applications：注册申请（pending→approved/rejected 审批流，邀请码仅记录不直通）
 */
import mysql from "mysql2/promise";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

await conn.query(`CREATE TABLE IF NOT EXISTS st_admin_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  phone VARCHAR(32) NULL DEFAULT NULL,
  passwordHash VARCHAR(128) NOT NULL,
  displayName VARCHAR(64) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'admin',
  disabled TINYINT NOT NULL DEFAULT 0,
  authToken VARCHAR(128) NULL DEFAULT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lastLoginAt TIMESTAMP NULL DEFAULT NULL,
  UNIQUE KEY uk_admin_username (username),
  INDEX idx_admin_token (authToken)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

await conn.query(`CREATE TABLE IF NOT EXISTS st_admin_applications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  phone VARCHAR(32) NOT NULL,
  displayName VARCHAR(64) NOT NULL,
  reason VARCHAR(500) NOT NULL DEFAULT '',
  inviteCode VARCHAR(64) NULL DEFAULT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  reviewedBy VARCHAR(64) NULL DEFAULT NULL,
  reviewedAt TIMESTAMP NULL DEFAULT NULL,
  reviewNote VARCHAR(300) NULL DEFAULT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_appl_status (status),
  INDEX idx_appl_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

await conn.end();
console.log("SYNC_ITER101_OK");
