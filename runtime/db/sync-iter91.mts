// iter91 迁移：龙虾租户化 + 熊猫军团流水线
//   新表：
//     st_factory_claw_tier      企业龙虾能力分级（l0/l1/l2/l3）
//     st_claw_domain_whitelist  域名白名单（factory_id NULL=平台基础名单）
//     st_corps                  熊猫军团（一厂一团）
//     st_corps_training         军团训练/考核成绩
//   补列：st_panda_members.corps_id
// 幂等：表用 CREATE TABLE IF NOT EXISTS，列先查 information_schema，可连跑。
// 运行（在 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-iter91.mts
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

const tables: [string, string][] = [
  [
    "st_factory_claw_tier",
    `CREATE TABLE IF NOT EXISTS st_factory_claw_tier (
      factory_id BIGINT NOT NULL PRIMARY KEY,
      tier VARCHAR(8) NOT NULL DEFAULT 'l0',
      note VARCHAR(255) NULL,
      opened_by VARCHAR(64) NULL,
      opened_at DATETIME NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
  [
    "st_claw_domain_whitelist",
    `CREATE TABLE IF NOT EXISTS st_claw_domain_whitelist (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      factory_id BIGINT NULL,
      domain VARCHAR(255) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      submitted_by VARCHAR(64) NULL,
      approved_by VARCHAR(64) NULL,
      approved_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_factory_domain (factory_id, domain),
      KEY idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
  [
    "st_corps",
    `CREATE TABLE IF NOT EXISTS st_corps (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      factory_id BIGINT NOT NULL,
      name VARCHAR(128) NOT NULL,
      industry VARCHAR(64) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'forming',
      member_count INT NOT NULL DEFAULT 0,
      train_pass_rate DECIMAL(5,2) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      graduated_at DATETIME NULL,
      deployed_at DATETIME NULL,
      UNIQUE KEY uq_factory (factory_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
  [
    "st_corps_training",
    `CREATE TABLE IF NOT EXISTS st_corps_training (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      corps_id BIGINT NOT NULL,
      round VARCHAR(32) NOT NULL,
      subject VARCHAR(255) NOT NULL,
      pass TINYINT NOT NULL DEFAULT 0,
      score DECIMAL(5,2) NULL,
      reply TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_corps (corps_id, round)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
];

for (const [name, ddl] of tables) {
  await conn.query(ddl);
  console.log(`${name}: ok`);
}

async function hasColumn(table: string, col: string): Promise<boolean> {
  const [rows] = await conn.query(
    `SELECT column_name AS c FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, col],
  );
  return (rows as { c: string }[]).length > 0;
}

if (await hasColumn("st_panda_members", "corps_id")) {
  console.log("st_panda_members.corps_id exists, skip");
} else {
  await conn.query(`ALTER TABLE st_panda_members ADD COLUMN corps_id BIGINT NULL`);
  console.log("st_panda_members.corps_id: added");
}

// 平台基础白名单（factory_id NULL），幂等 INSERT IGNORE
const baseDomains = ["www.baidu.com", "www.bing.com", "cn.bing.com", "news.baidu.com"];
for (const d of baseDomains) {
  await conn.query(
    `INSERT IGNORE INTO st_claw_domain_whitelist (factory_id, domain, status, submitted_by, approved_by, approved_at)
     VALUES (NULL, ?, 'approved', 'platform', 'platform', NOW())`,
    [d],
  );
}
console.log(`platform base whitelist: ${baseDomains.length} domains ensured`);

await conn.end();
console.log("SYNC-ITER91-PASS");
