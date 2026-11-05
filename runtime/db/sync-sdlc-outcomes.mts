/**
 * sync-sdlc-outcomes：学习环第二步——结果对账表（2026-08-29）。
 * st_sdlc_outcomes：预审判决书的「事后真相」——提案施工后到底出事没有。
 * 事实源：关联发布的回滚/探针红 → incident；验证通过且观察期满无事故 → clean。
 * additive 幂等。
 */
import mysql from "mysql2/promise";

const url = process.argv[2] ?? (() => { throw new Error("必须显式传库 URL"); })();
const conn = await mysql.createConnection(url);

await conn.query(`CREATE TABLE IF NOT EXISTS st_sdlc_outcomes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  proposal_id BIGINT NOT NULL COMMENT '施工提案ID（与 st_sdlc_verdicts 对齐）',
  release_id BIGINT NULL COMMENT '关联发布（construct:queued 审计链）',
  outcome VARCHAR(12) NOT NULL COMMENT 'incident出事/clean平安',
  evidence VARCHAR(300) NULL COMMENT '判定依据（如 rollback审计 / verified+观察期满）',
  resolved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_sdlc_outcome_proposal (proposal_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='预审结果对账表（学习环第二步）'`);

console.log("st_sdlc_outcomes: ready");
await conn.end();
