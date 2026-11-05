/**
 * 幂等同步迭代 19「部门账号分发体系 + 部门独立工作台」所需的新表：
 *   st_staff_accounts / st_staff_chat_threads / st_staff_chat_messages
 * 全部为 st_ 前缀新表（additive），不改 drizzle schema.ts，由 api/routers/staff.ts 用 raw SQL 访问。
 *
 * 不加任何种子账号：账号全部经由「总经理分发负责人 / 负责人分发员工」业务流程产生。
 *
 * 风格仿 db/sync-terminal.mts：raw mysql2 直连、information_schema 检测、DRY_RUN 早退。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-staff.mts
 * 语法自检：DRY_RUN=1 npx tsx db/sync-staff.mts（不连库，直接退出）
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

/** information_schema 检测后 CREATE TABLE（幂等） */
async function ensureTable(name: string, ddl: string) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [name],
  );
  if ((rows as unknown[]).length > 0) {
    console.log(`${name}: table exists, skip`);
  } else {
    await conn.query(ddl);
    console.log(`${name}: table created`);
  }
}

// ── 1. 部门账号表（负责人 head / 员工 staff；scrypt 密码；nt_ 单点 token）────────
await ensureTable(
  "st_staff_accounts",
  `CREATE TABLE st_staff_accounts (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     username VARCHAR(64) NOT NULL UNIQUE,
     passwordHash VARCHAR(160) NOT NULL,
     displayName VARCHAR(64) NOT NULL,
     deptKey VARCHAR(32) NOT NULL,
     role VARCHAR(16) NOT NULL DEFAULT 'staff',
     authToken VARCHAR(64) NULL,
     disabled TINYINT(1) NOT NULL DEFAULT 0,
     createdBy VARCHAR(64) NOT NULL DEFAULT 'admin',
     createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     INDEX idx_st_staff_dept (deptKey, role),
     INDEX idx_st_staff_token (authToken)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

// ── 2. 部门员工与驻部 Agent 单聊线程表 ─────────────────────────────────────────
await ensureTable(
  "st_staff_chat_threads",
  `CREATE TABLE st_staff_chat_threads (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     agentCode VARCHAR(32) NOT NULL,
     accountId BIGINT UNSIGNED NOT NULL,
     deptKey VARCHAR(32) NOT NULL,
     title VARCHAR(128) NOT NULL,
     createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     INDEX idx_st_staff_threads_account (accountId, agentCode),
     INDEX idx_st_staff_threads_dept (deptKey)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

// ── 3. 部门员工与驻部 Agent 单聊消息表 ─────────────────────────────────────────
await ensureTable(
  "st_staff_chat_messages",
  `CREATE TABLE st_staff_chat_messages (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     threadId BIGINT UNSIGNED NOT NULL,
     role VARCHAR(16) NOT NULL,
     content TEXT NOT NULL,
     provider VARCHAR(32) NULL,
     degraded TINYINT(1) NOT NULL DEFAULT 0,
     createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     INDEX idx_st_staff_msgs_thread (threadId)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

await conn.end();
console.log("sync-staff done");
