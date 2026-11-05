// M21 迁移：数字职业档案（本人授权驱动，设计 §3）——
// wb_career_entries 任职履历 / wb_skill_badges 技能徽章 / wb_career_shares 授权记录。
// 幂等：CREATE TABLE IF NOT EXISTS + information_schema 检测补索引；additive、绝不 drop。
// 运行（在 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-m21.mts
// 语法自检：DRY_RUN=1 npx tsx db/sync-m21.mts（不连库，直接退出）
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

/** information_schema 检测后补索引（additive，幂等） */
async function ensureIndex(table: string, index: string, ddl: string) {
  const [rows] = await conn.query(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, index],
  );
  if ((rows as unknown[]).length === 0) {
    await conn.query(ddl);
    console.log(`${table}.${index}: added`);
  }
}

// 任职履历：入编/离职事件自动记录（recordCareerEvent 钩子），status 默认 pending=待本人确认。
await conn.query(`CREATE TABLE IF NOT EXISTS wb_career_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  userId BIGINT UNSIGNED NOT NULL COMMENT '本人（档案主人）',
  factoryId BIGINT UNSIGNED NOT NULL COMMENT '任职企业',
  deptName VARCHAR(64) NULL COMMENT '部门名快照（入编时画像值）',
  role VARCHAR(32) NULL COMMENT '企业内角色快照（staff/manager）',
  startedAt DATETIME NOT NULL COMMENT '入编时间',
  endedAt DATETIME NULL COMMENT '离职时间（NULL=在职）',
  status ENUM('pending','confirmed','departed') NOT NULL DEFAULT 'pending' COMMENT '待本人确认|已确认|已离职',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("wb_career_entries: ok");

// 技能徽章：系统内培训/考核通过自动颁发（一期仅表结构，颁发接 M18 入职考试，二期完善）。
await conn.query(`CREATE TABLE IF NOT EXISTS wb_skill_badges (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  userId BIGINT UNSIGNED NOT NULL COMMENT '本人',
  skillKey VARCHAR(64) NOT NULL COMMENT '技能键',
  name VARCHAR(128) NOT NULL COMMENT '徽章名（展示）',
  factoryId BIGINT UNSIGNED NOT NULL COMMENT '颁发企业',
  issuedAt DATETIME NOT NULL COMMENT '颁发时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("wb_skill_badges: ok");

// 授权记录：本人 C 级动作，分项授权；revokedAt NULL=有效，置位=撤回（立即不可见）。
// 同一 userId+targetFactoryId+scope 有效授权至多一行（应用层幂等保证，不加唯一索引
// 以免与撤回重授权语义冲突——撤回行保留审计，重新授权插新行）。
await conn.query(`CREATE TABLE IF NOT EXISTS wb_career_shares (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  userId BIGINT UNSIGNED NOT NULL COMMENT '授权人（本人）',
  targetFactoryId BIGINT UNSIGNED NOT NULL COMMENT '被授权企业',
  scope ENUM('career','badges','achievements','proof') NOT NULL COMMENT '履历|徽章|成就|证明',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revokedAt DATETIME NULL COMMENT '撤回时间（NULL=有效）'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("wb_career_shares: ok");

await ensureIndex(
  "wb_career_entries",
  "wb_career_entries_user_idx",
  `ALTER TABLE wb_career_entries ADD INDEX wb_career_entries_user_idx (userId)`,
);
await ensureIndex(
  "wb_career_entries",
  "wb_career_entries_factory_idx",
  `ALTER TABLE wb_career_entries ADD INDEX wb_career_entries_factory_idx (factoryId)`,
);
await ensureIndex(
  "wb_skill_badges",
  "wb_skill_badges_user_idx",
  `ALTER TABLE wb_skill_badges ADD INDEX wb_skill_badges_user_idx (userId)`,
);
await ensureIndex(
  "wb_career_shares",
  "wb_career_shares_user_target_idx",
  `ALTER TABLE wb_career_shares ADD INDEX wb_career_shares_user_target_idx (userId, targetFactoryId)`,
);

await conn.end();
console.log("SYNC-M21-PASS");
