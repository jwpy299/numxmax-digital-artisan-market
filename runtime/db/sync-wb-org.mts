/**
 * 幂等同步迭代 21「组织架构智能配置（公司大脑 + 部门 Agent 数字员工）」所需的新表：
 *   wb_brain_agent / wb_dept_agents / wb_org_chat_threads / wb_org_chat_messages
 * 全部为 additive 新表，不改 drizzle schema.ts，由 api/routers/wbOrg.ts 用 raw SQL 访问。
 *
 * 风格仿 db/sync-staff.mts：raw mysql2 直连、information_schema 检测、DRY_RUN 早退。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-wb-org.mts
 * 语法自检：DRY_RUN=1 npx tsx db/sync-wb-org.mts（不连库，直接退出）
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

// ── 1. 公司大脑（每企业唯一）──────────────────────────────────────────────────
await ensureTable(
  "wb_brain_agent",
  `CREATE TABLE wb_brain_agent (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     factoryId BIGINT UNSIGNED NOT NULL UNIQUE,
     name VARCHAR(64) NOT NULL DEFAULT '公司大脑',
     persona TEXT NULL,
     systemPrompt TEXT NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'active',
     generatedBy VARCHAR(8) NOT NULL DEFAULT 'rule',
     createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

// ── 2. 部门 Agent 数字员工（factoryId+deptId 唯一）─────────────────────────────
await ensureTable(
  "wb_dept_agents",
  `CREATE TABLE wb_dept_agents (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     factoryId BIGINT UNSIGNED NOT NULL,
     deptId VARCHAR(64) NOT NULL,
     deptName VARCHAR(64) NOT NULL,
     agentName VARCHAR(64) NOT NULL,
     title VARCHAR(64) NOT NULL,
     systemPrompt TEXT NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'active',
     generatedBy VARCHAR(8) NOT NULL DEFAULT 'rule',
     createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     UNIQUE KEY wb_dept_agents_factory_dept_uniq (factoryId, deptId)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

// ── 3. 大脑 / 部门 Agent 对话线程（factoryId 作用域，userId 归属）─────────────
await ensureTable(
  "wb_org_chat_threads",
  `CREATE TABLE wb_org_chat_threads (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     factoryId BIGINT UNSIGNED NOT NULL,
     userId BIGINT UNSIGNED NOT NULL,
     targetType VARCHAR(16) NOT NULL,
     targetId VARCHAR(64) NOT NULL,
     title VARCHAR(128) NOT NULL,
     createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     INDEX idx_wb_org_threads_user (factoryId, userId, targetType, targetId)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

// ── 4. 对话消息（含 provider/degraded 降级标注）───────────────────────────────
await ensureTable(
  "wb_org_chat_messages",
  `CREATE TABLE wb_org_chat_messages (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     threadId BIGINT UNSIGNED NOT NULL,
     role VARCHAR(16) NOT NULL,
     content TEXT NOT NULL,
     provider VARCHAR(32) NULL,
     degraded TINYINT(1) NOT NULL DEFAULT 0,
     createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     INDEX idx_wb_org_msgs_thread (threadId)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

await conn.end();
console.log("sync-wb-org done");
