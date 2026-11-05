// iter97 迁移：handoff 真实工单表 + 基础教育包（标配办公技能模板）
// 运行（在 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-iter97.mts
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

// 1. handoff 真实工单表
await conn.query(`CREATE TABLE IF NOT EXISTS st_handoff_tickets (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(64) NULL,
  message TEXT NULL,
  contact VARCHAR(128) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_handoff_tickets: ok");

// 2. 基础教育包：标配办公技能模板表（全局一份，所有数字员工出生自带）
await conn.query(`CREATE TABLE IF NOT EXISTS st_base_skills (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  skill_key VARCHAR(64) NOT NULL UNIQUE,
  title VARCHAR(128) NOT NULL,
  executor VARCHAR(32) NOT NULL,
  badge VARCHAR(16) NOT NULL DEFAULT '标配',
  intro VARCHAR(255) NULL,
  enabled TINYINT NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_base_skills: ok");

// 3. 标配四件套（幂等 upsert；executor 对应 skillExecutor 的真实执行器）
const baseSkills: [string, string, string, string][] = [
  ["office_doc", "Word 文档", "doc_write", "报告、方案、纪要等正式文档，真实生成 .docx 可下载"],
  ["office_sheet", "Excel 表格", "sheet_stats", "统计表、台账、清单，真实生成 .xlsx 可下载"],
  ["office_ppt", "PPT 演示", "ppt_draft", "汇报、提案演示稿，真实生成 .pptx 可下载"],
  ["daily_report", "日报周报", "generic", "每日/每周工作汇报，最高频基础技能"],
];
for (const [key, title, executor, intro] of baseSkills) {
  await conn.query(
    `INSERT INTO st_base_skills (skill_key, title, executor, intro) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE title=VALUES(title), executor=VALUES(executor), intro=VALUES(intro)`,
    [key, title, executor, intro],
  );
}
console.log("base_skills seeded: 4");

await conn.end();
console.log("SYNC-ITER97-PASS");
