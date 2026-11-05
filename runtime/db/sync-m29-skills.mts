/**
 * M29b 迁移「部门 Workbuddy 技能包」：给每位在役驻部智能体补齐办公技能全家桶（幂等）。
 *
 * 背景（彭总 2026-08-12 指令）：workbuddy 办公技能一项都不能落下，每个部门都要安排上，
 * 部门之间互联互通。实测现状：6 位在役 Agent 各挂 8 个办公技能，缺 excel_report /
 * ppt_make / data_query / web_research 四项 Workbuddy 核心能力。
 *
 * 动作（INSERT IGNORE，幂等可重复执行）：
 * 1. 全员基础包（每位 status='active' Agent +4）：
 *    excel_report(llm_sheet) / ppt_make(llm_ppt) / data_query(tool) / web_research(tool)
 *    ——文档/表格/PPT/数据/调研 Workbuddy 五件套自此全员齐活；
 * 2. 部门专项：finance→tax_notice（财税实务）；ops→mkt_copy（营销文案）；
 * 3. 只补不删：既有绑定（含 gm 的 data_report）一律不动；技能目录（st_skills）
 *    必须已含目标 skill_key，缺失时跳过并打印告警（绝不造无执行器的空挂）。
 *
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-m29-skills.mts
 * 语法自检：DRY_RUN=1 npx tsx db/sync-m29-skills.mts（不连库，直接退出）
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE_PACK = ["excel_report", "ppt_make", "data_query", "web_research"] as const;
const DEPT_PACK: Record<string, readonly string[]> = {
  finance: ["tax_notice"],
  ops: ["mkt_copy"],
};

type Conn = { query: (q: string, params?: unknown[]) => Promise<unknown>; end?: () => Promise<void> };

function unwrap(r: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as Array<Record<string, unknown>>;
}

async function main(conn: Conn): Promise<void> {
  const agents = unwrap(
    await conn.query(`SELECT id, code, name, deptCode FROM st_agents WHERE status = 'active'`),
  );
  const catalog = new Set(
    unwrap(await conn.query(`SELECT skill_key FROM st_skills`)).map((r) => String(r.skill_key)),
  );
  console.log(`active agents: ${agents.length}; catalog skills: ${catalog.size}`);

  let inserted = 0;
  for (const a of agents) {
    const dept = String(a.deptCode);
    const wanted = [...BASE_PACK, ...(DEPT_PACK[dept] ?? [])];
    for (const key of wanted) {
      if (!catalog.has(key)) {
        console.warn(`[warn] st_skills 目录缺 ${key}，跳过 ${a.name}(${a.code})`);
        continue;
      }
      const r = (await conn.query(
        `INSERT IGNORE INTO st_agent_skills (agent_id, skill_key, enabled, proficiency) VALUES (?, ?, 1, 0)`,
        [Number(a.id), key],
      )) as unknown;
      const header = Array.isArray(r) ? (r[0] as { affectedRows?: number }) : {};
      inserted += Number(header?.affectedRows ?? 0);
    }
  }
  console.log(`bindings inserted: ${inserted}`);

  // 验收输出：每位在役 Agent 的技能清单
  const rows = unwrap(
    await conn.query(
      `SELECT a.deptCode, a.name, COUNT(s.id) AS cnt, GROUP_CONCAT(s.skill_key ORDER BY s.skill_key) AS skills
       FROM st_agents a LEFT JOIN st_agent_skills s ON s.agent_id = a.id AND s.enabled = 1
       WHERE a.status = 'active' GROUP BY a.id ORDER BY a.deptCode`,
    ),
  );
  for (const r of rows) {
    console.log(`  ${String(r.deptCode)} ${String(r.name)}: ${String(r.cnt)} 技能 -> ${String(r.skills)}`);
  }
}

// ─── 入口（与 sync-h1.mts 同款：DRY_RUN 早退 + mysql2 直连）───────────────────
const isDirectRun =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isDirectRun) {
  if (process.env.DRY_RUN === "1") {
    console.log("DRY_RUN ok: syntax parsed");
    process.exit(0);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL 未配置");
    process.exit(1);
  }
  const { createConnection } = await import("mysql2/promise");
  const u = new URL(url);
  const conn = await createConnection({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
  });
  try {
    await main(conn as unknown as Conn);
  } finally {
    await conn.end();
  }
}

export { BASE_PACK, DEPT_PACK };
