/**
 * sync-gender：注册男女模块（2026-08-28 彭总令）。
 * wb_users.gender：male/female/NULL（未填）。additive 幂等。
 */
import mysql from "mysql2/promise";

const url = process.argv[2] ?? (() => { throw new Error("必须显式传库 URL"); })();
const conn = await mysql.createConnection(url);

const [cols] = await conn.query(`SHOW COLUMNS FROM wb_users LIKE 'gender'`);
if ((cols as unknown[]).length > 0) console.log("wb_users.gender: already");
else {
  await conn.query(
    `ALTER TABLE wb_users ADD COLUMN gender VARCHAR(8) NULL DEFAULT NULL COMMENT '性别：male/female/NULL未填（音色与开场白按此分）' AFTER kind`,
  );
  console.log("wb_users.gender: added");
}
await conn.end();
console.log("sync-gender: done");
