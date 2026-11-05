/**
 * sync-iter72 —— provider 列宽统一放宽至 VARCHAR(128)（修复降级串超 32 写库失败缺陷）。幂等。
 */
import mysql from "mysql2/promise";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);
const tables = [
  "st_chat_messages",
  "st_meeting_messages",
  "st_staff_chat_messages",
  "wb_org_chat_messages",
  "st_swarm_subtasks",
];
for (const t of tables) {
  const [rows] = await conn.query(
    `SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'provider'`,
    [t],
  );
  const len = Number((rows as Array<{ len: number }>)[0]?.len ?? 0);
  if (len > 0 && len < 128) {
    await conn.query(`ALTER TABLE \`${t}\` MODIFY COLUMN provider VARCHAR(128) NULL`);
    console.log(`WIDENED ${t}: ${len} -> 128`);
  } else {
    console.log(`SKIP ${t}: len=${len}`);
  }
}
await conn.end();
console.log("SYNC_ITER72_OK");
