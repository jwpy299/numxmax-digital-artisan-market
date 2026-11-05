/**
 * sync-iter64 —— 进化链 LLM 调用事件表 st_llm_events（成败/兜底/时延）。幂等。
 * M60：新增 first_token_ms（流式首字时延，非流式调用为 NULL）；存量表 ALTER 幂等补齐。
 */
import mysql from "mysql2/promise";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);
await conn.query(`CREATE TABLE IF NOT EXISTS st_llm_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  context VARCHAR(32) NOT NULL,
  slot VARCHAR(16) NOT NULL,
  ok TINYINT NOT NULL DEFAULT 0,
  fallback TINYINT NOT NULL DEFAULT 0,
  latency_ms INT NOT NULL DEFAULT 0,
  first_token_ms INT NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created (created_at),
  INDEX idx_context (context)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
// 存量表幂等补列（duplicate column 错误 1060 静默跳过）
try {
  await conn.query(`ALTER TABLE st_llm_events ADD COLUMN first_token_ms INT NULL DEFAULT NULL AFTER latency_ms`);
} catch (e) {
  if (!String((e as { message?: string })?.message ?? "").includes("Duplicate column")) throw e;
}
await conn.end();
console.log("SYNC_ITER64_OK");
