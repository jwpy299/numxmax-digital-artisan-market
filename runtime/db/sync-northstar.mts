/**
 * sync-northstar：北极星指标字典（2026-08-26 彭总拍板 B主C校验A辅助）。
 * st_northstar_metrics：北极星/护栏/输入指标字典 + 现值快照（additive 幂等）。
 * 口径：主=周验收交付数（用户验收确权，系统自记不算）；校验=雇佣续费率；辅助=有效雇佣时长。
 */
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

const url = process.argv[2] ?? readFileSync("/mnt/agents/output/migration/env.production.机密-用后删除", "utf8")
  .match(/^DATABASE_URL=(.+)$/m)![1].trim();
const conn = await mysql.createConnection(url);

await conn.query(`CREATE TABLE IF NOT EXISTS st_northstar_metrics (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  metric_key VARCHAR(64) NOT NULL UNIQUE COMMENT '指标键：weekly_verified_deliveries 等',
  layer VARCHAR(16) NOT NULL COMMENT '层级：north_star/verify/auxiliary/guard/input',
  name VARCHAR(64) NOT NULL COMMENT '中文名',
  definition VARCHAR(512) NOT NULL COMMENT '口径定义（含确权规则）',
  owner_dept VARCHAR(32) NULL COMMENT '责任小环（部门码）',
  direction VARCHAR(8) NOT NULL DEFAULT 'up' COMMENT 'up=越高越好/down=越低越好',
  current_value DECIMAL(20,4) NULL COMMENT '最新快照值',
  snapshot_at DATETIME NULL COMMENT '快照时间',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='北极星指标字典（组织最高目标+护栏）'`);
console.log("st_northstar_metrics: ready");

// N3 验收确权点：周验收交付数的事实源。只接受用户主动验收动作写入，系统不得代记。
await conn.query(`CREATE TABLE IF NOT EXISTS st_delivery_acceptances (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  hire_record_id BIGINT UNSIGNED NOT NULL COMMENT '雇佣合约 agent_hire_records.id',
  factory_id BIGINT NULL COMMENT '企业隔离（服务端会话取，绝不收客户端传值）',
  task_ref VARCHAR(128) NOT NULL COMMENT '任务引用（工作台任务/委派 collabId）',
  accepted_by BIGINT UNSIGNED NOT NULL COMMENT '验收人用户 id（用户主动动作）',
  accept_source VARCHAR(16) NOT NULL DEFAULT 'app' COMMENT '确权渠道：app/wb/api',
  token_cost INT NULL COMMENT '本次交付 token 成本（护栏指标事实源）',
  duration_min INT NULL COMMENT '接单到验收分钟数（平均交付时长事实源）',
  accepted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_accept_week (accepted_at),
  KEY idx_accept_hire (hire_record_id),
  UNIQUE KEY uk_task_accept (task_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='验收确权事件（北极星主指标事实源）'`);
console.log("st_delivery_acceptances: ready");

const SEED: [string, string, string, string, string | null, string][] = [
  ["weekly_verified_deliveries", "north_star", "周验收交付数", "一周内用户验收通过的交付任务数；确权点=用户主动验收动作，系统自记不算", null, "up"],
  ["retention_renewal_rate", "verify", "雇佣续费率", "月度校验：到期继续雇佣比例；交付涨而续费跌=灌水，环停线检讨", "ops", "up"],
  ["effective_hire_hours", "auxiliary", "有效雇佣时长", "数字员工实际产出交付的时长（防磨洋工）", null, "up"],
  ["refund_complaint_rate", "guard", "退款/投诉率", "护栏：碰线即元治理叫停", "legal", "down"],
  ["token_cost_per_delivery", "guard", "单交付Token成本", "护栏：每次交付的 token 成本，防烧钱冲量", "tech", "down"],
  ["compliance_zero_miss", "guard", "合规零漏过", "护栏：法务硬约束拦截零漏过、跨厂隔离零事故", "legal", "up"],
  ["signup_to_hire_rate", "input", "首次雇佣转化率", "获客：新注册→首次雇佣", "market", "up"],
  ["first_pass_rate", "input", "一次通过率", "交付：任务无需返工的比例", "tech", "up"],
  ["avg_delivery_hours", "input", "平均交付时长", "交付：接单到验收的时长", "tech", "down"],
  ["voice_completion_rate", "input", "语音交互完成率", "体验：语音会话完成率（中途挂断=失败信号）", "ops", "up"],
  ["d7_active_hire_rate", "input", "7日活跃雇佣率", "留存：7日内有交付行为的雇佣比例", "ops", "up"],
];
for (const [k, layer, name, def, dept, dir] of SEED) {
  await conn.query(
    `INSERT INTO st_northstar_metrics (metric_key, layer, name, definition, owner_dept, direction)
     VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name), definition=VALUES(definition), owner_dept=VALUES(owner_dept), direction=VALUES(direction)`,
    [k, layer, name, def, dept, dir],
  );
}
const [rows] = await conn.query("SELECT layer, COUNT(*) n FROM st_northstar_metrics GROUP BY layer ORDER BY layer");
console.log("seed:", JSON.stringify(rows));
await conn.end();
console.log("sync-northstar: done");
