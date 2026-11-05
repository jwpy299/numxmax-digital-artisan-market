/**
 * 迭代 41 —— 部门 Agent 技能执行层（T1~T4）
 *
 * ① st_agent_artifacts：技能产出物台账（docx/xlsx/pptx/research/data 文件留痕）
 * ② st_skills 增补两个「会做」技能：data_query（数据速查）、web_research（联网调研）
 *
 * 幂等：CREATE IF NOT EXISTS / 存在即跳过。
 */
import mysql from "mysql2/promise";

const url = new URL(process.env.DATABASE_URL!);
const conn = await mysql.createConnection({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.slice(1),
});

const DRY = process.env.DRY_RUN === "1";
const run = async (label: string, sql: string) => {
  console.log(`${DRY ? "[DRY] " : ""}${label}`);
  if (!DRY) await conn.execute(sql);
};

await run(
  "st_agent_artifacts 技能产出物台账",
  `CREATE TABLE IF NOT EXISTS st_agent_artifacts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    agentCode VARCHAR(32) NOT NULL,
    threadId BIGINT UNSIGNED NULL,
    actor VARCHAR(64) NOT NULL,
    channel VARCHAR(16) NOT NULL DEFAULT 'admin',
    kind VARCHAR(16) NOT NULL,
    skillKey VARCHAR(64) NULL,
    title VARCHAR(128) NOT NULL,
    filename VARCHAR(128) NOT NULL,
    filePath VARCHAR(255) NOT NULL,
    sizeBytes INT NOT NULL DEFAULT 0,
    meta JSON NULL,
    createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_agent (agentCode),
    INDEX idx_thread (threadId)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

const [rows] = await conn.query(
  `SELECT skill_key FROM st_skills WHERE skill_key IN ('data_query','web_research')`,
);
const have = new Set((rows as { skill_key: string }[]).map((r) => r.skill_key));

if (!have.has("data_query")) {
  await run(
    "st_skills + data_query 数据速查",
    `INSERT INTO st_skills (skill_key, name, layer, category, description, trigger_hints, flow_steps, slot, output_template, quality_checklist)
     VALUES ('data_query', '数据速查', 'professional', '数据',
       '自然语言查询两系统统一库的实时经营数据：账号/企业/数字员工/订单/Token/部门任务等白名单口径，返回真实数据表格。',
       '["查一下数据","实时数据","多少家","多少单","多少账号","经营数据","台账","订单多少","企业多少","Token流水","部门任务"]',
       '["识别查询口径与范围","按白名单口径查询统一库","核对数据时点","输出真实数据表格与一句解读"]',
       'brain',
       '【数据速查】{查询口径}\\n{真实数据表格}\\n数据时点：{查询时间}\\n解读：{一句话}',
       '["数据必须来自真实查询结果","标注数据时点","口径不清时说明所用口径"]')`,
  );
}
if (!have.has("web_research")) {
  await run(
    "st_skills + web_research 联网调研",
    `INSERT INTO st_skills (skill_key, name, layer, category, description, trigger_hints, flow_steps, slot, output_template, quality_checklist)
     VALUES ('web_research', '联网调研', 'professional', '调研',
       '围绕给定主题联网检索公开资料，综合多来源信息产出带来源出处的调研简报，并归档为文档产出物。',
       '["调研一下","联网查","搜一下","网上查","政策依据","行业动态","竞品","了解一下行情"]',
       '["明确调研主题与角度","联网检索并筛选可靠来源","交叉核对关键事实","输出带来源的调研简报"]',
       'brain',
       '【调研简报】{主题}\\n一、核心结论\\n{结论}\\n二、关键事实\\n{事实与来源}\\n三、建议\\n{建议}\\n来源清单：{URL列表}',
       '["关键事实必须附来源","来源不可靠时明确说明","区分事实与推测"]')`,
  );
}

console.log("迭代41 同步完成");
await conn.end();
