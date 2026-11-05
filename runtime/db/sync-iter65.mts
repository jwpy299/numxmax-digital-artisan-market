/**
 * sync-iter65 —— 圆桌消息记忆计数列 st_meeting_messages.memory_count。幂等。
 */
import mysql from "mysql2/promise";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);
const [rows] = await conn.query(
  `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_meeting_messages' AND COLUMN_NAME = 'memory_count'`,
);
const exists = Number((rows as Array<{ c: number }>)[0]?.c ?? 0) > 0;
if (!exists) {
  await conn.query(`ALTER TABLE st_meeting_messages ADD COLUMN memory_count INT NOT NULL DEFAULT 0 AFTER round`);
}
await conn.end();
console.log(exists ? "SYNC_ITER65_OK (already)" : "SYNC_ITER65_OK (added)");
