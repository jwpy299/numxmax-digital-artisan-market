/**
 * 6290210「灵智枢生态」关联厂数据清理（彭总 20260822 拍板）。
 *
 * 背景：HQ_FACTORY_IDS=6290209 唯一总部口径，6290210 为历史关联厂，决定清理。
 * 强隔离纪律：只动 factoryId=6290210 的行与注册表 id=6290210 的行，6290209 一根汗毛不碰。
 *
 * 三段式（缺省 DRY_RUN 只读盘点，APPLY=1 才动刀）：
 * 1. 盘点：information_schema 找出 nebula 库全部带 factoryId 列的表，逐表 COUNT(6290210)；
 *    另查注册表候选（st_factories / wb_factories 等 id=6290210 的行）；
 * 2. 备份（APPLY 时）：所有待删行完整导出 JSON（含表名+行数据）到
 *    /mnt/agents/output/migration/cleanup-6290210-backup-<ts>.json，先备份后删除；
 * 3. 删除 + 复核：逐表 DELETE，再 COUNT 复核必须全 0；任何一步失败即中断报告。
 *
 * 运行：
 *   盘点：set -a && . ./.env && set +a && npx tsx db/cleanup-6290210.mts
 *   动刀：set -a && . ./.env && set +a && APPLY=1 npx tsx db/cleanup-6290210.mts
 */
import fs from "node:fs";
import mysql from "mysql2/promise";

const FACTORY_ID = 6290210;
const GUARD_ID = 6290209; // 总部厂，断言保护：任何语句不得波及

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

const dbName = (await conn.query<mysql.RowDataPacket[]>("SELECT DATABASE() AS db"))[0][0].db;
console.log(`[info] target db=${dbName} factory=${FACTORY_ID} guard=${GUARD_ID} apply=${process.env.APPLY === "1"}`);

// 1) 找出所有带 factoryId 列的业务表
const [cols] = await conn.query<mysql.RowDataPacket[]>(
  `SELECT TABLE_NAME AS t, COLUMN_TYPE AS ct FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = ? AND COLUMN_NAME = 'factoryId' ORDER BY TABLE_NAME`,
  [dbName],
);
console.log(`[info] ${cols.length} tables carry factoryId`);

// 2) 逐表盘点
const inventory: { table: string; rows: number }[] = [];
for (const c of cols) {
  const t = String(c.t);
  const [r] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM \`${t}\` WHERE factoryId = ?`, [FACTORY_ID],
  );
  const n = Number(r[0].n);
  if (n > 0) inventory.push({ table: t, rows: n });
}
console.log("[inventory] factoryId=6290210 rows:");
let total = 0;
for (const i of inventory) { console.log(`  ${i.table}: ${i.rows}`); total += i.rows; }
console.log(`  TOTAL: ${total}`);

// 3) 注册表候选：id=6290210 的行（厂注册/关联记录）
const registryCandidates: { table: string; rows: number }[] = [];
const [idTables] = await conn.query<mysql.RowDataPacket[]>(
  `SELECT TABLE_NAME AS t FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = ? AND COLUMN_NAME = 'id' AND TABLE_NAME REGEXP 'factor|org|tenant|enterprise'`,
  [dbName],
);
for (const c of idTables) {
  const t = String(c.t);
  const [r] = await conn.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE id = ?`, [FACTORY_ID]);
  const n = Number(r[0].n);
  if (n > 0) registryCandidates.push({ table: t, rows: n });
}
console.log("[registry] id=6290210 rows:");
for (const i of registryCandidates) console.log(`  ${i.table}: ${i.rows}`);

if (process.env.APPLY !== "1") {
  console.log("[dry-run] 盘点完成，未动任何数据。APPLY=1 才会备份+删除。");
  await conn.end();
  process.exit(0);
}

// ── APPLY：先备份，后删除，再复核 ─────────────────────────────────────────
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = `/mnt/agents/output/migration/cleanup-6290210-backup-${ts}.json`;
const backup: Record<string, unknown[]> = {};
for (const i of inventory) {
  const [rows] = await conn.query<mysql.RowDataPacket[]>(`SELECT * FROM \`${i.table}\` WHERE factoryId = ?`, [FACTORY_ID]);
  backup[i.table] = rows;
}
for (const i of registryCandidates) {
  const [rows] = await conn.query<mysql.RowDataPacket[]>(`SELECT * FROM \`${i.table}\` WHERE id = ?`, [FACTORY_ID]);
  backup[`${i.table}#id`] = rows;
}
fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
console.log(`[backup] ${Object.keys(backup).length} tables -> ${backupPath}`);

for (const i of inventory) {
  // 护卫断言：删前确认总部厂行数不受影响面（语句带死 factoryId 常量，本断言双保险）
  const [g0] = await conn.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${i.table}\` WHERE factoryId = ?`, [GUARD_ID]);
  const [res] = await conn.query<mysql.ResultSetHeader>(`DELETE FROM \`${i.table}\` WHERE factoryId = ?`, [FACTORY_ID]);
  const [g1] = await conn.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${i.table}\` WHERE factoryId = ?`, [GUARD_ID]);
  if (Number(g0[0].n) !== Number(g1[0].n)) throw new Error(`GUARD VIOLATION on ${i.table}: 6290209 rows changed`);
  const [left] = await conn.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${i.table}\` WHERE factoryId = ?`, [FACTORY_ID]);
  console.log(`[delete] ${i.table}: affected=${res.affectedRows} left=${left[0].n}`);
  if (Number(left[0].n) !== 0) throw new Error(`delete incomplete on ${i.table}`);
}
for (const i of registryCandidates) {
  const [res] = await conn.query<mysql.ResultSetHeader>(`DELETE FROM \`${i.table}\` WHERE id = ?`, [FACTORY_ID]);
  console.log(`[delete] ${i.table}#id: affected=${res.affectedRows}`);
}
console.log("[done] 6290210 清理完成，复核全 0，总部厂 6290209 护卫断言通过。");
await conn.end();
