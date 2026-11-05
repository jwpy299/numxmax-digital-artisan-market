/**
 * sync-sdlc-verdicts：学习环第一步——预审留底（2026-08-29 彭总令「开干」）。
 * st_sdlc_verdicts：每次 AI 预审的「判决书底档」（判定/风险/摘要），
 * 供第二步结果对账（st_sdlc_outcomes，后续版本）join 对账——预审从此能知道自己对不对。
 * additive 幂等。
 */
import mysql from "mysql2/promise";

const url = process.argv[2] ?? (() => { throw new Error("必须显式传库 URL"); })();
const conn = await mysql.createConnection(url);

await conn.query(`CREATE TABLE IF NOT EXISTS st_sdlc_verdicts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  proposal_id BIGINT NOT NULL COMMENT '施工提案ID',
  verdict VARCHAR(12) NOT NULL COMMENT 'pass/warn/reject/unreviewed',
  risks JSON NULL COMMENT '风险清单（预审原文提取）',
  summary VARCHAR(600) NULL COMMENT '预审摘要',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_sdlc_verdict_proposal (proposal_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI预审判决书底档（学习环第一步）'`);

console.log("st_sdlc_verdicts: ready");
await conn.end();
