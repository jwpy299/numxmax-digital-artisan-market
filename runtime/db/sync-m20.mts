// M20 迁移：波 1 语音技能路由层 —— st_skill_calls（技能调用记账 + 每日预算熔断计数源）；
//           波 2 PPT/Excel 执行器 —— st_skills 种子（ppt_make/excel_report，幂等补插）。
// 幂等：CREATE TABLE IF NOT EXISTS + INSERT ... SELECT ... WHERE NOT EXISTS；重复执行无副作用。
// 运行（在 /opt/lingshu-wb/app 或 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-m20.mts
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

// 技能调用流水：voiceSkills.recordSkillCall 每次调用写一行（ok/failed 都记，成本闸门口径）；
// 路由层对表缺失静默降级（内存计数兜底），但生产环境应执行本迁移以保证审计可追。
await conn.query(`CREATE TABLE IF NOT EXISTS st_skill_calls (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factory_id BIGINT NOT NULL,
  session_id BIGINT NULL COMMENT '关联 st_voice_sessions.id（语音入口）',
  user VARCHAR(64) NOT NULL COMMENT 'wb username',
  skill_key VARCHAR(64) NOT NULL COMMENT 'st_skills.skill_key 或 agent_skill_<skills.id>',
  skill_name VARCHAR(64) NOT NULL DEFAULT '',
  price INT NOT NULL DEFAULT 100 COMMENT '单次调用记账价（Token）',
  status VARCHAR(16) NOT NULL DEFAULT 'ok' COMMENT 'ok/failed',
  note VARCHAR(255) NULL COMMENT '用户指令摘要',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_factory_day (factory_id, created_at),
  KEY idx_skill (skill_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_skill_calls: ok");

// ─── M20 波 2：ppt_make / excel_report 技能种子 ─────────────────────────────
// 执行器映射在 api/routers/skillExecutor.ts（GENERIC_SKILL_EXECUTOR_MAP：ppt_make→llm_ppt、
// excel_report→llm_sheet）；此处只补 st_skills 五件套（trigger_hints/flow_steps/
// output_template/quality_checklist），供路由层 buildMatchedSkill 与 prompt 注入使用。
// 幂等：skill_key UNIQUE，已存在则跳过（不覆盖人工后续在商城/后台改过的行）。
const M20_WAVE2_SKILLS = [
  {
    key: "ppt_make",
    name: "PPT制作",
    category: "办公",
    description: "按主题生成品牌模板 PPT（经营汇报/项目路演/培训课件三套版式）",
    triggerHints: ["做个PPT", "幻灯片", "汇报演示", "PPT", "演示文稿"],
    flowSteps: ["理解主题与受众", "LLM 出大纲（标题+要点，引用企业实况）", "模板渲染 pptx", "文件投递"],
    outputTemplate: "【PPT大纲】封面 → 目录 → 3~5 页内容（标题+≤5 条要点）→ 结尾页",
    qualityChecklist: ["大纲结构完整（封面/目录/内容/结尾）", "每页要点不超过 5 条", "数字引用企业实况不编造"],
  },
  {
    key: "excel_report",
    name: "Excel报表",
    category: "办公",
    description: "拉企业实况数据成 Excel 报表（经营数据三栏表/台账明细表）",
    triggerHints: ["拉个表", "Excel", "报表", "台账", "做个表"],
    flowSteps: ["确认报表类型", "取企业实况数据（禁止编造）", "模板渲染 xlsx", "文件投递"],
    outputTemplate: "【报表】经营数据三栏表（指标/数值/环比说明）或台账明细表（表头+行数据）",
    qualityChecklist: ["数值取自企业实况", "行列结构完整", "附一句话结论"],
  },
] as const;

for (const s of M20_WAVE2_SKILLS) {
  await conn.query(
    `INSERT INTO st_skills
       (skill_key, name, layer, category, description, trigger_hints, flow_steps, slot, output_template, quality_checklist, status)
     SELECT ?, ?, 'general', ?, ?, CAST(? AS JSON), CAST(? AS JSON), 'chat', ?, CAST(? AS JSON), 'active'
     FROM DUAL
     WHERE NOT EXISTS (
       SELECT 1 FROM (SELECT skill_key FROM st_skills) AS _existing WHERE _existing.skill_key = ?
     )`,
    [
      s.key,
      s.name,
      s.category,
      s.description,
      JSON.stringify(s.triggerHints),
      JSON.stringify(s.flowSteps),
      s.outputTemplate,
      JSON.stringify(s.qualityChecklist),
      s.key,
    ],
  );
  console.log(`st_skills seed ${s.key}: ok`);
}

await conn.end();
console.log("SYNC-M20-PASS");
