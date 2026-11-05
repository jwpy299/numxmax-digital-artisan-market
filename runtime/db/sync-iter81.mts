// iter81 迁移：三道闸门 + 技能焊死
// 1) st_claw_operations + exec_host（执行路由：NULL=本机执行，'s3'=s3 队列认领）+ skill_key（任务命中技能）
// 2) st_claw_skill_caps 技能动作清单（焊死：龙虾动作白名单，默认只读，submit/download 默认禁）
// 幂等：列/表/种子全部可重放。
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

async function hasColumn(table: string, col: string): Promise<boolean> {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, col],
  );
  return Number((rows as { c: number }[])[0]?.c ?? 0) > 0;
}

// 1) 执行队列表扩列
if (!(await hasColumn("st_claw_operations", "exec_host"))) {
  await conn.query(`ALTER TABLE st_claw_operations ADD COLUMN exec_host VARCHAR(16) NULL AFTER status`);
  console.log("st_claw_operations.exec_host added");
} else console.log("st_claw_operations.exec_host exists");

if (!(await hasColumn("st_claw_operations", "skill_key"))) {
  await conn.query(`ALTER TABLE st_claw_operations ADD COLUMN skill_key VARCHAR(64) NULL AFTER task`);
  console.log("st_claw_operations.skill_key added");
} else console.log("st_claw_operations.skill_key exists");

// 2) 技能动作清单表（闸门二 · 焊死层）
await conn.query(`
  CREATE TABLE IF NOT EXISTS st_claw_skill_caps (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    skill_key VARCHAR(64) NOT NULL,
    display_name VARCHAR(64) NOT NULL,
    actions JSON NOT NULL COMMENT '允许动作集: browse/screenshot/extract/submit/download/fill',
    domain_patterns JSON NOT NULL COMMENT '允许域名模式，空数组=仅 CLAW_ALLOWED_DOMAINS',
    risk VARCHAR(16) NOT NULL DEFAULT 'low',
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_skill (skill_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);
console.log("st_claw_skill_caps ensured");

// 种子：现有技能全量焊死入库。默认只读三动作（browse/screenshot/extract）；
// 交互类技能单独开启 fill/submit，显式标记风险。INSERT IGNORE 幂等。
const seeds: Array<[string, string, string[], string[], string]> = [
  ["browse_web", "网页浏览", ["browse", "screenshot"], [], "low"],
  ["read_page", "网页正文提取", ["browse", "extract"], [], "low"],
  ["screenshot_page", "网页截图取证", ["browse", "screenshot"], [], "low"],
  ["extract_data", "结构化数据提取", ["browse", "extract"], [], "low"],
  ["summarize_page", "网页内容摘要", ["browse", "extract"], [], "low"],
  ["site_audit", "站点巡检自查", ["browse", "screenshot", "extract"], [], "low"],
  ["fill_form", "表单填写（高危）", ["browse", "extract", "fill"], [], "high"],
  ["submit_form", "表单提交（高危）", ["browse", "extract", "fill", "submit"], [], "high"],
  ["download_file", "文件下载（高危）", ["browse", "download"], [], "high"],
];
for (const [key, name, actions, domains, risk] of seeds) {
  await conn.query(
    `INSERT IGNORE INTO st_claw_skill_caps (skill_key, display_name, actions, domain_patterns, risk)
     VALUES (?, ?, CAST(? AS JSON), CAST(? AS JSON), ?)`,
    [key, name, JSON.stringify(actions), JSON.stringify(domains), risk],
  );
}
console.log(`skill caps seeded (${seeds.length})`);

await conn.end();
