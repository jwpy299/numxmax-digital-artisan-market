// iter89 熊猫数字员工军团组建（squad-seed）。幂等：agents 按 slug upsert，
// st_agent_skills / skills 先查后插，st_panda_members 平台席位先查后插/更新。
// 运行：set -a && . ./.env && set +a && npx tsx db/squad-seed.mts
//
// 军团编制（平台级，factory_id = NULL）：
//   熊猫侦察兵 panda-scout  co 指挥官   web_research / data_query / kb_qa
//   熊猫文书   panda-scribe ex 执行者   doc_write / weekly_report / meeting_notes
//   熊猫分析师 panda-analyst ex 执行者  data_report / sheet_stats / data_query
//   熊猫卫士   panda-guard  va 监察者   kb_qa / cs_faq / task_plan
//   熊猫勤务兵 panda-runner ev 学习者   task_plan / email_compose / web_research
//
// 注意：tasks.create 引擎要求 agents 在 skills(V/U) 表至少 1 行，
// 否则报「该工匠暂无可用技能」——本脚本为每位成员同步写 3 行 per-agent skills。
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

type Row = Record<string, unknown>;
async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const [rows] = await conn.query(sql, params);
  return rows as Row[];
}

// ─── 军团编制表 ─────────────────────────────────────────────────────────────
interface SquadMember {
  slug: string;
  code: string;
  name: string;
  pandaRole: "co" | "ex" | "va" | "ev";
  roleLabel: string; // 角色中文（指挥/执行/监察/学习）
  tags: string[];
  mounts: string[]; // st_skills.skill_key ×3
  palette: [string, string]; // primary × accent（禁蓝紫渐变，暖色优先）
  monthlyPrice: number;
  duty: string; // 平台席位职责
  intro: string; // 角色化自我介绍（intro_text）
  // per-agent skills(V/U) 行：tasks.create 引擎依赖
  agentSkills: Array<[string, "V" | "U", number, number, string]>; // name/type/complexity/price/desc
}

const SQUAD: SquadMember[] = [
  {
    slug: "panda-scout",
    code: "PND-0001",
    name: "熊猫侦察兵",
    pandaRole: "co",
    roleLabel: "指挥官",
    tags: ["行业情报", "竞品巡检", "网页取证"],
    mounts: ["web_research", "data_query", "kb_qa"],
    palette: ["#e8a33d", "#7dd3c8"], // 琥珀×青
    monthlyPrice: 9200,
    duty: "熊猫军团指挥官：行业情报侦察、竞品动态巡检、侦察任务分解与派单",
    intro:
      "你好！我是熊猫侦察兵，熊猫军团的指挥官。我的任务是替你盯住外面的世界：" +
      "行业资讯、竞品动态、政策风向，全网公开信息我天天巡、周周报。" +
      "关键事实我都附来源链接，绝不道听途说。侦察有我，你只管决策。",
    agentSkills: [
      ["行业资讯侦察", "V", 3, 100, "抓取白名单站点行业资讯并输出带来源的简报"],
      ["竞品页面巡检", "V", 3, 100, "对竞品公开页面做定期巡检与变化摘要"],
      ["情报核实问答", "U", 2, 80, "基于知识库核实情报真伪并标注引用"],
    ],
  },
  {
    slug: "panda-scribe",
    code: "PND-0002",
    name: "熊猫文书",
    pandaRole: "ex",
    roleLabel: "执行者",
    tags: ["周报撰写", "会议纪要", "公文起草"],
    mounts: ["doc_write", "weekly_report", "meeting_notes"],
    palette: ["#d98e4a", "#a8c686"], // 赭×苔绿
    monthlyPrice: 7600,
    duty: "熊猫军团执行者：周报/纪要/公文起草，军团文书档案归口",
    intro:
      "你好！我是熊猫文书，熊猫军团的笔杆子。周报、会议纪要、公文函件，" +
      "你说个大概，我出成稿：结构齐、口径稳、行动项带负责人和截止。" +
      "重复性的写字活儿都交给我，你审一眼就能发。",
    agentSkills: [
      ["周报生成", "V", 2, 80, "按完成/亮点/问题/计划四段产出周报"],
      ["会议纪要整理", "V", 2, 80, "纪要含行动项、负责人与截止时间"],
      ["公文起草", "V", 3, 100, "起草背景/主体/安排三段式公文"],
    ],
  },
  {
    slug: "panda-analyst",
    code: "PND-0003",
    name: "熊猫分析师",
    pandaRole: "ex",
    roleLabel: "执行者",
    tags: ["数据分析", "报表归因", "指标解读"],
    mounts: ["data_report", "sheet_stats", "data_query"],
    palette: ["#c9b458", "#e07a5f"], // 金×珊瑚
    monthlyPrice: 9800,
    duty: "熊猫军团执行者：产线/经营数据分析、报表归因与指标口径解读",
    intro:
      "你好！我是熊猫分析师，熊猫军团的算盘。给我数据，我还你结论：" +
      "指标口径说清楚、差异归因有依据、每条结论都有数据撑着。" +
      "周报月报里的数字活儿，放心交给我。",
    agentSkills: [
      ["数据分析报告", "V", 3, 120, "输出含口径说明与归因分析的数据报告"],
      ["表格统计汇总", "V", 2, 80, "明细汇总核对一致并产出统计表"],
      ["经营数据查询", "U", 2, 80, "真实查询业务数据并标注数据时点"],
    ],
  },
  {
    slug: "panda-guard",
    code: "PND-0004",
    name: "熊猫卫士",
    pandaRole: "va",
    roleLabel: "监察者",
    tags: ["知识问答", "安全巡检", "客服应答"],
    mounts: ["kb_qa", "cs_faq", "task_plan"],
    palette: ["#8fb8a8", "#e8a33d"], // 青灰×琥珀
    monthlyPrice: 8400,
    duty: "熊猫军团监察者：知识库问答巡检、客服应答一致性核查、站点安全巡检",
    intro:
      "你好！我是熊猫卫士，熊猫军团的质检员。知识库问答我逐条核对引用，" +
      "客服应答我对着知识库查一致性，站点巡检我留证据截图。" +
      "没引用的话我不说，拿不准的事我升级人工。",
    agentSkills: [
      ["知识库问答", "U", 2, 80, "结论附引用来源，无引用不臆造"],
      ["客服FAQ应答", "V", 2, 60, "答案与知识库一致，含转人工升级路径"],
      ["巡检计划编排", "V", 2, 80, "巡检任务清单含负责人/交付物/截止"],
    ],
  },
  {
    slug: "panda-runner",
    code: "PND-0005",
    name: "熊猫勤务兵",
    pandaRole: "ev",
    roleLabel: "学习者",
    tags: ["任务计划", "邮件起草", "日程协调"],
    mounts: ["task_plan", "email_compose", "web_research"],
    palette: ["#d97b6c", "#9db4c0"], // 砖红×灰蓝
    monthlyPrice: 6800,
    duty: "熊猫军团学习者：任务计划编排、邮件起草、训练档案归集与复盘学习",
    intro:
      "你好！我是熊猫勤务兵，熊猫军团的大管家。任务拆计划、邮件我来拟、" +
      "资料我跑腿查。我还是军团的学习委员：每次训练的成败我都归档复盘，" +
      "下次做得更好。杂事交给我，兄弟们专心打仗。",
    agentSkills: [
      ["任务计划制定", "V", 2, 80, "任务清单含负责人/交付物/截止时间"],
      ["邮件起草", "V", 2, 60, "含主题行/正文三段/署名的商务邮件"],
      ["资料检索", "U", 2, 60, "检索公开资料并附来源整理要点"],
    ],
  },
];

// ─── 0) 前置校验：st_skills 技能键存在性 + 兜底 masterId ─────────────────────
const [skillRows, masterRows] = await Promise.all([
  q(`SELECT skill_key FROM st_skills WHERE status = 'active'`),
  q(`SELECT id, name FROM masters ORDER BY id LIMIT 1`),
]);
const skillKeys = new Set(skillRows.map((r) => String(r.skill_key)));
if (masterRows.length === 0) throw new Error("masters 表为空，先跑 db/seed.ts");
const masterId = Number(masterRows[0].id);
console.log(`master 挂靠: id=${masterId} (${String(masterRows[0].name)})`);
const missingKeys = [...new Set(SQUAD.flatMap((m) => m.mounts))].filter((k) => !skillKeys.has(k));
if (missingKeys.length > 0) throw new Error(`st_skills 缺技能键: ${missingKeys.join(", ")}`);

const stats = { agentsInserted: 0, agentsUpdated: 0, mountsAdded: 0, skillRowsAdded: 0, seatsWritten: 0 };

// ─── 1) agents 表：按 slug upsert ───────────────────────────────────────────
for (const m of SQUAD) {
  const avatarCfg = {
    seed: m.slug,
    palette: { primary: m.palette[0], accent: m.palette[1] },
    ring: true,
  };
  const exist = await q(`SELECT id FROM agents WHERE slug = ? LIMIT 1`, [m.slug]);
  if (exist.length > 0) {
    const id = Number(exist[0].id);
    await conn.query(
      `UPDATE agents SET name = ?, industry = '熊猫军团', status = 'active',
         avatar_config = CAST(? AS JSON), intro_text = ?, capabilityTags = CAST(? AS JSON)
       WHERE id = ?`,
      [m.name, JSON.stringify(avatarCfg), m.intro, JSON.stringify(m.tags), id],
    );
    stats.agentsUpdated++;
    console.log(`agent 更新: ${m.slug} (#${id})`);
  } else {
    const [res] = await conn.query(
      `INSERT INTO agents
         (slug, code, name, avatar, avatar_config, intro_text, industry, industryGroup,
          capabilityTags, masterId, status, monthlyPrice, suggestedPrice,
          tasksCompleted, successRate, avgRating, ratingCount, experienceMonths,
          skillCount, memoryCount, weeklyHires, weeklyHireTrend, recommended, certified)
       VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, '熊猫军团', '工业制造',
               CAST(? AS JSON), ?, 'active', ?, ?, 0, 98, 5, 0, 0, 3, 0, 0, CAST(? AS JSON), 0, 1)`,
      [
        m.slug, m.code, m.name, `/avatar-${m.slug}.png`, JSON.stringify(avatarCfg), m.intro,
        JSON.stringify(m.tags), masterId, m.monthlyPrice, m.monthlyPrice - 120,
        JSON.stringify([0, 0, 0, 0, 0, 0, 0]),
      ],
    );
    stats.agentsInserted++;
    console.log(`agent 入伍: ${m.slug} (#${Number((res as { insertId: number }).insertId)})`);
  }
}

// 取回 agent id 映射
const idRows = await q(
  `SELECT id, slug FROM agents WHERE slug IN (${SQUAD.map(() => "?").join(",")})`,
  SQUAD.map((m) => m.slug),
);
const agentId = new Map(idRows.map((r) => [String(r.slug), Number(r.id)]));

// ─── 2) st_agent_skills 挂载（INSERT IGNORE，uniq_agent_skill 幂等）─────────
for (const m of SQUAD) {
  const aid = agentId.get(m.slug)!;
  for (const key of m.mounts) {
    const [res] = await conn.query(
      `INSERT IGNORE INTO st_agent_skills (agent_id, skill_key, enabled) VALUES (?, ?, 1)`,
      [aid, key],
    );
    stats.mountsAdded += Number((res as { affectedRows?: number }).affectedRows ?? 0);
  }
  console.log(`st_agent_skills: ${m.slug} ← ${m.mounts.join("/")}`);
}

// ─── 3) skills(V/U) 行（tasks.create 引擎依赖；按 agentId+name 先查后插）────
for (const m of SQUAD) {
  const aid = agentId.get(m.slug)!;
  for (const [name, type, complexity, price, desc] of m.agentSkills) {
    const dup = await q(`SELECT id FROM skills WHERE agentId = ? AND name = ? LIMIT 1`, [aid, name]);
    if (dup.length > 0) continue;
    await conn.query(
      `INSERT INTO skills (agentId, name, type, complexity, pricePerCall, callCount, successRate, description)
       VALUES (?, ?, ?, ?, ?, 0, 98, ?)`,
      [aid, name, type, complexity, price, desc],
    );
    stats.skillRowsAdded++;
  }
  console.log(`skills(V/U): ${m.slug} ${m.agentSkills.length} 行就绪`);
}

// ─── 4) st_panda_members 平台级席位（factory_id NULL；先查后插/更新）─────────
// 唯一键 uk_seat_v2 = (factory_key, role, ref_key)，平台级 factory_key=0。
// 注意：ref_key=slug，同一成员平台级与租户级（squad-deploy）各占一行。
for (const m of SQUAD) {
  const dup = await q(
    `SELECT id FROM st_panda_members WHERE factory_id IS NULL AND role = ? AND ref_key = ? LIMIT 1`,
    [m.pandaRole, m.slug],
  );
  if (dup.length > 0) {
    await conn.query(
      `UPDATE st_panda_members SET ref_type = 'agent', duty = ?, enabled = 1 WHERE id = ?`,
      [m.duty, Number(dup[0].id)],
    );
  } else {
    await conn.query(
      `INSERT INTO st_panda_members (factory_id, role, ref_type, ref_key, duty, enabled)
       VALUES (NULL, ?, 'agent', ?, ?, 1)`,
      [m.pandaRole, m.slug, m.duty],
    );
  }
  stats.seatsWritten++;
}
console.log(`st_panda_members 平台席位: ${stats.seatsWritten}/5`);

// ─── 5) 汇总 ────────────────────────────────────────────────────────────────
const [check] = await q(
  `SELECT COUNT(*) AS c FROM agents WHERE industry = '熊猫军团' AND status = 'active'`,
);
const [mountCheck] = await q(
  `SELECT COUNT(*) AS c FROM st_agent_skills m JOIN agents a ON a.id = m.agent_id
   WHERE a.industry = '熊猫军团' AND m.enabled = 1`,
);
console.log(
  `SQUAD 统计: 新增agent=${stats.agentsInserted} 更新agent=${stats.agentsUpdated} ` +
    `新增挂载=${stats.mountsAdded} 新增skills行=${stats.skillRowsAdded} 平台席位=${stats.seatsWritten}`,
);
console.log(`校核: 熊猫军团 active=${Number(check?.c ?? 0)}/5，启用挂载=${Number(mountCheck?.c ?? 0)}/15`);
console.log("SQUAD-SEED-PASS");

await conn.end();
