/**
 * Harness H1 迁移「技能真实化审计」第一波：执行器登记列 + 回填（幂等）。
 *
 * 1. st_skills 加列 executor_kind VARCHAR(32) NULL（raw SQL 管理表，sync-ops.mts 建表）：
 *    回填数据源 = api/routers/skillExecutor.ts 的 SKILL_EXECUTOR_MAP（专用 6 + 通用 14 共 20 个）；
 *    专用工具统一记 'tool'，通用类记各自 llm_*；无执行器的技能记 NULL（徽标口径 = 生成式）。
 * 2. 匠市 skills 表（drizzle schema.ts）加列 executorKind VARCHAR(32) NULL：
 *    与 st_skills 同名（name 匹配）的技能继承其 executor_kind（NULL 视为无真执行器）；
 *    无同名映射的记 'generic'（生成式兜底，徽标 = 生成式）。
 *
 * 幂等：information_schema 逐列检查后 additive ALTER；回填 UPDATE 可重复执行无副作用。
 * 风格仿 db/sync-ops.mts：raw mysql2 直连、DRY_RUN 早退。
 *
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-h1.mts
 * 语法自检：DRY_RUN=1 npx tsx db/sync-h1.mts（不连库，直接退出）
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REGISTRY_TABLES = ["st_skills", "skills"] as const;

/** 登记执行器类型全集（与 api/routers/skillStats.ts RegisteredExecutorKind 对齐） */
const KIND_VALUES = ["tool", "llm_doc", "llm_analysis", "llm_kb_qa", "llm_ppt", "llm_sheet", "generic"];

type Conn = { query: (q: string, params?: unknown[]) => Promise<unknown> };

function unwrap(r: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as Array<Record<string, unknown>>;
}

async function hasTable(conn: Conn, table: string): Promise<boolean> {
  const rows = unwrap(
    await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    ),
  );
  return rows.length > 0;
}

async function hasColumn(conn: Conn, table: string, column: string): Promise<boolean> {
  const rows = unwrap(
    await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    ),
  );
  return rows.length > 0;
}

/** additive 加列（information_schema 检查后 ALTER，幂等） */
async function ensureExecutorColumns(conn: Conn): Promise<void> {
  if (await hasTable(conn, "st_skills")) {
    if (!(await hasColumn(conn, "st_skills", "executor_kind"))) {
      await conn.query(`ALTER TABLE st_skills ADD COLUMN executor_kind VARCHAR(32) NULL`);
      console.log("st_skills.executor_kind: added");
    }
  } else {
    console.warn("st_skills 表不存在（sync-ops.mts 未跑？），跳过加列与回填");
  }
  if (await hasTable(conn, "skills")) {
    if (!(await hasColumn(conn, "skills", "executorKind"))) {
      await conn.query(`ALTER TABLE skills ADD COLUMN executorKind VARCHAR(32) NULL`);
      console.log("skills.executorKind: added");
    }
  } else {
    console.warn("skills 表不存在，跳过加列与回填");
  }
}

/** st_skills 回填：SKILL_EXECUTOR_MAP 命中的 20 个技能登记真执行器类型，其余置 NULL */
async function backfillStSkills(conn: Conn): Promise<void> {
  if (!(await hasTable(conn, "st_skills")) || !(await hasColumn(conn, "st_skills", "executor_kind"))) return;
  const { executorRegistry } = await import("../api/routers/skillStats");
  const registry = executorRegistry();
  const keys = Object.keys(registry);
  for (const key of keys) {
    await conn.query(`UPDATE st_skills SET executor_kind = ? WHERE skill_key = ?`, [registry[key], key]);
  }
  // 无执行器记 NULL（覆盖历史误标，幂等）
  if (keys.length > 0) {
    const placeholders = keys.map(() => "?").join(",");
    await conn.query(
      `UPDATE st_skills SET executor_kind = NULL WHERE skill_key NOT IN (${placeholders})`,
      keys,
    );
  }
  console.log(`st_skills.executor_kind backfill: ${keys.length} real executors`);
}

/** 匠市 skills 回填：同名继承 st_skills.executor_kind（NULL→无真执行器），无映射记 'generic' */
async function backfillMarketSkills(conn: Conn): Promise<void> {
  if (
    !(await hasTable(conn, "skills")) ||
    !(await hasColumn(conn, "skills", "executorKind")) ||
    !(await hasTable(conn, "st_skills")) ||
    !(await hasColumn(conn, "st_skills", "executor_kind"))
  ) {
    return;
  }
  await conn.query(
    `UPDATE skills s
     LEFT JOIN st_skills st ON st.name = s.name COLLATE utf8mb4_unicode_ci
     SET s.executorKind = COALESCE(st.executor_kind, 'generic')`,
  );
  console.log("skills.executorKind backfill: done (inherit by name, fallback 'generic')");
}

export async function ensureH1ExecutorRegistry(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn("sync-h1: DATABASE_URL 未配置，跳过");
    return;
  }
  const { default: mysql } = await import("mysql2/promise");
  const conn = await mysql.createConnection(url);
  try {
    await ensureExecutorColumns(conn);
    await backfillStSkills(conn);
    await backfillMarketSkills(conn);
    console.log(`sync-h1 done (${REGISTRY_TABLES.length} tables, kinds: ${KIND_VALUES.join("/")})`);
  } finally {
    await conn.end();
  }
}

/** 仅当作为脚本直接执行时自动运行 */
const isDirectRun = (() => {
  try {
    const arg1 = process.argv[1] ?? "";
    if (!/sync-h1/.test(arg1)) return false;
    return realpathSync(arg1) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  if (process.env.DRY_RUN) {
    console.log("dry run ok");
    process.exit(0);
  }
  ensureH1ExecutorRegistry()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("sync-h1 failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
