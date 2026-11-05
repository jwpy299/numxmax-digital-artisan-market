/**
 * 迭代 37 · 部门班组（多 Agent 同事 + 并行协同 + 四权介入）—— additive 幂等迁移。
 *
 * 变更：
 *  1. 新表 st_dept_mates：部门班组同事位（lead 主理 = 现有 st_agents 驻部智能体，零迁移；
 *     本表仅存 mate 班组同事），按 deptKey 作用域（与 st_meetings/st_meeting_inbox 同口径）。
 *  2. 新表 st_swarm_tasks：协同任务（确定性状态机：
 *     draft → running → await_review → done；paused/cancelled 旁路）。
 *  3. 新表 st_swarm_subtasks：子任务（按 seatType lead/mate 指向 st_agents / st_dept_mates）。
 *  4. 新表 st_swarm_interventions：人工介入留痕（插话/单点暂停/恢复/换人重派/全局叫停/拍板）。
 *
 * 口径适配说明：方案原稿以 wb_dept_agents(factoryId) 为载体；超级终端侧 staff 账号无 factoryId，
 * 为与迭代 36（会议/抄送，deptKey 作用域）保持一致，本迭代以 deptKey 作用域落地，
 * P8 越权验收 = 跨部门不可见不可控（FORBIDDEN）。
 *
 * 运行：set -a && . ./.env && set +a && npx tsx db/sync-iter37.mts
 * 只增不改：仅 CREATE TABLE IF NOT EXISTS；重复执行无副作用。
 */
import { createConnection } from "mysql2/promise";

const url = new URL(process.env.DATABASE_URL!);
const conn = await createConnection({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.slice(1),
});

const DRY_RUN = process.env.DRY_RUN === "1";

async function ensureTable(name: string, createSql: string): Promise<void> {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [name],
  );
  const exists = Array.isArray(rows) && rows.length > 0;
  if (exists) {
    console.log(`[skip] table ${name} 已存在`);
    return;
  }
  if (DRY_RUN) {
    console.log(`[dry-run] 将创建表 ${name}`);
    return;
  }
  await conn.query(createSql);
  console.log(`[done] 创建表 ${name}`);
}

// ── 1. 部门班组同事位（mate；lead = st_agents 驻部智能体，隐含零迁移）─────────────
await ensureTable(
  "st_dept_mates",
  `CREATE TABLE st_dept_mates (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     deptKey VARCHAR(32) NOT NULL,
     agentName VARCHAR(64) NOT NULL,
     title VARCHAR(64) NOT NULL DEFAULT '班组同事',
     preferredModel VARCHAR(16) NOT NULL DEFAULT 'glm',
     specialty VARCHAR(64) NULL,
     budgetDaily INT NULL,
     tokensToday INT NOT NULL DEFAULT 0,
     tokensDate DATE NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'active',
     systemPrompt TEXT NULL,
     createdBy VARCHAR(64) NOT NULL DEFAULT 'admin',
     createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     INDEX idx_st_mates_dept (deptKey, status)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

// ── 2. 协同任务（swarm）─────────────────────────────────────────────────────────
await ensureTable(
  "st_swarm_tasks",
  `CREATE TABLE st_swarm_tasks (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     deptKey VARCHAR(32) NOT NULL,
     title VARCHAR(128) NOT NULL,
     instruction TEXT NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'draft',
     budgetCap INT NULL,
     tokensUsed INT NOT NULL DEFAULT 0,
     budgetBlocked TINYINT(1) NOT NULL DEFAULT 0,
     summary MEDIUMTEXT NULL,
     summaryProvider VARCHAR(64) NULL,
     summaryDegraded TINYINT(1) NOT NULL DEFAULT 0,
     createdBy VARCHAR(64) NOT NULL,
     createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     INDEX idx_st_swarm_dept (deptKey, status)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

// ── 3. 子任务 ──────────────────────────────────────────────────────────────────
await ensureTable(
  "st_swarm_subtasks",
  `CREATE TABLE st_swarm_subtasks (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     swarmId BIGINT UNSIGNED NOT NULL,
     seq INT NOT NULL DEFAULT 1,
     seatType VARCHAR(8) NOT NULL DEFAULT 'mate',
     seatId BIGINT UNSIGNED NOT NULL,
     seatName VARCHAR(64) NOT NULL,
     model VARCHAR(16) NOT NULL DEFAULT 'glm',
     specialty VARCHAR(64) NULL,
     brief TEXT NOT NULL,
     instructionExtra TEXT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'queued',
     output MEDIUMTEXT NULL,
     provider VARCHAR(64) NULL,
     degraded TINYINT(1) NOT NULL DEFAULT 0,
     tokensUsed INT NOT NULL DEFAULT 0,
     startedAt TIMESTAMP NULL,
     finishedAt TIMESTAMP NULL,
     INDEX idx_st_sub_swarm (swarmId, status)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

// ── 4. 人工介入留痕 ─────────────────────────────────────────────────────────────
await ensureTable(
  "st_swarm_interventions",
  `CREATE TABLE st_swarm_interventions (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     swarmId BIGINT UNSIGNED NOT NULL,
     subtaskId BIGINT UNSIGNED NULL,
     actor VARCHAR(64) NOT NULL,
     action VARCHAR(16) NOT NULL,
     payload JSON NULL,
     createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     INDEX idx_st_iv_swarm (swarmId, createdAt)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

await conn.end();
console.log("iter37 sync 完成");
