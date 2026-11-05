// iter100 迁移：组织中枢 M1 —— 具名协议/授权链/意图/双签票据/WAL/冻结事件/双跑开关
// 运行（在 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-iter100.mts
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

// 1. 具名协议集（危险动作只可触发评审过的剧本）
await conn.query(`CREATE TABLE IF NOT EXISTS st_protocols (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(48) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  level VARCHAR(4) NOT NULL COMMENT 'A/B/C/D，D 永不自动',
  script TEXT NULL COMMENT '剧本步骤说明（json/text）',
  version INT NOT NULL DEFAULT 1,
  status VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT 'draft/review/active/retired',
  reviewed_by VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_protocols: ok");

// 2. 授权链（认链不认人：老板→负责人逐级签下，可收回，链断权死）
await conn.query(`CREATE TABLE IF NOT EXISTS st_auth_chains (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factory_id BIGINT NOT NULL,
  grantor VARCHAR(64) NOT NULL COMMENT '授权人（上级）',
  grantee VARCHAR(64) NOT NULL COMMENT '被授权人 username',
  scope VARCHAR(512) NOT NULL DEFAULT '["*"]' COMMENT 'json 数组：协议 code 或 *',
  expires_at DATETIME NULL,
  revoked_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_factory_grantee (factory_id, grantee)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_auth_chains: ok");

// 3. 意图单（龙虾只有申请单，没有枪）
await conn.query(`CREATE TABLE IF NOT EXISTS st_intents (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factory_id BIGINT NOT NULL,
  actor VARCHAR(64) NOT NULL,
  action_type VARCHAR(48) NOT NULL,
  payload TEXT NULL,
  reason VARCHAR(255) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending/pending_confirm/executed/rejected/failed',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  handled_at DATETIME NULL,
  KEY idx_factory (factory_id),
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_intents: ok");

// 4. 双签票据（60秒过期、一次性、双通道缺一不可）
await conn.query(`CREATE TABLE IF NOT EXISTS st_gate_tickets (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  intent_id BIGINT NOT NULL,
  factory_id BIGINT NOT NULL,
  policy_vote VARCHAR(16) NOT NULL,
  constitution_vote VARCHAR(16) NOT NULL,
  issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  KEY idx_intent (intent_id),
  KEY idx_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_gate_tickets: ok");

// 5. 执行 WAL（append-only：先写遗嘱再动手；不设任何 UPDATE/DELETE 代码路径）
await conn.query(`CREATE TABLE IF NOT EXISTS st_exec_wal (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_id BIGINT NOT NULL,
  intent_id BIGINT NOT NULL,
  factory_id BIGINT NOT NULL,
  phase VARCHAR(12) NOT NULL COMMENT 'prepare/execute/commit/rollback',
  undo_payload TEXT NULL,
  result TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ticket (ticket_id),
  KEY idx_factory (factory_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_exec_wal: ok");

// 6. 冻结/解冻事件（急停按钮；解冻= owner 请求 + admin 确认 双方事件）
await conn.query(`CREATE TABLE IF NOT EXISTS st_freeze_events (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factory_id BIGINT NOT NULL,
  action VARCHAR(20) NOT NULL COMMENT 'freeze/unfreeze_request/unfreeze',
  operator VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_factory (factory_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_freeze_events: ok");

// 7. 双跑开关（按厂灰度：legacy=旧直执链路，gate=意图-票据链路）
await conn.query(`CREATE TABLE IF NOT EXISTS st_factory_gate (
  factory_id BIGINT NOT NULL PRIMARY KEY,
  mode VARCHAR(12) NOT NULL DEFAULT 'legacy',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_factory_gate: ok");

// 8. 首发三个具名协议（幂等 upsert；评审人=立项签字）
const protocols: [string, string, string, string][] = [
  ["sandbox_dispatch", "沙箱训练派单", "B",
   "步骤：前置校验→LLM真答→判分→计数→适应度回写；逆操作：删除新增任务行并回退技能计数"],
  ["llm_limit_adjust", "全厂LLM限额调整", "C",
   "步骤：读取当前限额→写入新限额；逆操作：恢复旧限额"],
  ["employee_offboard", "员工离职数字资产清算", "C",
   "步骤：快照员工会话与授权链→强制下线(authToken置空)→收回其授权链；逆操作：恢复会话与授权链"],
];
for (const [code, name, level, script] of protocols) {
  await conn.query(
    `INSERT INTO st_protocols (code, name, level, script, status, reviewed_by)
     VALUES (?, ?, ?, ?, 'active', '彭毅(立项签字)')
     ON DUPLICATE KEY UPDATE name=VALUES(name), level=VALUES(level), script=VALUES(script)`,
    [code, name, level, script],
  );
  console.log(`protocol: ${code} (${level})`);
}

console.log("SYNC-ITER100-PASS");
await conn.end();
