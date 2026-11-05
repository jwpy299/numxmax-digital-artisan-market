/**
 * sync-report-bus：汇报总线（2026-08-26 彭总令）。
 * st_report_events：环/部门智能体 → 个人APP/组织APP 的汇报事实表。
 * 纪律：dedupe_key 唯一（主动≠骚扰）；收件人路由走 st_identity_bindings；
 * factoryId 服务端口径；每用户每日上限字段在库（R3）。
 */
import mysql from "mysql2/promise";

const url = process.argv[2] ?? (() => { throw new Error("必须显式传库 URL"); })();
const conn = await mysql.createConnection(url);

await conn.query(`CREATE TABLE IF NOT EXISTS st_report_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  audience VARCHAR(16) NOT NULL COMMENT 'personal=个人APP / factory=组织APP',
  user_id BIGINT UNSIGNED NULL COMMENT '个人收件人（audience=personal 必填）',
  factory_id BIGINT UNSIGNED NULL COMMENT '组织收件厂（audience=factory 必填；投递时按 identity_bindings 展开到成员）',
  level VARCHAR(8) NOT NULL DEFAULT 'info' COMMENT 'info=站内 / action=待办强提醒 / alert=C级告警',
  source_ring VARCHAR(32) NULL COMMENT '来源环/部门：prober/dispatch/conveyor/dept:tech 等',
  title VARCHAR(128) NOT NULL,
  body VARCHAR(1024) NOT NULL COMMENT '结论+一个动作，详情进工作台',
  action_url VARCHAR(255) NULL,
  dedupe_key VARCHAR(128) NOT NULL COMMENT '查重键（同 key 永不重发）',
  status VARCHAR(8) NOT NULL DEFAULT 'pending' COMMENT 'pending/sent/read',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at DATETIME NULL,
  read_at DATETIME NULL,
  UNIQUE KEY uk_report_dedupe (dedupe_key),
  KEY idx_report_user (user_id, status, created_at),
  KEY idx_report_factory (factory_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='汇报总线事件（环→APP）'`);

// R3 节流：免打扰时段与每日上限做成账户级设置列（additive 到 wb_users 不如独立表干净——独立表）
await conn.query(`CREATE TABLE IF NOT EXISTS st_report_prefs (
  user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY COMMENT 'wb_users.id',
  daily_cap INT NOT NULL DEFAULT 10 COMMENT '每日汇报上限（防骚扰护栏）',
  quiet_start VARCHAR(5) NOT NULL DEFAULT '22:00' COMMENT '免打扰起（HH:mm）',
  quiet_end VARCHAR(5) NOT NULL DEFAULT '08:00' COMMENT '免打扰止',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='汇报节流偏好（主动≠骚扰）'`);

console.log("st_report_events + st_report_prefs: ready");
await conn.end();
console.log("sync-report-bus: done");
