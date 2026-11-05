/**
 * sync-device-mcp：物理 MCP 注册中心（2026-08-28 彭总令：生产设备 MCP 协议走起）。
 * st_device_mcp：设备能力清单注册（manifest 自报 + 厂隔离 + 状态机）。
 * additive 幂等。
 */
import mysql from "mysql2/promise";

const url = process.argv[2] ?? (() => { throw new Error("必须显式传库 URL"); })();
const conn = await mysql.createConnection(url);

await conn.query(`CREATE TABLE IF NOT EXISTS st_device_mcp (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  device_id VARCHAR(64) NOT NULL COMMENT 'wb_devices.fingerprint 或 enroll 设备键',
  factory_id BIGINT UNSIGNED NOT NULL COMMENT '厂隔离键（服务端口径）',
  device_class VARCHAR(32) NOT NULL COMMENT 'printer/lock/sensor/gateway/machine',
  manifest JSON NOT NULL COMMENT '能力清单（tools[] 含 name/desc/level/schema）',
  status VARCHAR(16) NOT NULL DEFAULT 'online' COMMENT 'online/offline/suspended',
  last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_device_mcp (device_id, factory_id),
  KEY idx_mcp_factory (factory_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='物理 MCP 注册中心（设备即工具源）'`);

console.log("st_device_mcp: ready");
await conn.end();
console.log("sync-device-mcp: done");
