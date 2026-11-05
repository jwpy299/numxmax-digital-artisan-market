/**
 * sync-hire-orders：雇佣工单闭环（2026-08-30 彭总拍板六刀之第一刀）。
 * st_hire_orders：一单到底——order_no 从派单活到结算，五端同认。
 * 状态机：dispatched→running→delivered→accepted/rejected/cancelled。
 * additive 幂等。
 */
import mysql from "mysql2/promise";

const url = process.argv[2] ?? (() => { throw new Error("必须显式传库 URL"); })();
const conn = await mysql.createConnection(url);

await conn.query(`CREATE TABLE IF NOT EXISTS st_hire_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_no VARCHAR(32) NOT NULL UNIQUE COMMENT '工单号 HO-<hireId>-<seq>（一单到底）',
  factory_id BIGINT UNSIGNED NOT NULL COMMENT '雇主企业',
  hire_record_id BIGINT UNSIGNED NOT NULL COMMENT '雇佣合约 agent_hire_records.id',
  agent_id BIGINT UNSIGNED NOT NULL COMMENT '干活的数字员工',
  owner_user_id BIGINT UNSIGNED NULL COMMENT '分身主人（个人分身被雇时有值）',
  title VARCHAR(128) NOT NULL,
  brief TEXT NULL COMMENT '任务说明',
  status VARCHAR(12) NOT NULL DEFAULT 'dispatched' COMMENT 'dispatched已派/running干活中/delivered已交付/accepted已验收/rejected已驳回/cancelled已取消',
  deliverable MEDIUMTEXT NULL COMMENT '交付物文本',
  token_settle INT NULL COMMENT '验收结算词元（验收时落）',
  accepted_by BIGINT UNSIGNED NULL,
  accepted_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_ho_factory (factory_id, status),
  KEY idx_ho_owner (owner_user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='雇佣工单（五端贯穿一单号）'`);

console.log("st_hire_orders: ready");
await conn.end();
