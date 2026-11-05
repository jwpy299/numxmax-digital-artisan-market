// iter96 迁移：自主运行引擎（autoEngine）信号 + 宪法 + 技能适应度
// 新表 3 张，全部 CREATE TABLE IF NOT EXISTS，幂等可重跑。
// 运行（在 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-iter96.mts
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

const tables: [string, string][] = [
  [
    "st_auto_signals",
    `CREATE TABLE IF NOT EXISTS st_auto_signals (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      factory_id BIGINT NOT NULL,
      source VARCHAR(16) NOT NULL,
      level VARCHAR(1) NOT NULL,
      title VARCHAR(255) NOT NULL,
      detail TEXT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      handled_at DATETIME NULL,
      KEY idx_factory_status (factory_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
  [
    "st_auto_constitution",
    `CREATE TABLE IF NOT EXISTS st_auto_constitution (
      factory_id BIGINT NOT NULL PRIMARY KEY,
      max_auto_level ENUM('A','B') NOT NULL DEFAULT 'A',
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
  [
    "st_skill_fitness",
    `CREATE TABLE IF NOT EXISTS st_skill_fitness (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      factory_id BIGINT NOT NULL,
      skill_key VARCHAR(64) NOT NULL,
      uses INT NOT NULL DEFAULT 0,
      successes INT NOT NULL DEFAULT 0,
      thumbs_up INT NOT NULL DEFAULT 0,
      thumbs_down INT NOT NULL DEFAULT 0,
      last_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_factory_skill (factory_id, skill_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
];

for (const [name, ddl] of tables) {
  await conn.query(ddl);
  console.log(`${name}: ok`);
}

await conn.end();
console.log("SYNC-ITER96-PASS");
