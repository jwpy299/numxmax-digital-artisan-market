/**
 * sync-ent-agent：企业版造人工坊+企业店铺（2026-08-27 彭总令）。
 * st_ent_agents：企业自造数字员工（模板+经验+本厂编制+实习考核）；
 * st_factory_brand：厂牌信用（连坐制：一匠砸牌全厂降曝光）。
 * additive 幂等；不碰 agents（官方匠）与 st_personal_agents（个人分身）。
 */
import mysql from "mysql2/promise";

const url = process.argv[2] ?? (() => { throw new Error("必须显式传库 URL"); })();
const conn = await mysql.createConnection(url);

await conn.query(`CREATE TABLE IF NOT EXISTS st_ent_agents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factory_id BIGINT UNSIGNED NOT NULL COMMENT '造主企业（服务端会话口径）',
  name VARCHAR(32) NOT NULL,
  template VARCHAR(32) NOT NULL COMMENT '行业模板：cs客服/sales导购/finance财税/inspect巡检/custom自定义',
  market_class VARCHAR(16) NOT NULL DEFAULT 'industry' COMMENT '超市四类（企业职能enterprise/行业方案industry）',
  experience_refs JSON NULL COMMENT '经验来源引用（SOP文档/话术库/工单集 id 数组）',
  dept_code VARCHAR(16) NULL COMMENT '挂入本厂自定义部门（x_ 前缀码）',
  status VARCHAR(16) NOT NULL DEFAULT 'crafting' COMMENT 'crafting造形中/intern实习中/listed已上架/hired在职/retired退役',
  hire_score DECIMAL(4,2) NULL COMMENT '雇主评分均值',
  list_price INT NULL COMMENT '上架月租（词元）',
  compliance_state VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT '合规审：pending/approved/rejected（industry 类必过）',
  listed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ea_factory (factory_id, status),
  KEY idx_ea_listed (status, market_class, hire_score)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='企业自造数字员工（造人工坊）'`);

await conn.query(`CREATE TABLE IF NOT EXISTS st_factory_brand (
  factory_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  brand_score DECIMAL(4,2) NULL COMMENT '厂牌评分（全厂上架员工评分加权）',
  listed_count INT NOT NULL DEFAULT 0,
  strike_count INT NOT NULL DEFAULT 0 COMMENT '砸牌次数（员工评分<3.0 连坐记）',
  exposure_tier VARCHAR(8) NOT NULL DEFAULT 'normal' COMMENT '曝光档：boosted/normal/limited（连坐降级）',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='厂牌信用（连坐制）'`);

console.log("st_ent_agents + st_factory_brand: ready");
await conn.end();
console.log("sync-ent-agent: done");
