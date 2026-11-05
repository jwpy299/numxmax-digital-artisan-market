/**
 * 迭代 38 · 部门资料夹（人机协同的"上下文"）—— additive 幂等迁移。
 *
 * 变更：
 *  1. st_kb_docs 加列：visibility VARCHAR(16) DEFAULT 'dept'（dept/factory 预留）、
 *     usedCount INT DEFAULT 0（被引用次数，确权口径）。
 *  2. 新表 st_dept_doc_refs：引用留痕（谁/什么任务/哪个席位引用了哪份文档）。
 *
 * 口径适配说明：方案原稿 factoryId 维度与 iter37 同理——超级终端 staff 账号无 factoryId，
 * 沿用 dept_key 作用域（iter28 已落地），factoryId 列不建，visibility 列预留。
 *
 * 运行：set -a && . ./.env && set +a && npx tsx db/sync-iter38.mts
 * 只增不改；重复执行无副作用。
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

async function ensureColumn(table: string, column: string, ddl: string): Promise<void> {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  if (Array.isArray(rows) && rows.length > 0) {
    console.log(`[skip] ${table}.${column} 已存在`);
    return;
  }
  if (DRY_RUN) {
    console.log(`[dry-run] 将加列 ${table}.${column}`);
    return;
  }
  await conn.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  console.log(`[done] ${table} + ${column}`);
}

async function ensureTable(name: string, createSql: string): Promise<void> {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [name],
  );
  if (Array.isArray(rows) && rows.length > 0) {
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

await ensureColumn("st_kb_docs", "visibility", "visibility VARCHAR(16) NOT NULL DEFAULT 'dept' AFTER dept_key");
await ensureColumn("st_kb_docs", "usedCount", "usedCount INT NOT NULL DEFAULT 0 AFTER visibility");

await ensureTable(
  "st_dept_doc_refs",
  `CREATE TABLE st_dept_doc_refs (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     docId BIGINT UNSIGNED NOT NULL,
     usedBy VARCHAR(16) NOT NULL,
     refId VARCHAR(64) NOT NULL,
     agentSeatId BIGINT UNSIGNED NULL,
     actor VARCHAR(64) NOT NULL DEFAULT '',
     createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     INDEX idx_st_docrefs_doc (docId, createdAt),
     INDEX idx_st_docrefs_ref (usedBy, refId)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

await conn.end();
console.log("iter38 sync 完成");
