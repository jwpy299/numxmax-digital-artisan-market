// M12 迁移：设备直达 —— st_devices 设备台账 + st_device_commands 设备指令队列。
// 幂等：CREATE TABLE IF NOT EXISTS；additive、重复执行无副作用；绝不 drop。
// 运行（在 /opt/lingshu-wb/app 或 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-devices.mts
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

// 设备台账：enroll_key_hash 只存 sha256（明文只在签发时返回一次，绝不落库）。
// caps 为本机声明的能力白名单 JSON 数组（print/lock/screenshot/run_script），中枢下发时复核。
await conn.query(`CREATE TABLE IF NOT EXISTS st_devices (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factory_id BIGINT NOT NULL COMMENT '所属企业',
  name VARCHAR(128) NOT NULL COMMENT '设备名（如 办公室打印机/CNC-01）',
  dtype VARCHAR(48) NOT NULL DEFAULT 'workstation' COMMENT '设备类型（printer/workstation/...）',
  caps TEXT NULL COMMENT '能力白名单 JSON 数组（本机声明，中枢复核）',
  enroll_key_hash CHAR(64) NOT NULL COMMENT 'enrollKey 的 sha256（明文绝不落库）',
  status VARCHAR(16) NOT NULL DEFAULT 'offline' COMMENT 'online/offline/disabled',
  last_seen_at DATETIME NULL COMMENT '最近一次心跳时间',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_factory (factory_id),
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_devices: ok");

// 设备指令队列：pending → claimed → done/failed（cancelled 为人工取消）。
// claim 用原子 UPDATE ... WHERE status='pending' 防断线重认重复执行。
// ticket_id：C 级能力（lock/run_script）下发时必须携带的有效双签票据，回执时中枢核销。
await conn.query(`CREATE TABLE IF NOT EXISTS st_device_commands (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  device_id BIGINT NOT NULL COMMENT '目标设备',
  factory_id BIGINT NOT NULL COMMENT '所属企业（越权拦截依据）',
  cap VARCHAR(32) NOT NULL COMMENT '能力（print/lock/screenshot/run_script，白名单内）',
  payload TEXT NULL COMMENT '指令参数 JSON',
  status VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending/claimed/done/failed/cancelled',
  ticket_id BIGINT NULL COMMENT '双签票据 ID（C 级能力必填，回执核销）',
  client_key VARCHAR(64) NULL COMMENT '幂等键（企业端可选；闸口路由=gate:<intentId>）',
  result TEXT NULL COMMENT '执行回报（stdout/错误摘要，已过打码）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at DATETIME NULL,
  done_at DATETIME NULL,
  KEY idx_device_status (device_id, status),
  KEY idx_factory (factory_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_device_commands: ok");

// LOW-3 幂等键（additive、幂等：先查 information_schema 再决定 ALTER，可重复执行）：
// 老库补 client_key 列 + (device_id, client_key) 唯一索引；新库 CREATE 已含列，仅补索引。
const [colRows] = await conn.query(
  `SELECT COLUMN_NAME FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_device_commands' AND COLUMN_NAME = 'client_key'`,
);
if ((colRows as unknown[]).length === 0) {
  await conn.query(
    `ALTER TABLE st_device_commands
     ADD COLUMN client_key VARCHAR(64) NULL COMMENT '幂等键（企业端可选；闸口路由=gate:<intentId>）' AFTER ticket_id`,
  );
  console.log("st_device_commands.client_key: added");
}
const [idxRows] = await conn.query(
  `SELECT INDEX_NAME FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_device_commands' AND INDEX_NAME = 'uniq_device_client'`,
);
if ((idxRows as unknown[]).length === 0) {
  await conn.query(`ALTER TABLE st_device_commands ADD UNIQUE KEY uniq_device_client (device_id, client_key)`);
  console.log("st_device_commands.uniq_device_client: added");
}

await conn.end();
console.log("SYNC-DEVICES-PASS");
