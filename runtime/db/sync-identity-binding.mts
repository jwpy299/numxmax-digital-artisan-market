/**
 * sync-identity-binding：个人/企业 APP 绑定（2026-08-26 彭总设计定调）。
 * 口径：人是根（wb_users kind=person 唯一身份根），企业身份是成员关系（本表）。
 * 一人多企、邀请制绑定（本人确认才生效）、双向隔离、信用随人走。
 * additive 幂等；不改动 wb_users/enterprises 任何既有行为。
 */
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

const url = process.argv[2] ?? (() => { throw new Error("必须显式传库 URL（v147 教训：env 文件指旧库）"); })();
const conn = await mysql.createConnection(url);

await conn.query(`CREATE TABLE IF NOT EXISTS st_identity_bindings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL COMMENT '身份根：wb_users.id（kind=person）',
  factory_id BIGINT UNSIGNED NOT NULL COMMENT '企业/组织工厂（数据强隔离键）',
  org_role VARCHAR(16) NOT NULL DEFAULT 'staff' COMMENT '组织内角色：admin/manager/staff',
  invited_by BIGINT UNSIGNED NULL COMMENT '邀请人 wb_users.id（审计）',
  invite_channel VARCHAR(16) NULL COMMENT '邀请渠道：sms/scan/manual',
  status VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending=待本人确认/active/revoked',
  bound_at DATETIME NULL COMMENT '本人确认时间（确权点，企业不得单方面生效）',
  revoked_at DATETIME NULL COMMENT '解绑时间（离职脱钩：企业数据留厂，信用随人走）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_factory (user_id, factory_id),
  KEY idx_binding_factory (factory_id, status),
  KEY idx_binding_user (user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='个人-企业身份绑定（一人多企，邀请制确权）'`);
console.log("st_identity_bindings: ready");
await conn.end();
console.log("sync-identity-binding: done");
