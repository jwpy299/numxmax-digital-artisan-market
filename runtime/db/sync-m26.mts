// M26 迁移：v1.4.0 呼叫信令（wb_calls）——成员 1v1 音视频通话 + 灵枢来电。
// wb_calls：波1 全自研信令（ringing/active/ended/missed/rejected），波2 接 TRTC
// 真媒体流（roomId=`call_{id}`，UserSig 服务端签发）。callerId=0=数字人来电；
// calleeId NULL=全员广播来电。隐私红线：只落通话元数据（谁/何时/时长/类型），
// **不录音不录像**。
// 幂等：CREATE TABLE IF NOT EXISTS + information_schema 检测补索引；additive、绝不 drop。
// 运行（在 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-m26.mts
// 语法自检：DRY_RUN=1 npx tsx db/sync-m26.mts（不连库，直接退出）
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

// 呼叫信令：状态机 ringing→active→ended；ringing 45s 未接→missed（惰性清扫）；
// ringing→rejected。durationSec 应答起算。meta=灵枢来电上下文（接听后口播详情）。
await conn.query(`CREATE TABLE IF NOT EXISTS wb_calls (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factoryId BIGINT UNSIGNED NOT NULL COMMENT '企业隔离',
  callerId BIGINT UNSIGNED NOT NULL COMMENT '主叫（0=数字人灵枢/星云来电）',
  calleeId BIGINT UNSIGNED NULL COMMENT '被叫（NULL=全员广播，灵枢来电）',
  media ENUM('audio','video') NOT NULL COMMENT '语音|视频',
  roomId VARCHAR(64) NOT NULL COMMENT 'TRTC 房间号 call_{id}',
  status ENUM('ringing','active','ended','missed','rejected') NOT NULL DEFAULT 'ringing' COMMENT '振铃|通话中|已结束|未接|已拒接',
  startedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '呼叫发起（振铃开始）',
  answeredAt DATETIME NULL COMMENT 'NULL=未接听',
  endedAt DATETIME NULL COMMENT 'NULL=进行中/振铃中',
  durationSec INT NOT NULL DEFAULT 0 COMMENT '通话时长秒（answeredAt 起算，hangup 落库）',
  meta JSON NULL COMMENT '灵枢来电上下文 {persona,content,kind}；绝不存音视频内容（不录音不录像）',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("wb_calls: ok");

await ensureIndex(
  "wb_calls",
  "wb_calls_callee_status_idx",
  `ALTER TABLE wb_calls ADD INDEX wb_calls_callee_status_idx (calleeId, status)`,
);
await ensureIndex(
  "wb_calls",
  "wb_calls_factory_created_idx",
  `ALTER TABLE wb_calls ADD INDEX wb_calls_factory_created_idx (factoryId, createdAt)`,
);

await conn.end();
console.log("sync-m26 done");
