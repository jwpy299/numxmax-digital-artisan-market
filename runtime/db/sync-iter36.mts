/**
 * 幂等同步 iter36「临时协同会 + 纪要抄送」所需的 additive 变更：
 *   st_meetings 加列：meetingType / participants / projectTag / ccDepts / ccStatus
 *   新表：st_meeting_inbox（纪要抄送收件箱）
 * 全部 additive：只加列加表，不改旧列语义；由 api/routers/terminal.ts 用 raw SQL 访问，不改 drizzle schema。
 *
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-iter36.mts
 * 语法自检：DRY_RUN=1 npx tsx db/sync-iter36.mts（不连库，直接退出）
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

async function ensureColumn(table: string, column: string, ddl: string) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  if ((rows as unknown[]).length > 0) {
    console.log(`${table}.${column}: exists, skip`);
  } else {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`${table}.${column}: added`);
  }
}

// ── st_meetings additive 列 ──────────────────────────────────────────────────
await ensureColumn(
  "st_meetings",
  "meetingType",
  "meetingType VARCHAR(16) NOT NULL DEFAULT 'full' AFTER status",
);
await ensureColumn(
  "st_meetings",
  "participants",
  "participants JSON NULL COMMENT 'partial 会议的参会部门 deptKey 列表'",
);
await ensureColumn("st_meetings", "projectTag", "projectTag VARCHAR(64) NULL COMMENT '项目标签，归档检索'");
await ensureColumn("st_meetings", "ccDepts", "ccDepts JSON NULL COMMENT '纪要抄送部门列表'");
await ensureColumn(
  "st_meetings",
  "ccStatus",
  "ccStatus VARCHAR(16) NOT NULL DEFAULT 'none' COMMENT 'none/pending/sent'",
);

// ── 纪要抄送收件箱 ───────────────────────────────────────────────────────────
await ensureTable(
  "st_meeting_inbox",
  `CREATE TABLE st_meeting_inbox (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     meetingId BIGINT UNSIGNED NOT NULL,
     deptKey VARCHAR(64) NOT NULL,
     readAt TIMESTAMP NULL,
     dispatchedThreadId BIGINT UNSIGNED NULL,
     createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     UNIQUE KEY uq_st_mtinbox (meetingId, deptKey),
     INDEX idx_st_mtinbox_dept (deptKey)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

await conn.end();
console.log("sync-iter36 done");
