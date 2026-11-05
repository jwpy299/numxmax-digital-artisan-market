/**
 * sync-personal-agent：个人版分身系统（2026-08-27 彭总定调：养成→装扮→上架→晋升）。
 *
 * st_personal_agents：分身实体（一人一匠起，基础版只会聊天，打工走 DSH 重型轨）；
 * st_agent_slots：名额与晋升（首分身在职满2月达标→+1，上限10，低评冻结冷却）；
 * st_agent_dress：装扮（技能=衣服工具，付费穿戴位；dress_kind: skill/tool/cosmetic）。
 * additive 幂等；不改动 agents（官方匠）任何既有行为。
 */
import mysql from "mysql2/promise";

const url = process.argv[2] ?? (() => { throw new Error("必须显式传库 URL"); })();
const conn = await mysql.createConnection(url);

await conn.query(`CREATE TABLE IF NOT EXISTS st_personal_agents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_user_id BIGINT UNSIGNED NOT NULL COMMENT '主人 wb_users.id（身份根）',
  slot_no INT NOT NULL COMMENT '占用名额序号 1-10',
  name VARCHAR(32) NOT NULL COMMENT '分身名（用户起）',
  avatar_config JSON NULL COMMENT '形象参数（seed/palette 等）',
  persona_text VARCHAR(255) NULL COMMENT '性格签名',
  status VARCHAR(16) NOT NULL DEFAULT 'chat' COMMENT 'chat=基础聊天版/dressed=已装扮/intern=实习中/listed=已上架/hired=在职/suspended=下架',
  hire_score DECIMAL(4,2) NULL COMMENT '雇主评分均值（0-5）',
  hire_months INT NOT NULL DEFAULT 0 COMMENT '累计在职月数（晋升事实源）',
  list_price INT NULL COMMENT '上架月租（词元）',
  listed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_owner_slot (owner_user_id, slot_no),
  KEY idx_pa_status (status),
  KEY idx_pa_listed (status, hire_score)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='个人数字员工分身（养成系）'`);

await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_slots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  slot_no INT NOT NULL COMMENT '名额序号 1-10',
  state VARCHAR(16) NOT NULL DEFAULT 'locked' COMMENT 'open=可用/used=占用/locked=未解锁/frozen=低评冷却',
  unlocked_by BIGINT UNSIGNED NULL COMMENT '由哪个分身达标解锁 st_personal_agents.id',
  unlocked_at DATETIME NULL,
  frozen_until DATETIME NULL COMMENT '冷却截止（低评冻结）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_slot_owner_no (owner_user_id, slot_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='分身名额（晋升解锁制，上限10）'`);

await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_dress (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  agent_id BIGINT UNSIGNED NOT NULL COMMENT 'st_personal_agents.id',
  dress_kind VARCHAR(12) NOT NULL COMMENT 'skill=职业技能(衣服)/tool=执行器(工具)/cosmetic=形象音色(饰品)',
  item_key VARCHAR(64) NOT NULL COMMENT '技能/工具/饰品键',
  paid_tokens INT NOT NULL DEFAULT 0 COMMENT '实付词元',
  equipped_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  unequipped_at DATETIME NULL,
  KEY idx_dress_agent (agent_id, dress_kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='分身装扮（付费穿戴）'`);

// 首名额种子：存量用户首名额 open（additive，已存在跳过）
console.log("st_personal_agents + st_agent_slots + st_agent_dress: ready");
await conn.end();
console.log("sync-personal-agent: done");
