// iter92 迁移：企业训练场 + 计费套餐 + 告警 + 数据协议 + 技能市场 + 战绩榜
// 新表 8 张，全部 CREATE TABLE IF NOT EXISTS，幂等可重跑。
// 运行（在 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-iter92.mts
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

const tables: [string, string][] = [
  [
    "st_factory_plan",
    `CREATE TABLE IF NOT EXISTS st_factory_plan (
      factory_id BIGINT NOT NULL PRIMARY KEY,
      plan_code VARCHAR(16) NOT NULL DEFAULT 'basic',
      seat_limit INT NOT NULL DEFAULT 3,
      llm_daily_limit INT NOT NULL DEFAULT 200,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      expire_at DATETIME NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
  [
    "st_llm_usage_factory_daily",
    `CREATE TABLE IF NOT EXISTS st_llm_usage_factory_daily (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      factory_id BIGINT NOT NULL,
      day DATE NOT NULL,
      calls INT NOT NULL DEFAULT 0,
      UNIQUE KEY uq_factory_day (factory_id, day)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
  [
    "st_sandbox_tasks",
    `CREATE TABLE IF NOT EXISTS st_sandbox_tasks (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      factory_id BIGINT NOT NULL,
      corps_id BIGINT NULL,
      member_key VARCHAR(64) NULL,
      skill_key VARCHAR(64) NOT NULL,
      instruction TEXT NOT NULL,
      reply TEXT NULL,
      score DECIMAL(5,2) NULL,
      pass TINYINT NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL DEFAULT 'done',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_factory (factory_id, skill_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
  [
    "st_sandbox_skills",
    `CREATE TABLE IF NOT EXISTS st_sandbox_skills (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      factory_id BIGINT NOT NULL,
      skill_key VARCHAR(64) NOT NULL,
      title VARCHAR(128) NOT NULL,
      task_count INT NOT NULL DEFAULT 0,
      pass_count INT NOT NULL DEFAULT 0,
      graduated TINYINT NOT NULL DEFAULT 0,
      graduated_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_factory_skill (factory_id, skill_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
  [
    "st_data_agreements",
    `CREATE TABLE IF NOT EXISTS st_data_agreements (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      factory_id BIGINT NOT NULL,
      version VARCHAR(16) NOT NULL,
      signed_by VARCHAR(64) NOT NULL,
      signed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ip VARCHAR(64) NULL,
      UNIQUE KEY uq_factory_version (factory_id, version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
  [
    "st_skill_market",
    `CREATE TABLE IF NOT EXISTS st_skill_market (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      skill_key VARCHAR(64) NOT NULL,
      title VARCHAR(128) NOT NULL,
      industry VARCHAR(64) NOT NULL,
      description TEXT NULL,
      source_factory_id BIGINT NOT NULL,
      price_tokens INT NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      listed_at DATETIME NULL,
      KEY idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
  [
    "st_skill_purchases",
    `CREATE TABLE IF NOT EXISTS st_skill_purchases (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      skill_id BIGINT NOT NULL,
      factory_id BIGINT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_skill_factory (skill_id, factory_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
  [
    "st_alert_log",
    `CREATE TABLE IF NOT EXISTS st_alert_log (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      level VARCHAR(8) NOT NULL DEFAULT 'info',
      event VARCHAR(64) NOT NULL,
      payload TEXT NULL,
      sent_ok TINYINT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_event (event, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
];

// P-ALERT-IDX（门禁 PR#28 R23 票③，方案波 1 挂账升级执行）：st_alert_log 补 (level, created_at) 索引——
// append-only 大表全扫治理（唯一索引 idx_event 前导列 event 无等值谓词用不上）；幂等探测存在即跳。
const [idxRows] = await conn.query(
  `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_alert_log' AND INDEX_NAME = 'idx_level_created'`,
);
if (Number((idxRows as Array<Record<string, unknown>>)[0]?.c ?? 0) === 0) {
  await conn.query(`ALTER TABLE st_alert_log ADD INDEX idx_level_created (level, created_at)`);
  console.log("st_alert_log: idx_level_created added");
}

for (const [name, ddl] of tables) {
  await conn.query(ddl);
  console.log(`${name}: ok`);
}

await conn.end();
console.log("SYNC-ITER92-PASS");
