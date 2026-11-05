/**
 * M54 迁移「超终七席定编」：技术部/财务部/法务部三行补种（幂等）。
 * 平台定编：技术/运营/市场/品牌/财务/法务 + 总经理驾驶舱（页面非 console）。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-m54.mts
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Conn = { query: (q: string, params?: unknown[]) => Promise<unknown>; end?: () => Promise<void> };

async function main(conn: Conn): Promise<void> {
  // factory_id 为 NULL 时复合唯一键不生效（MySQL NULL 语义）——必须先查后插
  const SEATS: Array<[string, string]> = [
    ["tech", "技术部"],
    ["finance", "财务部"],
    ["legal", "法务部"],
  ];
  let added = 0;
  for (const [code, name] of SEATS) {
    const rows = (await conn.query(
      `SELECT id FROM st_dept_consoles WHERE factory_id IS NULL AND dept_code = '${code}' LIMIT 1`,
    )) as unknown;
    const found = (Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows) as Array<unknown>;
    if (found.length > 0) continue;
    await conn.query(
      `INSERT INTO st_dept_consoles (factory_id, dept_code, dept_name, chief_agent_code, agent_codes, dsh_enabled, model_slot)
       VALUES (NULL, '${code}', '${name}', NULL, JSON_ARRAY(), 1, 'chat')`,
    );
    added++;
  }
  console.log(`st_dept_consoles: tech/finance/legal seeded (added=${added})`);
}

const isDirectRun =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isDirectRun) {
  if (process.env.DRY_RUN === "1") {
    console.log("DRY_RUN ok: syntax parsed");
    process.exit(0);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL 未配置");
    process.exit(1);
  }
  const { createConnection } = await import("mysql2/promise");
  const u = new URL(url);
  const conn = await createConnection({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
  });
  await main(conn);
  await conn.end();
}
