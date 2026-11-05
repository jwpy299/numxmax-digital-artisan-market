// iter100 M3 迁移：中枢强化 —— 多实例心跳/修宪三方签名/行业协议集
// 运行（在 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-iter100-m3.mts
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

// 1. 中枢实例心跳（无状态多实例：状态全在 MySQL，实例只是执行躯壳）
await conn.query(`CREATE TABLE IF NOT EXISTS st_gate_instances (
  instance_id VARCHAR(80) NOT NULL PRIMARY KEY,
  host VARCHAR(64) NOT NULL,
  port INT NOT NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_heartbeat DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(16) NOT NULL DEFAULT 'alive' COMMENT 'alive/dead(心跳停止由查询方判定)'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_gate_instances: ok");

// 2. 修宪三方签名（企业主提案 → 平台副署 → 公证节点 HMAC → 生效）
await conn.query(`CREATE TABLE IF NOT EXISTS st_constitution_amendments (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factory_id BIGINT NOT NULL,
  from_level VARCHAR(4) NOT NULL,
  to_level VARCHAR(4) NOT NULL,
  reason VARCHAR(512) NULL,
  proposer VARCHAR(64) NOT NULL,
  owner_signed_by VARCHAR(64) NULL,
  owner_signed_at DATETIME NULL,
  admin_signed_by VARCHAR(64) NULL,
  admin_signed_at DATETIME NULL,
  notary_sig VARCHAR(128) NULL COMMENT 'HMAC-SHA256(payload, CONSTITUTION_NOTARY_KEY)',
  notary_signed_at DATETIME NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending_owner' COMMENT 'pending_owner/pending_admin/pending_notary/applied/rejected',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_at DATETIME NULL,
  KEY idx_factory (factory_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_constitution_amendments: ok");

// 3. 行业协议集（每签约一家厂沉淀协议 → 行业资产）
await conn.query(`CREATE TABLE IF NOT EXISTS st_industry_protocols (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  industry VARCHAR(64) NOT NULL,
  protocol_code VARCHAR(48) NOT NULL,
  protocol_name VARCHAR(128) NOT NULL,
  level VARCHAR(4) NOT NULL,
  source_factory_id BIGINT NULL COMMENT '沉淀来源厂',
  deposited_by VARCHAR(64) NOT NULL,
  note VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_industry_protocol (industry, protocol_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_industry_protocols: ok");

// 种子：现有 4 协议沉淀 2 个行业条目（幂等）
const seeds: [string, string, string, string, number | null, string][] = [
  ["机械制造", "device_rehearsal", "设备预演工单", "B", 6320219, "灵枢枢测试厂设备预演实践沉淀"],
  ["通用", "llm_limit_adjust", "全厂LLM限额调整", "C", null, "所有行业通用的成本控制协议"],
];
for (const [ind, code, name, level, fid, note] of seeds) {
  await conn.query(
    `INSERT INTO st_industry_protocols (industry, protocol_code, protocol_name, level, source_factory_id, deposited_by, note)
     VALUES (?, ?, ?, ?, ?, 'system-seed', ?)
     ON DUPLICATE KEY UPDATE protocol_name=VALUES(protocol_name)`,
    [ind, code, name, level, fid, note],
  );
  console.log(`industry-protocol: ${ind}/${code}`);
}

console.log("SYNC-ITER100-M3-PASS");
await conn.end();
