// iter87 迁移：LLM 成本闸 —— st_llm_usage_daily（按天×provider 的调用数/token 记账）
// 幂等：CREATE TABLE IF NOT EXISTS，可连跑多次。
// 运行：set -a && . ./.env && set +a && npx tsx db/sync-iter87.mts
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

await conn.query(`
  CREATE TABLE IF NOT EXISTS st_llm_usage_daily (
    day DATE NOT NULL,
    provider VARCHAR(32) NOT NULL,
    calls INT NOT NULL DEFAULT 0,
    tokens BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_llm_usage_day_provider (day, provider)
  )
`);
console.log("st_llm_usage_daily ensured");

// 自检：表结构与唯一键就绪
const [cols] = await conn.query(
  `SELECT column_name AS c FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'st_llm_usage_daily'`,
);
const names = (cols as { c: string }[]).map((r) => r.c).sort();
const need = ["calls", "day", "provider", "tokens", "updated_at"];
if (!need.every((n) => names.includes(n))) {
  throw new Error(`st_llm_usage_daily columns mismatch: ${names.join(",")}`);
}

await conn.end();
console.log("SYNC-ITER87-PASS");
