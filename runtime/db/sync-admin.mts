/**
 * 幂等同步迭代 17 Stage 3「灵枢星云NEBULA超级终端」所需的 additive 变更：
 * - wb_users.disabled TINYINT(1) NOT NULL DEFAULT 0（禁用语义；admin 路由 raw SQL 访问）
 * - wb_factories.disabled TINYINT(1) NOT NULL DEFAULT 0（同上）
 * - 幂等种子一个总管理员账号（已存在则跳过）：
 *   username=admin / displayName=星云总管理员 / kind=enterprise / role=admin / factoryId=1
 *   密码 Nebula@Admin2026（scrypt salt:hash，与 api/routers/wbSession.ts 同一算法）
 *
 * 风格仿 db/sync-nb-auth.mts：raw mysql2 直连、information_schema 检测、幂等。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-admin.mts
 * 语法自检：DRY_RUN=1 npx tsx db/sync-admin.mts（不连库，直接退出）
 */
if (process.env.DRY_RUN) {
  console.log("dry run ok");
  process.exit(0);
}

import { randomBytes, scryptSync } from "node:crypto";
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const conn = await mysql.createConnection(url);

/** scrypt 哈希（salt:hash，hex），与 agentic.ts / wbSession.ts 一致 */
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

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

// ── 1. additive 禁用列 ───────────────────────────────────────────────────────
await ensureColumn("wb_users", "disabled", "disabled TINYINT(1) NOT NULL DEFAULT 0");
await ensureColumn("wb_factories", "disabled", "disabled TINYINT(1) NOT NULL DEFAULT 0");

// ── 2. 幂等种子总管理员账号 ──────────────────────────────────────────────────
{
  const [rows] = await conn.query(`SELECT id FROM wb_users WHERE username = 'admin' LIMIT 1`);
  if ((rows as unknown[]).length > 0) {
    console.log("wb_users admin account: exists, skip");
  } else {
    const passwordHash = hashPassword("Nebula@Admin2026");
    await conn.query(
      `INSERT INTO wb_users (username, passwordHash, displayName, role, factoryId, kind)
       VALUES ('admin', ?, '星云总管理员', 'admin', 1, 'enterprise')`,
      [passwordHash],
    );
    console.log("wb_users admin account: seeded (username=admin)");
  }
}

await conn.end();
console.log("sync-admin done");
console.log("⚠ 默认密码 Nebula@Admin2026 请部署后立即修改（可在超级终端「用户管理」中重置）");
