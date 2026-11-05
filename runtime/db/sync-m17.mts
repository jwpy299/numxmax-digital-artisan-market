// M17 迁移：扫码绑设备 —— wb_pair_codes 一次性配对码（pd_，5min，sha256 落库）
// + wb_devices 工作台终端台账（dt_ 设备凭证，tokenPulledAt 一次性自取）。
// 幂等：CREATE TABLE IF NOT EXISTS + information_schema 检测补索引；additive、绝不 drop；
// 不触碰 M12 st_devices（语义不同：执行通道 vs 终端台账，见设计 §0 决策）。
// 运行（在 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-m17.mts
// 语法自检：DRY_RUN=1 npx tsx db/sync-m17.mts（不连库，直接退出）
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

/** information_schema 检测后补索引（additive，幂等） */
async function ensureIndex(table: string, index: string, ddl: string) {
  const [rows] = await conn.query(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, index],
  );
  if ((rows as unknown[]).length === 0) {
    await conn.query(ddl);
    console.log(`${table}.${index}: added`);
  }
}

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
  }
}

// 一次性配对码：codeHash 只存 sha256（明文 pd_ 仅 open 响应返回一次）。
// 不配 factoryId——码在 claim 前不属于任何企业，企业归属由 claim 者决定（与 wb_invites 的关键差异）。
await conn.query(`CREATE TABLE IF NOT EXISTS wb_pair_codes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  codeHash VARCHAR(64) NOT NULL COMMENT 'sha256(明文配对码 pd_+48hex)',
  deviceName VARCHAR(64) NOT NULL COMMENT '设备自报名（如 车间平板-03）',
  deviceType ENUM('desktop','tablet','box','other') NOT NULL COMMENT '设备形态',
  fingerprint VARCHAR(128) NOT NULL COMMENT '设备指纹（设备端稳定随机串，防重复绑定）',
  expiresAt DATETIME NOT NULL COMMENT '固定 5 分钟（WB_PAIR_TTL_SECONDS=300）',
  consumedAt DATETIME NULL COMMENT '一次性：claim 成功即写',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_codeHash (codeHash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("wb_pair_codes: ok");

// 工作台终端台账：tokenHash 只存 sha256（dt_ 明文仅首次 pair.status 拉取返回一次）。
// tokenPulledAt NULL=凭证待设备自取；revokedAt 解绑即 token 失效（heartbeat 拒）。
await conn.query(`CREATE TABLE IF NOT EXISTS wb_devices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factoryId BIGINT UNSIGNED NOT NULL COMMENT '企业隔离（claim 时写入）',
  name VARCHAR(64) NOT NULL COMMENT '设备名（默认取配对码 deviceName）',
  deviceType ENUM('desktop','tablet','box','other') NOT NULL,
  fingerprint VARCHAR(128) NOT NULL COMMENT '设备指纹',
  tokenHash VARCHAR(64) NOT NULL COMMENT 'sha256(dt_ 设备凭证，明文绝不落库)',
  claimedBy BIGINT UNSIGNED NOT NULL COMMENT '绑定人 userId（审计）',
  tokenPulledAt DATETIME NULL COMMENT 'dt_ 首次被设备拉取时间（NULL=待自取）',
  lastSeenAt DATETIME NULL COMMENT '心跳更新时间（NULL=绑定后从未心跳）',
  revokedAt DATETIME NULL COMMENT '解绑时间（NULL=在册）',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_tokenHash (tokenHash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("wb_devices: ok");

// F1：码→设备链接列（既有库补列；新库由 CREATE TABLE 之外的本分支统一兜底，幂等）
await ensureColumn(
  "wb_pair_codes",
  "consumedDeviceId",
  `ALTER TABLE wb_pair_codes ADD COLUMN consumedDeviceId VARCHAR(32) NULL COMMENT 'claim 事务内回写：本码建出的设备 id' AFTER consumedAt`,
);

await ensureIndex(
  "wb_pair_codes",
  "wb_pair_codes_expires_idx",
  `ALTER TABLE wb_pair_codes ADD INDEX wb_pair_codes_expires_idx (expiresAt)`,
);
await ensureIndex(
  "wb_devices",
  "wb_devices_factory_idx",
  `ALTER TABLE wb_devices ADD INDEX wb_devices_factory_idx (factoryId)`,
);
await ensureIndex(
  "wb_devices",
  "wb_devices_fingerprint_idx",
  `ALTER TABLE wb_devices ADD INDEX wb_devices_fingerprint_idx (fingerprint)`,
);

await conn.end();
console.log("SYNC-M17-PASS");
