// M25 迁移：短信验证码通道（wb_sms_codes）——彭总指令「手机短信注册通道」。
// wb_sms_codes：验证码仅存 sha256（codeHash），明文仅经短信通道发出，绝不落库/日志/回显；
// consumedAt 一次性消费（原子 UPDATE 防重放）；attempts 错验计数（≥5 作废）。
// 幂等：CREATE TABLE IF NOT EXISTS + information_schema 检测补索引；additive、绝不 drop。
// 运行（在 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-m25.mts
// 语法自检：DRY_RUN=1 npx tsx db/sync-m25.mts（不连库，直接退出）
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

// 短信验证码：purpose=register|login 分通道计数；phone+purpose+createdAt 联合索引
// 服务限频查询（同号 60s≤1 / 同号同 purpose 当日≤10）与取最新未消费码。
// 绝无唯一约束：同号可有多条历史码（旧码过期作废），一次性语义由 consumedAt 原子置位保证。
await conn.query(`CREATE TABLE IF NOT EXISTS wb_sms_codes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(20) NOT NULL COMMENT '手机号',
  codeHash VARCHAR(64) NOT NULL COMMENT 'sha256(明文验证码)，明文绝不落库',
  purpose ENUM('register','login') NOT NULL COMMENT '注册|登录',
  expiresAt DATETIME NOT NULL COMMENT '过期时间（签发后 5 分钟）',
  consumedAt DATETIME NULL COMMENT 'NULL=未消费；置位=已用/作废（一次性，防重放）',
  attempts TINYINT NOT NULL DEFAULT 0 COMMENT '错验次数（每次错验+1，≥5 作废）',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("wb_sms_codes: ok");

await ensureIndex(
  "wb_sms_codes",
  "wb_sms_codes_phone_purpose_idx",
  `ALTER TABLE wb_sms_codes ADD INDEX wb_sms_codes_phone_purpose_idx (phone, purpose, createdAt)`,
);

await conn.end();
console.log("sync-m25 done");
