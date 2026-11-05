/**
 * M30 迁移「班组语音房」：st_voice_rooms + st_voice_room_msgs（幂等）。
 *
 * 班组语音房 = 腾讯会议式多人协同（人与 Agent 同席）：
 * - st_voice_rooms：房间登记（企业内 admin/manager 可开，同席智能体 agentCodes JSON）；
 *   TRTC 房间号 = room_{id}（与 wb_calls 的 call_{id} 同款字符串房号口径）；
 * - st_voice_room_msgs：房内文字流（人说话 ASR 落句 / Agent 应答 / 系统消息），
 *   App 端对 agent 消息本机 TTS 播报（Agent 不占 TRTC 麦位，零房费）。
 *
 * 幂等：CREATE TABLE IF NOT EXISTS，可重复执行。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-m30.mts
 * 语法自检：DRY_RUN=1 npx tsx db/sync-m30.mts
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Conn = { query: (q: string, params?: unknown[]) => Promise<unknown>; end?: () => Promise<void> };

const DDL: [string, string][] = [
  [
    "st_voice_rooms 班组语音房",
    `CREATE TABLE IF NOT EXISTS st_voice_rooms (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      factoryId BIGINT UNSIGNED NOT NULL,
      roomId VARCHAR(32) NOT NULL,
      title VARCHAR(128) NOT NULL,
      createdBy BIGINT UNSIGNED NOT NULL,
      agentCodes JSON NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'open',
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closedAt TIMESTAMP NULL,
      UNIQUE KEY uk_roomid (roomId),
      INDEX idx_factory (factoryId, status)
    )`,
  ],
  [
    "st_voice_room_msgs 房内文字流",
    `CREATE TABLE IF NOT EXISTS st_voice_room_msgs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      roomId BIGINT UNSIGNED NOT NULL,
      factoryId BIGINT UNSIGNED NOT NULL,
      userId BIGINT UNSIGNED NULL,
      agentCode VARCHAR(32) NULL,
      kind VARCHAR(16) NOT NULL DEFAULT 'user',
      text VARCHAR(2000) NOT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_room (roomId, id),
      INDEX idx_factory (factoryId)
    )`,
  ],
];

async function main(conn: Conn): Promise<void> {
  for (const [label, ddl] of DDL) {
    await conn.query(ddl);
    console.log(`${label}: ensured`);
  }
}

const isDirectRun =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isDirectRun) {
  if (process.env.DRY_RUN === "1") {
    console.log("DRY_RUN ok: syntax parsed");
    process.exit(0);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL 未配置");
    process.exit(1);
  }
  const { createConnection } = await import("mysql2/promise");
  const u = new URL(url);
  const conn = await createConnection({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
  });
  try {
    await main(conn as unknown as Conn);
  } finally {
    await conn.end();
  }
}
