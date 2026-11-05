// iter89 迁移：总经理 AI 参谋「枢总」—— st_agents 补 gm-advisor 档案 + st_agent_skills 挂载 4 技能
// 幂等：st_agents 按 code 检测，存在则覆写 name/title/status；st_agent_skills 用 INSERT IGNORE，可连跑。
// 挂载 agent_id 取 st_agents.id（agentTools.matchDeptSkills 的挂载反查同时兼容 agents / st_agents 两套表）。
// 运行：set -a && . ./.env && set +a && npx tsx db/sync-iter89.mts
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

// ─── 1) st_agents：补 code='gm-advisor' 参谋记录（枢总·总经理参谋，status active）─
const GM = {
  deptCode: "gm",
  code: "gm-advisor",
  name: "枢总",
  title: "总经理参谋",
  avatarEmoji: "🧭",
  systemPrompt:
    "你是「枢总」，广东灵智枢生态科技有限公司 · 灵枢星云的总经理 AI 参谋。语气干练务实，回答直给结论与可执行动作，分点表述，不空谈。" +
    "你可以基于驾驶舱实时数据回答经营问题（问数），也可以承接文档类派活（生成周报/任务计划/数据报告等产出物）。" +
    "Token 只按「结算/兑换/计量」口径表述，严禁使用金融/炒作/投机类词汇；不确定的数据不臆造，须说明数据时点与口径。",
};

const [existing] = await conn.query(`SELECT id FROM st_agents WHERE code = ? LIMIT 1`, [GM.code]);
let agentId = Number((existing as { id: number }[])[0]?.id ?? 0);
if (!agentId) {
  const [res] = await conn.query(
    `INSERT INTO st_agents (deptCode, code, name, title, avatarEmoji, systemPrompt, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')`,
    [GM.deptCode, GM.code, GM.name, GM.title, GM.avatarEmoji, GM.systemPrompt],
  );
  agentId = Number((res as { insertId?: number }).insertId ?? 0);
  console.log(`st_agents gm-advisor: inserted（枢总·总经理参谋，id=${agentId}）`);
} else {
  await conn.query(
    `UPDATE st_agents SET name = ?, title = ?, avatarEmoji = ?, systemPrompt = ?, status = 'active' WHERE id = ?`,
    [GM.name, GM.title, GM.avatarEmoji, GM.systemPrompt, agentId],
  );
  console.log(`st_agents gm-advisor: exists（id=${agentId}），已覆写档案并确保 active`);
}

// ─── 2) st_agent_skills：挂载 kb_qa + weekly_report + task_plan + data_report ──
const SKILLS = ["kb_qa", "weekly_report", "task_plan", "data_report"] as const;
let inserted = 0;
for (const key of SKILLS) {
  const [res] = await conn.query(
    `INSERT IGNORE INTO st_agent_skills (agent_id, skill_key, enabled) VALUES (?, ?, 1)`,
    [agentId, key],
  );
  inserted += Number((res as { affectedRows?: number }).affectedRows ?? 0);
}
console.log(`st_agent_skills: 新增挂载 ${inserted} 条（${SKILLS.join("/")}）`);

// ─── 3) 验证输出 ──────────────────────────────────────────────────────────────
const [check] = await conn.query(
  `SELECT m.skill_key FROM st_agent_skills m WHERE m.agent_id = ? AND m.enabled = 1 ORDER BY m.skill_key`,
  [agentId],
);
const mounted = (check as { skill_key: string }[]).map((r) => r.skill_key);
console.log(`gm-advisor 已挂载技能（${mounted.length}）:`, JSON.stringify(mounted));
const missing = SKILLS.filter((k) => !mounted.includes(k));
if (missing.length > 0) {
  console.error(`缺挂载: ${missing.join(",")}`);
  process.exitCode = 1;
} else {
  console.log("SYNC-ITER89-PASS");
}

await conn.end();
