// iter76 熊猫组织底座：会议室类型 + 企业会议室同步流
// 幂等：可重复执行。
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

async function hasColumn(table: string, col: string): Promise<boolean> {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, col],
  );
  return Number((rows as { c: number }[])[0]?.c ?? 0) > 0;
}

// 1) st_meetings 增加 room_type / dept_key
if (!(await hasColumn("st_meetings", "room_type"))) {
  await conn.query(
    `ALTER TABLE st_meetings ADD COLUMN room_type VARCHAR(16) NOT NULL DEFAULT 'legacy' AFTER meetingType`,
  );
  console.log("st_meetings.room_type added");
} else console.log("st_meetings.room_type exists");

if (!(await hasColumn("st_meetings", "dept_key"))) {
  await conn.query(
    `ALTER TABLE st_meetings ADD COLUMN dept_key VARCHAR(32) NULL AFTER room_type`,
  );
  console.log("st_meetings.dept_key added");
} else console.log("st_meetings.dept_key exists");

// 2) 企业会议室同步流
await conn.query(`CREATE TABLE IF NOT EXISTS st_enterprise_feed (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  src_msg_id BIGINT UNSIGNED NOT NULL,
  src_meeting_id BIGINT UNSIGNED NOT NULL,
  room_type VARCHAR(16) NOT NULL,
  dept_key VARCHAR(32) NULL,
  participant VARCHAR(64) NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  round INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_src_msg (src_msg_id),
  KEY idx_created (created_at),
  KEY idx_meeting (src_meeting_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_enterprise_feed ensured");

await conn.end();
