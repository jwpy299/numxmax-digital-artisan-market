// iter78b 修复：st_panda_members 唯一键对 NULL factory_id 失效导致平台席位重复。
// 方案：生成列 factory_key = COALESCE(factory_id, 0)（STORED），唯一键改为 (factory_key, role, ref_key)。
// 幂等。
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
async function hasIndex(table: string, idx: string): Promise<boolean> {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, idx],
  );
  return Number((rows as { c: number }[])[0]?.c ?? 0) > 0;
}

// 1) 先去重（保留每组最小 id；同时处理工厂级理论重复）
await conn.query(
  `DELETE m1 FROM st_panda_members m1
   JOIN st_panda_members m2
     ON m2.role = m1.role AND m2.ref_key = m1.ref_key
    AND (m2.factory_id = m1.factory_id OR (m2.factory_id IS NULL AND m1.factory_id IS NULL))
    AND m2.id < m1.id`,
);
console.log("duplicates purged");

// 2) 旧唯一键下线（对 NULL 形同虚设）
if (await hasIndex("st_panda_members", "uk_seat")) {
  await conn.query(`ALTER TABLE st_panda_members DROP INDEX uk_seat`);
  console.log("uk_seat dropped");
} else console.log("uk_seat absent");

// 3) 生成列 + 新唯一键
if (!(await hasColumn("st_panda_members", "factory_key"))) {
  await conn.query(
    // 注意：MySQL 8.0 要求 NOT NULL 放在生成列表达式之后（AS (...) STORED NOT NULL），
    // 写成 "NOT NULL GENERATED ALWAYS AS" 会 ER_PARSE_ERROR 1064（本机 8.0.46 实测）。
    `ALTER TABLE st_panda_members
     ADD COLUMN factory_key BIGINT UNSIGNED GENERATED ALWAYS AS (COALESCE(factory_id, 0)) STORED NOT NULL`,
  );
  console.log("factory_key added");
} else console.log("factory_key exists");

if (!(await hasIndex("st_panda_members", "uk_seat_v2"))) {
  await conn.query(`ALTER TABLE st_panda_members ADD UNIQUE KEY uk_seat_v2 (factory_key, role, ref_key)`);
  console.log("uk_seat_v2 added");
} else console.log("uk_seat_v2 exists");

await conn.end();
