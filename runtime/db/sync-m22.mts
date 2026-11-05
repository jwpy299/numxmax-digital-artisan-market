// M22a 迁移：通用设备资产台账（App 通用扫码——生产设备二维码/条形码 + 办公设备扫码登记识别）。
// wb_assets：本企业资产台账，codeValue 扫码原始值（COLLATE utf8mb4_bin 大小写敏感比对）。
// 幂等：CREATE TABLE IF NOT EXISTS + information_schema 检测补索引；additive、绝不 drop。
// 运行（在 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-m22.mts
// 语法自检：DRY_RUN=1 npx tsx db/sync-m22.mts（不连库，直接退出）
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

// 资产台账：扫码登记/识别第一跳。codeValue 用 utf8mb4_bin——扫码值大小写敏感
// （Code128/QR 内容区分大小写），默认 utf8mb4_general_ci 会把 'Ab1' 与 'aB1' 误判同码。
// factoryId+codeValue 非唯一联合索引：同码 active 仅一行由应用层幂等保证，
// retired 行保留审计，同码退役后允许重新登记新资产。
await conn.query(`CREATE TABLE IF NOT EXISTS wb_assets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factoryId BIGINT UNSIGNED NOT NULL COMMENT '企业隔离',
  assetNo VARCHAR(64) NOT NULL COMMENT '企业内资产编号（缺省 AS-{factoryId}-{6位随机大写字数}）',
  name VARCHAR(128) NOT NULL COMMENT '资产名称',
  category ENUM('production','hvac','lighting','printer','office','other') NOT NULL COMMENT '生产设备|空调|照明|打印机|办公|其他',
  codeType ENUM('qr','ean13','code128','manual','other') NOT NULL COMMENT '二维码|EAN13条码|Code128条码|手工录入|其他',
  codeValue VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '扫码原始值（大小写敏感）',
  location VARCHAR(128) NULL COMMENT '安装/摆放位置',
  status ENUM('active','retired') NOT NULL DEFAULT 'active' COMMENT '在册|已退役',
  boundBy BIGINT UNSIGNED NOT NULL COMMENT '登记人审计',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  retiredAt DATETIME NULL COMMENT '退役时间（NULL=在册）'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("wb_assets: ok");

await ensureIndex(
  "wb_assets",
  "wb_assets_factory_idx",
  `ALTER TABLE wb_assets ADD INDEX wb_assets_factory_idx (factoryId)`,
);
await ensureIndex(
  "wb_assets",
  "wb_assets_factory_code_idx",
  `ALTER TABLE wb_assets ADD INDEX wb_assets_factory_code_idx (factoryId, codeValue)`,
);

await conn.end();
console.log("SYNC-M22-PASS");
