// M9-c 迁移：记忆个性化 —— st_user_memory 用户级偏好记忆表（灵枢/星云"越用越懂你"）。
// 幂等：CREATE TABLE IF NOT EXISTS；重复执行无副作用。
// 运行（在 /opt/lingshu-wb/app 或 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-user-memory.mts
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

// 用户记忆：factory_id+username 双键隔离（记忆只属于本人本厂），mkey 避免 MySQL 保留字 key。
// mvalue 落库前一律过 stripSecrets 且截断 ≤200 字（应用层保证）。
await conn.query(`CREATE TABLE IF NOT EXISTS st_user_memory (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factory_id BIGINT NOT NULL COMMENT '所属工厂（跨厂隔离键）',
  username VARCHAR(64) NOT NULL COMMENT '所属用户（本人隔离键）',
  mkey VARCHAR(64) NOT NULL COMMENT '记忆键（称呼/喜好/习惯/忌讳/备注）',
  mvalue TEXT NULL COMMENT '记忆值（已过 stripSecrets，≤200 字）',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最近更新时间',
  UNIQUE KEY uniq_factory_user_key (factory_id, username, mkey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_user_memory: ok");

await conn.end();
console.log("SYNC-USER-MEMORY-PASS");
