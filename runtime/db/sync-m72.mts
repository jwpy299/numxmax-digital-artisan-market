// M72 迁移：信号源自动发现（v2.1.9 BLE/mDNS）—— wb_pair_codes 补 channel 审计列。
// 设计：ps_ 邻近短码（60s TTL）与 pd_ 扫码码同表，claim/status/dt_ 自取全链零分叉；
// channel NULL/'qr'=扫码（存量行零影响），'ble'/'mdns'=信号发现（审计 + APP 文案）。
// 幂等：information_schema.COLUMNS 检测后补列；additive、绝不 drop、绝不改存量行。
// 运行（在 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-m72.mts
// 语法自检：DRY_RUN=1 npx tsx db/sync-m72.mts（不连库，直接退出）
if (process.env.DRY_RUN) {
  console.log("dry run ok");
  process.exit(0);
}

import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const conn = await mysql.createConnection(url);

/** information_schema.COLUMNS 检测后补列（additive，幂等） */
async function ensureColumn(table: string, column: string, ddl: string) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  if ((rows as unknown[]).length === 0) {
    await conn.query(ddl);
    console.log(`${table}.${column}: added`);
  } else {
    console.log(`${table}.${column}: exists`);
  }
}

await ensureColumn(
  "wb_pair_codes",
  "channel",
  "ALTER TABLE wb_pair_codes ADD COLUMN channel VARCHAR(8) NULL DEFAULT NULL AFTER consumedDeviceId",
);

await conn.end();
console.log("sync-m72 done");
