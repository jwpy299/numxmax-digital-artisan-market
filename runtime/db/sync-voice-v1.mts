// M7-c 迁移：语音入口 V1 —— 语音会话/语音指令流水（组织中枢 voice 路由）
// 幂等：CREATE TABLE IF NOT EXISTS；重复执行无副作用。
// 运行（在 /opt/lingshu-wb/app 或 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-voice-v1.mts
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

// 1. 语音会话（与 wb token 单点绑定；5 分钟无活动自动关闭；C 级复述暂存于 pending_action）
await conn.query(`CREATE TABLE IF NOT EXISTS st_voice_sessions (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factory_id BIGINT NOT NULL,
  user VARCHAR(64) NOT NULL COMMENT 'wb username',
  persona VARCHAR(16) NOT NULL COMMENT 'lingshu/xingyun',
  status VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT 'active/closed/expired',
  pending_action TEXT NULL COMMENT '待复述确认的意图草稿 json：{actionType,payload,reason,recite,createdAt}',
  last_activity_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME NULL,
  KEY idx_factory_user (factory_id, user, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_voice_sessions: ok");

// 2. 语音指令流水（识别原文/回复/关联意图，双向可追）
await conn.query(`CREATE TABLE IF NOT EXISTS st_voice_utterances (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_id BIGINT NOT NULL,
  factory_id BIGINT NOT NULL,
  role VARCHAR(16) NOT NULL COMMENT 'user/agent',
  persona VARCHAR(16) NULL,
  text TEXT NOT NULL,
  asr_confidence DECIMAL(4,3) NULL,
  intent_id BIGINT NULL COMMENT '关联 st_intents.id',
  kind VARCHAR(16) NOT NULL DEFAULT 'chat' COMMENT 'chat/action/confirm/cancel/recite/reject',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_session (session_id),
  KEY idx_factory (factory_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_voice_utterances: ok");

await conn.end();
console.log("SYNC-VOICE-V1-PASS");
