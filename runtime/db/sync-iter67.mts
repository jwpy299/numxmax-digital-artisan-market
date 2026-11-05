/**
 * sync-iter67 —— st_evo_reports.updated_at（重生成覆盖时刷新）。幂等。
 */
import mysql from "mysql2/promise";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);
const [rows] = await conn.query(
  `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_evo_reports' AND COLUMN_NAME = 'updated_at'`,
);
const exists = Number((rows as Array<{ c: number }>)[0]?.c ?? 0) > 0;
if (!exists) {
  await conn.query(`ALTER TABLE st_evo_reports ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP`);
  await conn.query(`UPDATE st_evo_reports SET updated_at = created_at`);
}
await conn.end();
console.log(exists ? "SYNC_ITER67_OK (already)" : "SYNC_ITER67_OK (added)");
