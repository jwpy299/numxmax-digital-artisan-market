/**
 * sync-internal-ops：灵智枢内部工作台认领回路（2026-08-31 彭总定稿：四舱四主官，队列认领制）。
 * st_partner_leads / st_evo_proposals 加 claimed_by/claimed_at（认领销项，审计留痕）。
 * additive 幂等。
 */
import mysql from "mysql2/promise";

const url = process.argv[2] ?? (() => { throw new Error("必须显式传库 URL"); })();
const conn = await mysql.createConnection(url);

for (const table of ["st_partner_leads", "st_evo_proposals"]) {
  const [cols] = await conn.query(`SHOW COLUMNS FROM ${table} LIKE 'claimed_by'`);
  if ((cols as unknown[]).length > 0) { console.log(`${table}.claimed_by: already`); continue; }
  await conn.query(
    `ALTER TABLE ${table}
     ADD COLUMN claimed_by BIGINT UNSIGNED NULL COMMENT '认领人 wb_users.id',
     ADD COLUMN claimed_at DATETIME NULL`,
  );
  console.log(`${table}: claimed 列已加`);
}
await conn.end();
