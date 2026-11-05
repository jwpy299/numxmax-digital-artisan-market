// M23 迁移：数字人记忆（wb_memories）+ 主动服务消息（wb_proactive_msgs）。
// wb_memories：灵枢/星云长期记忆（scope=user 本人私有 / factory 全厂共享；deletedAt 软删）。
// wb_proactive_msgs：主动服务消息（userId NULL=全员广播；dedupeKey 查重——主动≠骚扰）。
// 幂等：CREATE TABLE IF NOT EXISTS + information_schema 检测补索引；additive、绝不 drop。
// 运行（在 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-m23.mts
// 语法自检：DRY_RUN=1 npx tsx db/sync-m23.mts（不连库，直接退出）
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

// 数字人记忆：显式口令（importance=4 note）/ LLM 异步提炼（1-5 preference|fact）/ 系统事件（fact）。
// content VARCHAR(300)：单条≤300 字（应用层写入即 stripSecrets+截断，DB 层兜底长度）。
await conn.query(`CREATE TABLE IF NOT EXISTS wb_memories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factoryId BIGINT UNSIGNED NOT NULL COMMENT '企业隔离',
  userId BIGINT UNSIGNED NOT NULL COMMENT '记忆归属人（scope=user 语义）',
  persona ENUM('lingshu','xingyun','xingxing') NOT NULL COMMENT '记忆所属人格（灵枢|星云|小星）',
  scope ENUM('user','factory') NOT NULL COMMENT '本人私有|全厂共享',
  kind ENUM('preference','fact','note') NOT NULL COMMENT '偏好|事实|便签',
  content VARCHAR(300) NOT NULL COMMENT '记忆正文（≤300字）',
  importance TINYINT NOT NULL DEFAULT 3 COMMENT '1-5，显式口令=4，LLM 提炼 1-5',
  uses INT NOT NULL DEFAULT 0 COMMENT '被召回次数',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lastUsedAt DATETIME NULL COMMENT '最近召回时间（NULL=从未召回）',
  deletedAt DATETIME NULL COMMENT 'NULL=有效；置位=已遗忘（软删）'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("wb_memories: ok");

await ensureIndex(
  "wb_memories",
  "wb_memories_user_factory_idx",
  `ALTER TABLE wb_memories ADD INDEX wb_memories_user_factory_idx (userId, factoryId)`,
);

// M23c：persona 枚举追加 'xingxing'（匠市客服小星的长期记忆——彭总指令「小星也要记得注册用户」）。
// ALTER ... MODIFY ENUM 追加枚举值是 additive/INPLACE 元数据操作（MySQL 8.0 不重建表、不锁数据行）；
// information_schema 检测后执行，幂等（已含 'xingxing' 即跳过，重复跑安全）。
// 注意：生产大表执行时仅元数据变更，但仍有短暂 MDL 锁，建议低峰期跑本脚本。
const [personaCols] = await conn.query(
  `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wb_memories' AND COLUMN_NAME = 'persona'`,
);
const personaColType = String((personaCols as Array<{ COLUMN_TYPE?: string }>)[0]?.COLUMN_TYPE ?? "");
if (personaColType && !personaColType.includes("'xingxing'")) {
  await conn.query(
    `ALTER TABLE wb_memories MODIFY persona ENUM('lingshu','xingyun','xingxing') NOT NULL COMMENT '记忆所属人格（灵枢|星云|小星）'`,
  );
  console.log("wb_memories.persona: enum +'xingxing'");
} else {
  console.log("wb_memories.persona: enum 已含 'xingxing'，跳过");
}

// 主动服务消息：userId NULL=全员广播；dedupeKey 查重（同 key 存在即跳过，24h 不重复烦）。
await conn.query(`CREATE TABLE IF NOT EXISTS wb_proactive_msgs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factoryId BIGINT UNSIGNED NOT NULL COMMENT '企业隔离',
  userId BIGINT UNSIGNED NULL COMMENT 'NULL=全员广播',
  kind VARCHAR(32) NOT NULL COMMENT '消息类（device_offline/invite_expire/...）',
  content VARCHAR(500) NOT NULL,
  priority ENUM('card','speak') NOT NULL COMMENT '卡片静默|语音播报',
  dedupeKey VARCHAR(128) NOT NULL COMMENT '查重键（同 key 跳过）',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  readAt DATETIME NULL COMMENT 'NULL=未读'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("wb_proactive_msgs: ok");

await ensureIndex(
  "wb_proactive_msgs",
  "wb_proactive_factory_read_idx",
  `ALTER TABLE wb_proactive_msgs ADD INDEX wb_proactive_factory_read_idx (factoryId, readAt)`,
);
await ensureIndex(
  "wb_proactive_msgs",
  "wb_proactive_dedupe_idx",
  `ALTER TABLE wb_proactive_msgs ADD INDEX wb_proactive_dedupe_idx (dedupeKey)`,
);

await conn.end();
console.log("SYNC-M23-PASS");
