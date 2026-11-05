/**
 * M16「组织账号权限」幂等迁移（additive，只增不改不 drop）：
 * 1. wb_users.role 枚举纯加值：
 *    MODIFY COLUMN role ENUM('admin','owner','manager','staff','member') NOT NULL DEFAULT 'member'
 *    （MySQL 8 ENUM 末尾加值为秒级 INPLACE；不丢存量数据，读取侧归一见
 *      api/routers/wbSession.ts normalizeRole）
 * 2. wb_users additive 列：invitedBy BIGINT UNSIGNED NULL（邀请人审计）、
 *    activatedAt TIMESTAMP NULL（邀请激活时间）；disabled 幂等兜底（sync-admin.mts 已加）
 * 3. 新表 wb_invites：一次性组织邀请（iv_+48hex 明文只回一次，库只存 sha256）
 *
 * 风格仿 db/sync-admin.mts：raw mysql2 直连、information_schema 检测、幂等。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-m16.mts
 * 语法自检：DRY_RUN=1 npx tsx db/sync-m16.mts（不连库，直接退出）
 *
 * 可选归一（读取侧已兜底，默认不跑）：RUN_ROLE_NORMALIZE=1 时执行
 *   UPDATE wb_users SET role='manager' WHERE role='member'
 *     AND id IN (SELECT userId FROM wb_dept_heads)
 *   —— 幂等 UPDATE，将存量部门负责人显式改写为 manager。
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

/** information_schema 检测后 ADD COLUMN（additive，幂等） */
async function ensureColumn(table: string, column: string, ddl: string) {
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  if ((cols as unknown[]).length > 0) {
    console.log(`${table}.${column}: column exists, skip`);
  } else {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`${table}.${column}: column added`);
  }
}

/** information_schema 检测后 CREATE INDEX（幂等） */
async function ensureIndex(table: string, index: string, ddl: string) {
  const [rows] = await conn.query(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, index],
  );
  if ((rows as unknown[]).length > 0) {
    console.log(`${table}.${index}: index exists, skip`);
  } else {
    await conn.query(`ALTER TABLE ${table} ADD INDEX ${ddl}`);
    console.log(`${table}.${index}: index added`);
  }
}

// ── 1. wb_users.role 枚举纯加值（比对 COLUMN_TYPE，幂等）─────────────────────
{
  const TARGET = "enum('admin','owner','manager','staff','member')";
  const [rows] = await conn.query(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wb_users' AND COLUMN_NAME = 'role'`,
  );
  const current = String((rows as Array<{ COLUMN_TYPE: string }>)[0]?.COLUMN_TYPE ?? "");
  if (current.toLowerCase() === TARGET) {
    console.log(`wb_users.role: enum already ${TARGET}, skip`);
  } else {
    await conn.query(
      `ALTER TABLE wb_users MODIFY COLUMN role ENUM('admin','owner','manager','staff','member') NOT NULL DEFAULT 'member'`,
    );
    console.log(`wb_users.role: enum widened ${current || "(unknown)"} -> ${TARGET}`);
  }
}

// ── 2. wb_users additive 列 ──────────────────────────────────────────────────
await ensureColumn("wb_users", "invitedBy", "invitedBy BIGINT UNSIGNED NULL");
await ensureColumn("wb_users", "activatedAt", "activatedAt TIMESTAMP NULL");
await ensureColumn("wb_users", "disabled", "disabled TINYINT(1) NOT NULL DEFAULT 0");

// ── 3. 新表 wb_invites（一次性邀请码，库只存 sha256）─────────────────────────
await conn.query(`CREATE TABLE IF NOT EXISTS wb_invites (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factoryId BIGINT UNSIGNED NOT NULL COMMENT '企业隔离',
  codeHash VARCHAR(64) NOT NULL COMMENT 'sha256(明文码 iv_+48hex)',
  displayName VARCHAR(64) NOT NULL COMMENT '受邀者姓名（落地页预填）',
  deptId VARCHAR(64) NOT NULL COMMENT '必须 ∈ factory.departments',
  role ENUM('manager','staff') NOT NULL COMMENT '邀请只能发这两级',
  inviterId BIGINT UNSIGNED NOT NULL COMMENT '发起人（admin）',
  expiresAt TIMESTAMP NOT NULL COMMENT '默认 72h，可配 24h~7d',
  consumedAt TIMESTAMP NULL COMMENT '一次性：accept 成功即写',
  revokedAt TIMESTAMP NULL COMMENT '吊销',
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY wb_invites_codeHash_uniq (codeHash)
)`);
console.log("wb_invites: table ensured");
await ensureIndex("wb_invites", "wb_invites_factory_idx", "wb_invites_factory_idx (factoryId)");
await ensureIndex("wb_invites", "wb_invites_expires_idx", "wb_invites_expires_idx (expiresAt)");

// ── 4. 可选幂等归一：存量部门负责人 member → manager（默认不跑，读取侧归一已兜底）──
if (process.env.RUN_ROLE_NORMALIZE) {
  const [res] = await conn.query(
    `UPDATE wb_users SET role = 'manager'
     WHERE role = 'member' AND id IN (SELECT userId FROM wb_dept_heads)`,
  );
  console.log(
    `wb_users role normalize: affectedRows=${(res as { affectedRows?: number }).affectedRows ?? 0}`,
  );
} else {
  console.log("wb_users role normalize: skipped (set RUN_ROLE_NORMALIZE=1 to enable)");
}

await conn.end();
console.log("sync-m16 done");
