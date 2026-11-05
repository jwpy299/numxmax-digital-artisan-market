// iter89 熊猫军团派驻适配（squad-deploy）：把 5 名熊猫数字员工派驻 TEST 沙箱企业。
// 幂等：st_panda_members 租户席位按 (factory_id, role, ref_key) 先查后插/更新；
// 技能适配挂载 INSERT IGNORE。可重跑。
// 运行：set -a && . ./.env && set +a && npx tsx db/squad-deploy.mts
//
// 派驻逻辑：
//   1) wb_factories 中 enterpriseName LIKE 'TEST\_%' 的企业（沙箱双厂）
//   2) 每厂 5 行租户级席位（factory_id=企业id），角色映射同平台级，duty 带企业名适配
//   3) 按 industryText 关键词做技能挂载适配分支：
//      装备制造 → 分析师加挂 data_query（产线数据查询强化）
//      汽车零部件 → 卫士加挂 task_plan（质量巡检计划强化）
//      其他行业 → 勤务兵加挂 web_research（兜底）
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

type Row = Record<string, unknown>;
async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const [rows] = await conn.query(sql, params);
  return rows as Row[];
}

// 军团角色映射（与 db/squad-seed.mts 一致；ref_key=agents.slug）
const SQUAD = [
  { slug: "panda-scout", name: "熊猫侦察兵", role: "co", title: "侦察兵", dutyTpl: "{f}驻厂侦察兵：行业情报与竞品动态监测，每周呈报厂长" },
  { slug: "panda-scribe", name: "熊猫文书", role: "ex", title: "文书", dutyTpl: "{f}驻厂文书：周报/纪要/公文起草，文书档案归口管理" },
  { slug: "panda-analyst", name: "熊猫分析师", role: "ex", title: "分析师", dutyTpl: "{f}驻厂分析师：产线数据分析、报表归因与指标口径解读" },
  { slug: "panda-guard", name: "熊猫卫士", role: "va", title: "卫士", dutyTpl: "{f}驻厂卫士：知识问答巡检、客服应答核查与站点安全巡检" },
  { slug: "panda-runner", name: "熊猫勤务兵", role: "ev", title: "勤务兵", dutyTpl: "{f}驻厂勤务兵：任务计划编排、邮件跟进与训练档案归集" },
] as const;

// ─── 0) 前置：军团必须已入伍（先跑 squad-seed）──────────────────────────────
const agentRows = await q(
  `SELECT id, slug FROM agents WHERE slug IN (${SQUAD.map(() => "?").join(",")}) AND status = 'active'`,
  SQUAD.map((m) => m.slug),
);
const agentId = new Map(agentRows.map((r) => [String(r.slug), Number(r.id)]));
const missingAgents = SQUAD.filter((m) => !agentId.has(m.slug)).map((m) => m.slug);
if (missingAgents.length > 0) {
  throw new Error(`熊猫军团未齐编（缺 ${missingAgents.join(", ")}），请先运行 db/squad-seed.mts`);
}

// ─── 1) 拉取 TEST 沙箱企业 ──────────────────────────────────────────────────
const factories = await q(
  `SELECT id, enterpriseName, industryText FROM wb_factories
   WHERE enterpriseName LIKE 'TEST\\_%' ORDER BY id`,
);
if (factories.length === 0) {
  throw new Error("未找到 TEST_ 前缀沙箱企业，请先运行 db/sandbox-seed.mts");
}
console.log(`TEST 沙箱企业: ${factories.length} 家`);

// 企业短名：去 TEST_ 前缀与公司后缀（云测智造 / 星桥零部件）
function shortName(enterpriseName: string): string {
  return enterpriseName.replace(/^TEST_/, "").replace(/(有限公司|有限责任公司|集团|股份有限公司)$/, "");
}

// 行业适配分支：返回 [说明, [slug, skill_key][]]
function adapt(industryText: string): { note: string; extra: Array<[string, string]> } {
  if (/装备|机械|机床|制造装备/.test(industryText)) {
    return { note: "装备制造 → 分析师加挂 data_query（产线数据查询强化）", extra: [["panda-analyst", "data_query"]] };
  }
  if (/汽车|零部件|车/.test(industryText)) {
    return { note: "汽车零部件 → 卫士加挂 task_plan（质量巡检计划强化）", extra: [["panda-guard", "task_plan"]] };
  }
  return { note: `${industryText || "未知行业"} → 勤务兵加挂 web_research（兜底）`, extra: [["panda-runner", "web_research"]] };
}

const stats = { seatsInserted: 0, seatsUpdated: 0, adaptMounts: 0 };
const ledger: string[] = [];

// ─── 2) 派驻：租户级席位 upsert + 行业技能适配 ──────────────────────────────
for (const f of factories) {
  const fid = Number(f.id);
  const fname = String(f.enterpriseName);
  const short = shortName(fname);
  const itext = String(f.industryText ?? "");
  console.log(`\n派驻 ${fname}（#${fid}，${itext}）`);

  for (const m of SQUAD) {
    const duty = m.dutyTpl.replace("{f}", short);
    const dup = await q(
      `SELECT id FROM st_panda_members WHERE factory_id = ? AND role = ? AND ref_key = ? LIMIT 1`,
      [fid, m.role, m.slug],
    );
    if (dup.length > 0) {
      await conn.query(
        `UPDATE st_panda_members SET ref_type = 'agent', duty = ?, enabled = 1 WHERE id = ?`,
        [duty, Number(dup[0].id)],
      );
      stats.seatsUpdated++;
    } else {
      await conn.query(
        `INSERT INTO st_panda_members (factory_id, role, ref_type, ref_key, duty, enabled)
         VALUES (?, ?, 'agent', ?, ?, 1)`,
        [fid, m.role, m.slug, duty],
      );
      stats.seatsInserted++;
    }
    ledger.push(`| ${fname} | ${m.name} | ${m.role} | ${duty} |`);
  }

  // 行业技能适配（st_agent_skills 为 agent 级挂载：INSERT IGNORE 幂等，
  // 已挂载则仅确保 enabled=1，并在台账标注适配分支）
  const ad = adapt(itext);
  console.log(`  行业适配: ${ad.note}`);
  for (const [slug, skillKey] of ad.extra) {
    const aid = agentId.get(slug)!;
    const [res] = await conn.query(
      `INSERT IGNORE INTO st_agent_skills (agent_id, skill_key, enabled) VALUES (?, ?, 1)`,
      [aid, skillKey],
    );
    const added = Number((res as { affectedRows?: number }).affectedRows ?? 0);
    if (added === 0) {
      await conn.query(
        `UPDATE st_agent_skills SET enabled = 1 WHERE agent_id = ? AND skill_key = ?`,
        [aid, skillKey],
      );
    }
    stats.adaptMounts += added;
    ledger.push(`| ${fname} | 适配挂载 | - | ${slug} += ${skillKey}${added ? "" : "（已在编，幂等确认）"} |`);
  }
}

// ─── 3) 校核 + 派驻台账 ─────────────────────────────────────────────────────
const [seatCheck] = await q(
  `SELECT COUNT(*) AS c FROM st_panda_members m
   JOIN wb_factories f ON f.id = m.factory_id
   WHERE f.enterpriseName LIKE 'TEST\\_%' AND m.ref_key LIKE 'panda-%' AND m.enabled = 1`,
);
console.log(`\n校核: 租户级熊猫席位启用 ${Number(seatCheck?.c ?? 0)}/${factories.length * 5}`);
console.log(`DEPLOY 统计: 新增席位=${stats.seatsInserted} 更新席位=${stats.seatsUpdated} 适配新增挂载=${stats.adaptMounts}`);
console.log("\n派驻台账:");
console.log("| 企业 | 成员 | 角色 | 职责/适配 |");
console.log("| --- | --- | --- | --- |");
for (const line of ledger) console.log(line);
console.log("\nSQUAD-DEPLOY-PASS");

await conn.end();
