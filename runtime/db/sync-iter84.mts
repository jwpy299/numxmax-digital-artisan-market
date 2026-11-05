// iter84 迁移：技能实化 —— st_skills + executor/assertion，skills(V/U) + executor，Agent↔st_skills 挂载补齐
// 幂等：列存在跳过；UPDATE 为绝对值覆写，可连跑两次。
// 执行器枚举与 api/routers/skillExecutor.ts 的 SKILL_EXECUTOR_MAP 同一约定：
//   docx | xlsx | pptx | data | research | claw | llm_doc | llm_analysis | llm_kb_qa
// 运行：set -a && . ./.env && set +a && npx tsx db/sync-iter84.mts
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

// ─── 1) st_skills：ADD COLUMN executor / assertion ───────────────────────────
if (!(await hasColumn("st_skills", "executor"))) {
  await conn.query(`ALTER TABLE st_skills ADD COLUMN executor VARCHAR(32) NULL AFTER slot`);
  console.log("st_skills.executor added");
} else console.log("st_skills.executor exists");

if (!(await hasColumn("st_skills", "assertion"))) {
  await conn.query(`ALTER TABLE st_skills ADD COLUMN assertion TEXT NULL`);
  console.log("st_skills.assertion added");
} else console.log("st_skills.assertion exists");

// ─── 2) 17 个 st_skills 写 executor + assertion（绝对值覆写，幂等）───────────
// 映射约定（与子代理 A 的 SKILL_EXECUTOR_MAP 一致）：
//   专用工具 6 个保持原 kind；文档输出类→llm_doc；数据/分析类→llm_analysis；
//   知识问答/解答应答类→llm_kb_qa；其余→llm_analysis。
const SKILL_EXEC: Array<[string, string, string]> = [
  // skill_key, executor, assertion（可机器校验的产出要求）
  ["doc_write", "docx", "产出 docx artifact，正文含背景/主体/安排三段"],
  ["sheet_stats", "xlsx", "产出 xlsx artifact，合计与明细对得上"],
  ["ppt_draft", "pptx", "产出 pptx artifact，每页要点不超过5条"],
  ["data_query", "data", "输出真实查询结果表格并标注数据时点"],
  ["web_research", "research", "输出调研简报，关键事实必须附来源URL"],
  ["claw_browser_task", "claw", "目标域名必须在白名单内且证据截图回流线程"],
  ["weekly_report", "llm_doc", "产出 docx artifact，含完成/亮点/问题/计划四段"],
  ["meeting_notes", "llm_doc", "产出 docx artifact，行动项含负责人与截止"],
  ["task_plan", "llm_doc", "产出 docx artifact，任务清单含负责人/交付物/截止"],
  ["email_compose", "llm_doc", "产出 docx artifact，含主题行/正文三段/署名"],
  ["mkt_copy", "llm_doc", "产出 docx artifact，含3组标题与明确CTA"],
  ["hr_jd", "llm_doc", "产出 docx artifact，要求分必备/加分且面试题附评分点"],
  ["ecom_listing", "llm_doc", "产出 docx artifact，含标题/五点描述/关键词且合规自查逐条标记"],
  ["data_report", "llm_doc", "输出含指标口径说明与归因分析，结论均有数据支撑"],
  ["kb_qa", "llm_kb_qa", "结论必须有引用支撑，标注来源，无引用不臆造"],
  ["cs_faq", "llm_kb_qa", "答案与知识库一致，含转人工升级路径"],
  ["tax_notice", "llm_analysis", "引用现行有效政策，含风险提示与申报时限"],
];

for (const [key, exec, assertion] of SKILL_EXEC) {
  await conn.query(`UPDATE st_skills SET executor = ?, assertion = ? WHERE skill_key = ?`, [
    exec,
    assertion,
    key,
  ]);
}
const [execDist] = await conn.query(
  `SELECT executor, COUNT(*) AS c FROM st_skills GROUP BY executor ORDER BY c DESC`,
);
const [nonNull] = await conn.query(
  `SELECT COUNT(*) AS c FROM st_skills WHERE executor IS NOT NULL`,
);
console.log(
  `st_skills executor 非 NULL: ${Number((nonNull as { c: number }[])[0]?.c ?? 0)}/17，分布:`,
  JSON.stringify(execDist),
);

// ─── 3) skills(V/U) 表：ADD COLUMN executor + 关键词映射全覆盖 ──────────────
if (!(await hasColumn("skills", "executor"))) {
  await conn.query(`ALTER TABLE skills ADD COLUMN executor VARCHAR(32) NULL AFTER type`);
  console.log("skills.executor added");
} else console.log("skills.executor exists");

// 关键词规则（name+description 拼接匹配，按优先级从上到下短路）：
//   报告/文档/纪要/文案/函件/方案 → llm_doc
//   问答/FAQ/知识库 → llm_kb_qa
//   数据/查询/台账/统计 → data
//   频谱/振动/声/诊断/识别/分析/评估/预测/检测/监测/测量 → llm_analysis
//   兜底 → llm_analysis
await conn.query(
  `UPDATE skills SET executor = CASE
     WHEN CONCAT(name, ' ', IFNULL(description, '')) REGEXP '报告|文档|纪要|文案|函件|方案|计划书|公文' THEN 'llm_doc'
     WHEN CONCAT(name, ' ', IFNULL(description, '')) REGEXP '问答|FAQ|faq|知识库' THEN 'llm_kb_qa'
     WHEN CONCAT(name, ' ', IFNULL(description, '')) REGEXP '数据|查询|台账|统计' THEN 'data'
     WHEN CONCAT(name, ' ', IFNULL(description, '')) REGEXP '频谱|振动|声学|噪声|诊断|识别|分析|评估|预测|检测|监测|测量|对比' THEN 'llm_analysis'
     ELSE NULL END`,
);
// 兜底：不允许任何技能行 executor 为 NULL
const [leftover] = await conn.query(`SELECT COUNT(*) AS c FROM skills WHERE executor IS NULL`);
const nullLeft = Number((leftover as { c: number }[])[0]?.c ?? 0);
if (nullLeft > 0) {
  await conn.query(`UPDATE skills SET executor = 'llm_analysis' WHERE executor IS NULL`);
  console.log(`skills 兜底 UPDATE llm_analysis: ${nullLeft} 行`);
}
const [skillStats] = await conn.query(
  `SELECT COUNT(*) AS total, SUM(executor IS NULL) AS nulls FROM skills`,
);
const st = (skillStats as { total: number; nulls: number | null }[])[0];
console.log(
  `skills executor 覆盖: ${Number(st?.nulls ?? 0) === 0 ? "100%" : "存在NULL!"}（共 ${Number(st?.total ?? 0)} 行，NULL ${Number(st?.nulls ?? 0)}）`,
);
const [skillDist] = await conn.query(
  `SELECT executor, COUNT(*) AS c FROM skills GROUP BY executor ORDER BY c DESC`,
);
console.log("skills executor 分布:", JSON.stringify(skillDist));

// ─── 4) Agent↔st_skills 挂载补齐（INSERT IGNORE，每 Agent 至少 2 个）────────
const [skillRows] = await conn.query(
  `SELECT skill_key, name, layer, category, description, trigger_hints
   FROM st_skills WHERE status = 'active'`,
);
interface SkillRow {
  skill_key: string;
  name: string;
  layer: string;
  category: string;
  description: string;
  trigger_hints: string | null;
}
const skillList = (skillRows as SkillRow[]).map((s) => {
  let hints: string[] = [];
  try {
    hints = s.trigger_hints ? (JSON.parse(String(s.trigger_hints)) as string[]) : [];
  } catch {
    hints = [];
  }
  return { ...s, hints };
});

const [agentRows] = await conn.query(
  `SELECT a.id, a.name, a.industry, a.industryGroup, a.capabilityTags,
          (SELECT COUNT(*) FROM st_agent_skills m WHERE m.agent_id = a.id) AS mounts
   FROM agents a`,
);
interface AgentRow {
  id: number;
  name: string;
  industry: string;
  industryGroup: string | null;
  capabilityTags: string | string[] | null;
  mounts: number;
}

let mountedAgents = 0;
let insertedMounts = 0;
for (const a of agentRows as AgentRow[]) {
  if (Number(a.mounts) >= 2) continue; // 已达标，跳过（幂等）
  let tags: string[] = [];
  try {
    tags = Array.isArray(a.capabilityTags)
      ? a.capabilityTags.map(String)
      : (JSON.parse(String(a.capabilityTags ?? "[]")) as string[]);
  } catch {
    tags = [];
  }
  const text = [a.name, a.industry, a.industryGroup, ...tags]
    .filter(Boolean)
    .map(String)
    .join(" ")
    .toLowerCase();

  // 按 trigger_hints/category/name 与 Agent 行业/能力标签匹配打分
  const scored = skillList
    .map((s) => {
      let score = 0;
      for (const h of s.hints) if (h && text.includes(String(h).toLowerCase())) score += 2;
      for (const probe of [s.category, s.name]) {
        if (probe && text.includes(String(probe).toLowerCase())) score += 1;
      }
      for (const tag of tags) {
        if (tag && (s.description.includes(tag) || s.name.includes(tag))) score += 1;
      }
      return { key: s.skill_key, score };
    })
    .sort((x, y) => y.score - x.score);

  let picks = scored.filter((s) => s.score > 0).slice(0, 2).map((s) => s.key);
  if (picks.length < 2) {
    // 兜底：挂 kb_qa + task_plan
    for (const fb of ["kb_qa", "task_plan"]) {
      if (picks.length >= 2) break;
      if (!picks.includes(fb)) picks.push(fb);
    }
  }
  for (const key of picks.slice(0, 2)) {
    const [res] = await conn.query(
      `INSERT IGNORE INTO st_agent_skills (agent_id, skill_key, enabled) VALUES (?, ?, 1)`,
      [a.id, key],
    );
    insertedMounts += Number((res as { affectedRows?: number }).affectedRows ?? 0);
  }
  mountedAgents++;
}
console.log(`挂载补齐: ${mountedAgents} 个 Agent，新增挂载 ${insertedMounts} 条`);

const [unmounted] = await conn.query(
  `SELECT COUNT(*) AS c FROM agents a
   LEFT JOIN st_agent_skills m ON m.agent_id = a.id
   WHERE m.id IS NULL`,
);
console.log(`无挂载 Agent 数: ${Number((unmounted as { c: number }[])[0]?.c ?? 0)}`);

await conn.end();
console.log("SYNC-ITER84-PASS");
