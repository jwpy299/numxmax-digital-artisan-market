// iter99 迁移：Token 流水台账（市场购买真实扣费/分成记账）
// 运行（在 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-iter99.mts
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

// Token 流水台账：每一次余额变动一行（正=入账，负=支出），含变动后余额快照
await conn.query(`CREATE TABLE IF NOT EXISTS st_token_ledger (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factory_id BIGINT NOT NULL,
  delta INT NOT NULL,
  balance_after INT NOT NULL,
  kind VARCHAR(32) NOT NULL,
  ref VARCHAR(128) NULL,
  note VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_factory (factory_id),
  KEY idx_kind (kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_token_ledger: ok");

// 圆桌席位可挂熊猫军团成员（iter99）：st_meeting_config.member_key = "role:ref_key"
const [cols] = await conn.query(
  `SELECT COLUMN_NAME FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_meeting_config' AND COLUMN_NAME = 'member_key'`,
);
if ((cols as unknown[]).length === 0) {
  await conn.query(`ALTER TABLE st_meeting_config ADD COLUMN member_key VARCHAR(96) NULL AFTER persona_hint`);
  console.log("st_meeting_config.member_key: added");
} else {
  console.log("st_meeting_config.member_key: exists");
}

// 老企业套餐补齐（iter99 标准6）：无套餐记录的存量企业补默认 basic（审计输出补齐清单）
const [missing] = await conn.query(
  `SELECT f.id, f.enterpriseName FROM wb_factories f
   LEFT JOIN st_factory_plan p ON p.factory_id = f.id
   WHERE p.factory_id IS NULL`,
);
const missingRows = missing as Array<{ id: number; enterpriseName: string }>;
for (const f of missingRows) {
  await conn.query(
    `INSERT IGNORE INTO st_factory_plan (factory_id, plan_code, seat_limit, llm_daily_limit, status, expire_at)
     VALUES (?, 'basic', 3, 200, 'active', DATE_ADD(NOW(), INTERVAL 30 DAY))`,
    [f.id],
  );
  console.log(`plan backfill: factory ${f.id} (${f.enterpriseName}) → basic`);
}
console.log(`plan backfill: ${missingRows.length} 家补齐`);

console.log("SYNC-ITER99-PASS");
await conn.end();
