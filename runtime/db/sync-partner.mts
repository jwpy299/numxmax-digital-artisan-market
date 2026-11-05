/**
 * sync-partner：城市合伙人/代理人申请通道（2026-08-30 彭总令：APP 上此模块）。
 * st_partner_leads：申请单（城市/角色/联系方式/状态：pending→contacted→signed→rejected）。
 * additive 幂等。
 */
import mysql from "mysql2/promise";

const url = process.argv[2] ?? (() => { throw new Error("必须显式传库 URL"); })();
const conn = await mysql.createConnection(url);

await conn.query(`CREATE TABLE IF NOT EXISTS st_partner_leads (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL COMMENT '申请人 wb_users.id',
  city VARCHAR(16) NOT NULL COMMENT '城市码',
  role VARCHAR(12) NOT NULL COMMENT 'partner城市合伙人/agent城市代理人',
  contact_name VARCHAR(64) NOT NULL,
  contact_phone VARCHAR(24) NOT NULL,
  note VARCHAR(500) NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'pending' COMMENT 'pending待联系/contacted已联系/signed已签约/rejected已驳回',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_partner_city (city, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='城市合伙人/代理人申请单'`);

console.log("st_partner_leads: ready");
await conn.end();
