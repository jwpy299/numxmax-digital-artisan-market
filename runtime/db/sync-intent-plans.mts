// M7-d 迁移：集群规划骨架 —— 元意图计划表 / 部门职责域物化 / 元意图具名协议
// 幂等：CREATE TABLE IF NOT EXISTS + INSERT ... WHERE NOT EXISTS；重复执行无副作用。
// 运行（在 /opt/lingshu-wb/app 或 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-intent-plans.mts
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

// 1. 元意图计划（AI 拆解目标 → 具名协议组合 → 过闸执行，规划层与执行层物理分离）
await conn.query(`CREATE TABLE IF NOT EXISTS st_intent_plans (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factory_id BIGINT NOT NULL,
  actor VARCHAR(64) NOT NULL COMMENT '发起人 wb username',
  actor_role VARCHAR(16) NOT NULL COMMENT '发起时角色快照 owner/admin/member',
  goal TEXT NOT NULL COMMENT '老板的一句话目标',
  plan_json TEXT NOT NULL COMMENT '步骤数组 [{seq,actionType,payload,dept,reason}]',
  status VARCHAR(20) NOT NULL DEFAULT 'draft' COMMENT 'draft/submitted/executed/pending_confirm/rejected/failed/cancelled',
  intent_id BIGINT NULL COMMENT '元意图 st_intents.id',
  result_json TEXT NULL COMMENT '逐步执行结果 [{seq,actionType,status,intentId,note}]',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  handled_at DATETIME NULL,
  KEY idx_factory (factory_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_intent_plans: ok");

// 2. 部门职责域物化（注册部门时生成；授权链 scope 按部门隔离的落点）
await conn.query(`CREATE TABLE IF NOT EXISTS st_dept_scopes (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factory_id BIGINT NOT NULL,
  dept_name VARCHAR(64) NOT NULL,
  scope VARCHAR(512) NOT NULL DEFAULT '[]' COMMENT 'json 数组：该部门可触达的协议 code',
  duty VARCHAR(255) NULL COMMENT '职责域一句话',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_factory_dept (factory_id, dept_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_dept_scopes: ok");

// 3. 元意图具名协议（C 级：集群规划整体过闸，需 owner 确认）
await conn.query(`INSERT INTO st_protocols (code, name, level, script, version, status, reviewed_by)
  SELECT 'intent_plan_submit', '集群规划元意图', 'C',
         'AI 将老板目标拆解为白名单具名协议组合，整体作为元意图过闸；子步骤逐一独立双签+WAL，C 级子步骤两段确认', 1, 'active', 'M7-d'
  WHERE NOT EXISTS (SELECT 1 FROM st_protocols WHERE code = 'intent_plan_submit')`);
console.log("st_protocols.intent_plan_submit: ok");

await conn.end();
console.log("SYNC-INTENT-PLANS-PASS");
