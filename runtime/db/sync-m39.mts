/**
 * M39 迁移「自进化闭环修正」：st_skills.layer 枚举扩 'evo'（幂等）。
 *
 * 背景：evo 提案批准落生新技能用 layer='evo' 标记（loadVisibleSkills 进化段），
 * 原枚举 general/professional/industry 不含 evo → 批准时 INSERT 报 1265 数据截断
 * （生产实证事故：提案 #8 已 applied 但技能未落生）。
 * 幂等：读 information_schema 枚举值，含 evo 则跳过。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-m39.mts
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Conn = { query: (q: string, params?: unknown[]) => Promise<unknown>; end?: () => Promise<void> };

async function main(conn: Conn): Promise<void> {
  const rows = (await conn.query(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_skills' AND COLUMN_NAME = 'layer'`,
  )) as unknown;
  const found = (Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows) as Array<Record<string, unknown>>;
  const colType = String(found[0]?.COLUMN_TYPE ?? "");
  if (colType.includes("'evo'")) {
    console.log("st_skills.layer: evo already in enum, skip");
    return;
  }
  await conn.query(
    `ALTER TABLE st_skills MODIFY COLUMN layer ENUM('general','professional','industry','evo') NOT NULL`,
  );
  console.log("st_skills.layer: enum extended with 'evo'");
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
  try {
    await main(conn as unknown as Conn);
  } finally {
    await conn.end();
  }
}
