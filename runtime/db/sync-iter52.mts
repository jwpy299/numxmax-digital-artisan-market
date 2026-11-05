/**
 * sync-iter52 —— 龙虾 P3：操作单来源上下文 + 员工唤虾技能。
 * 幂等。运行：set -a && . ./.env && set +a && npx tsx db/sync-iter52.mts
 */
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

const [cols] = await conn.query(
  `SELECT COLUMN_NAME FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_claw_operations' AND COLUMN_NAME = 'ctx_json'`,
);
if ((cols as unknown[]).length === 0) {
  await conn.query(`ALTER TABLE st_claw_operations ADD COLUMN ctx_json TEXT NULL AFTER instance_key`);
}

await conn.query(
  `INSERT INTO st_skills (skill_key, name, layer, category, description, trigger_hints, flow_steps, slot, output_template, quality_checklist, status)
   VALUES ('claw_browser_task', '龙虾浏览器代办', 'general', 'automation',
     '让龙虾替你操作浏览器：打开网页、查看内容、截图取证',
     '["打开网页","打开网站","访问网站","访问网页","网页截图","截图保存","浏览器","网页抓取","帮我看看这个网站","帮我看看网站"]',
     '["确认目标网址在白名单","派活给龙虾实例","等待浏览器执行","证据截图回流本对话"]',
     'flash',
     '龙虾已接单，浏览器任务执行中（约3-10分钟），完成后证据会自动出现在本对话。',
     '["目标域名必须在白名单内","必须保留操作审计","证据截图必须回流发起线程"]',
     'active')
   ON DUPLICATE KEY UPDATE description = VALUES(description), trigger_hints = VALUES(trigger_hints),
     flow_steps = VALUES(flow_steps), output_template = VALUES(output_template),
     quality_checklist = VALUES(quality_checklist), status = 'active'`,
);

await conn.end();
console.log("SYNC_ITER52_OK");
