// M77 迁移：大小环互联互通激活 —— st_evo_signals 补 dept_key 部门维度列。
// 设计：信号上报可携带部门上下文（设备/智能体所属部门），点火器按
// (factory_id, kind, dept_key) 聚集，经 M74 联邦层判定：共鸣（≥2部门达阈）/
// 烈度（单部门 3×阈）升企业环，其余留部门环自治（P2 定向不外溢）。
// 幂等：information_schema.COLUMNS 检测后补列；additive、绝不 drop、绝不改存量行
// （存量行 dept_key=NULL = 企业环口径，老点火路径零感知）。
// 运行（在 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-m73.mts
// 语法自检：DRY_RUN=1 npx tsx db/sync-m73.mts（不连库，直接退出）
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

/** information_schema.COLUMNS 检测后补列（additive，幂等） */
async function ensureColumn(table: string, column: string, ddl: string) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  if ((rows as unknown[]).length === 0) {
    await conn.query(ddl);
    console.log(`${table}.${column}: added`);
  } else {
    console.log(`${table}.${column}: exists`);
  }
}

await ensureColumn(
  "st_evo_signals",
  "dept_key",
  "ALTER TABLE st_evo_signals ADD COLUMN dept_key VARCHAR(32) NULL DEFAULT NULL AFTER factory_id",
);

await conn.end();
console.log("sync-m73 done");
