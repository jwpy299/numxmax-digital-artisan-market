/**
 * sync-agent-review：P2-4（台账 W3）数字员工审核留痕三列（additive，幂等）。
 *
 * 缺口：agents.status = enum('pending','active','suspended','rejected') 有状态机，
 * 但**无操作入口、无留痕** —— 77 条 pending 只进不出。本脚本只补留痕列，
 * 对齐 devListings 既有约定（status + listedAt + 审核三件套）。
 *
 * 加列（全部 NULL-able、不改既有列、不加默认值 → 对存量 47 条 active 零影响）：
 * - reviewedAt   TIMESTAMP   NULL  审核时间（approve/reject 时写）
 * - reviewedBy   VARCHAR(64) NULL  审核人（admin id 留痕，与 st_admin_audit 双写）
 * - rejectReason VARCHAR(255) NULL 驳回理由（agentReview.reject 服务端强制非空才写）
 *
 * ⚠️ C 级双签面：本脚本**不在施工中执行**。Owner 签后由运维对 wb_rebuild 执行：
 *     set -a && . ./.env && set +a && npx tsx db/sync-agent-review.mts
 * 沙箱预演（可写库 wb_sandbox）：
 *     DATABASE_URL='mysql://root:...@127.0.0.1:3307/wb_sandbox' npx tsx db/sync-agent-review.mts
 *
 * 幂等：information_schema.COLUMNS 逐列检查后 ADD COLUMN；重复执行输出全 skip。
 * 风格仿 db/sync-admin.mts（raw mysql2 直连、information_schema 检测、DRY_RUN 早退）。
 * 语法自检：DRY_RUN=1 npx tsx db/sync-agent-review.mts（不连库，直接退出）
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
    await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
    console.log(`${table}.${column}: column added`);
  }
}

// ── 0. 表存在性（部分环境未 sync 过匠市表）────────────────────────────────────
{
  const [t] = await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agents'`,
  );
  if ((t as unknown[]).length === 0) {
    console.error("agents 表不存在，跳过（先跑建表 sync）");
    await conn.end();
    process.exit(1);
  }
}

// ── 1. additive 审核留痕三列 ─────────────────────────────────────────────────
// AFTER listedAt：与方案 2.1 的 DDL 位置一致（排列仅供可读，语义无依赖）
await ensureColumn("agents", "reviewedAt", "reviewedAt TIMESTAMP NULL AFTER `listedAt`");
await ensureColumn("agents", "reviewedBy", "reviewedBy VARCHAR(64) NULL AFTER `reviewedAt`");
await ensureColumn("agents", "rejectReason", "rejectReason VARCHAR(255) NULL AFTER `reviewedBy`");

// ── 2. 列就位后自证（只读回读 information_schema，失败即非零退出）──────────────
{
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agents'
        AND COLUMN_NAME IN ('reviewedAt','reviewedBy','rejectReason')
      ORDER BY ORDINAL_POSITION`,
  );
  const rows = cols as { COLUMN_NAME: string; IS_NULLABLE: string; COLUMN_TYPE: string }[];
  console.log("verify:", JSON.stringify(rows));
  if (rows.length !== 3 || rows.some((r) => r.IS_NULLABLE !== "YES")) {
    console.error("三列未全部就位或非 NULL-able —— 中止（不改任何既有列）");
    await conn.end();
    process.exit(1);
  }
}

await conn.end();
console.log("sync-agent-review done");
