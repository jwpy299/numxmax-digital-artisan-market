// M8-b 迁移：快照引擎 —— st_snapshots 平台级预生成快照表（值守晨报/规划器看板等）。
// 幂等：CREATE TABLE IF NOT EXISTS；重复执行无副作用。
// 运行（在 /opt/lingshu-wb/app 或 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-snapshots.mts
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

// 快照表：scope+skey 唯一定位一份预生成内容（skey 命名因 key 是 MySQL 保留字）。
// content 一律过 stripSecrets 后落库；degraded=1 表示该快照为规则降级产物。
await conn.query(`CREATE TABLE IF NOT EXISTS st_snapshots (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  scope VARCHAR(48) NOT NULL COMMENT '快照域（platform/factory:12/...）',
  skey VARCHAR(64) NOT NULL COMMENT '快照键（duty-briefing/planner-stats/...）',
  content MEDIUMTEXT NULL COMMENT '快照内容（已过 stripSecrets）',
  data_version VARCHAR(64) NULL COMMENT '数据版本标记（生成时间/数据指纹）',
  degraded TINYINT NOT NULL DEFAULT 0 COMMENT '1=降级产物',
  generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '生成时间（有效期判定基准）',
  UNIQUE KEY uniq_scope_skey (scope, skey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_snapshots: ok");

await conn.end();
console.log("SYNC-SNAPSHOTS-PASS");
