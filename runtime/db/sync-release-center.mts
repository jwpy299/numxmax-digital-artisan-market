/**
 * 幂等同步 M51「超级终端系统更新机制」三表：
 *
 * 背景（彭总口径）：灵枢 APP / 星云 / 智能工作台 / 数字员工超市的更新维护统一收口到
 * 超级终端管理后台；发布/回滚为 C 级动作，必须双签票据，全程审计。
 *
 * 三表（平台级，无 factory_id——四端产物是全平台一套，租户隔离不适用；
 * 入口守卫 requireHqAdmin 保证仅本厂可操作）：
 * - st_releases：版本台账（channel×version 唯一；状态机 draft→verified→published→rolled_back）；
 * - st_release_tickets：双签一次性票据（publish/rollback；created_by≠confirmed_by；原子消费）；
 * - st_release_audit：状态迁移流水（谁、何时、哪版、何动作、票据号、细节 JSON）。
 *
 * 幂等：CREATE TABLE IF NOT EXISTS；重复执行无副作用。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-release-center.mts
 * 语法自检：DRY_RUN=1 npx tsx db/sync-release-center.mts（不连库，直接退出）
 */
if (process.env.DRY_RUN) {
  console.log("dry run ok");
  process.exit(0);
}

import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const conn = await mysql.createConnection(url);

await conn.query(`CREATE TABLE IF NOT EXISTS st_releases (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  channel VARCHAR(16) NOT NULL COMMENT '发布通道（app_apk/wb/admin/portal/server）',
  version VARCHAR(32) NOT NULL COMMENT '版本号（如 v2.1.0）',
  artifact_uri VARCHAR(300) NULL COMMENT '制品位置（APK URL / dist 快照目录 / 镜像tag）',
  md5 VARCHAR(32) NULL COMMENT '制品 md5（8 位短码或全码，与 verifier 记录口径一致）',
  status VARCHAR(16) NOT NULL DEFAULT 'draft' COMMENT '状态机（draft/verified/published/rolled_back）',
  verifier VARCHAR(32) NULL COMMENT '验证闸编号（如 v124）',
  report_ref VARCHAR(300) NULL COMMENT '验证报告引用（verifier/runs 文件或摘要）',
  note VARCHAR(300) NULL COMMENT '版本说明',
  created_by VARCHAR(64) NOT NULL COMMENT '提案人',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TIMESTAMP NULL COMMENT '全量发布时间',
  UNIQUE KEY uq_st_rel_channel_version (channel, version),
  INDEX idx_st_rel_channel_status (channel, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_releases: ok");

await conn.query(`CREATE TABLE IF NOT EXISTS st_release_tickets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_no VARCHAR(48) NOT NULL COMMENT '票据号（RLT- 前缀）',
  release_id BIGINT NOT NULL COMMENT '目标版本（st_releases.id）',
  action VARCHAR(16) NOT NULL COMMENT '动作（publish/rollback）',
  status VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending/consumed（一次性）',
  created_by VARCHAR(64) NOT NULL COMMENT '发起人',
  confirmed_by VARCHAR(64) NULL COMMENT '双签确认人（必须与发起人不同）',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  consumed_at TIMESTAMP NULL,
  UNIQUE KEY uq_st_relt_no (ticket_no),
  INDEX idx_st_relt_release (release_id, action, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_release_tickets: ok");

await conn.query(`CREATE TABLE IF NOT EXISTS st_release_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  release_id BIGINT NULL COMMENT '关联版本（票据申请可无版本）',
  channel VARCHAR(16) NULL,
  actor VARCHAR(64) NOT NULL COMMENT '操作人',
  action VARCHAR(48) NOT NULL COMMENT '动作（propose/verify/ticket:publish/confirm:publish/rollback 等）',
  detail TEXT NULL COMMENT '细节 JSON（已过 stripSecrets）',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_st_rela_release (release_id, created_at),
  INDEX idx_st_rela_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_release_audit: ok");

await conn.end();
console.log("SYNC-RELEASE-CENTER-PASS");
