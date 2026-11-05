// iter84 冒烟：技能实化迁移五断言
// 1) st_skills.executor 非 NULL 计数 = 17
// 2) skills.executor NULL 计数 = 0
// 3) 无挂载 Agent 数 = 0（agents LEFT JOIN st_agent_skills）
// 4) executor 取值全部在合法枚举内
// 5) 负例：新插入 skills 行未跑迁移时 executor IS NULL（覆盖是迁移功劳），随后 DELETE 清理
// 运行：set -a && . ./.env && set +a && npx tsx db/smoke-iter84.mts
import assert from "node:assert/strict";
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

const LEGAL = new Set([
  "docx",
  "xlsx",
  "pptx",
  "data",
  "research",
  "claw",
  "llm_doc",
  "llm_analysis",
  "llm_kb_qa",
]);

async function one(statement: string, params: unknown[] = []): Promise<Record<string, unknown>> {
  const [rows] = await conn.query(statement, params);
  return ((rows as Record<string, unknown>[])[0] ?? {}) as Record<string, unknown>;
}

let tempSkillId = 0;
try {
  // 1) st_skills 17 技能 executor 全覆盖
  const r1 = await one(`SELECT COUNT(*) AS c FROM st_skills WHERE executor IS NOT NULL`);
  assert.equal(Number(r1.c), 17, `st_skills executor 非 NULL 应=17，实际 ${Number(r1.c)}`);
  console.log("ok: st_skills executor 非 NULL = 17");

  // 2) skills(V/U) executor 无 NULL
  const r2 = await one(`SELECT COUNT(*) AS c FROM skills WHERE executor IS NULL`);
  assert.equal(Number(r2.c), 0, `skills executor NULL 应=0，实际 ${Number(r2.c)}`);
  console.log("ok: skills executor NULL 计数 = 0");

  // 3) 无挂载 Agent = 0
  const r3 = await one(
    `SELECT COUNT(*) AS c FROM agents a
     LEFT JOIN st_agent_skills m ON m.agent_id = a.id
     WHERE m.id IS NULL`,
  );
  assert.equal(Number(r3.c), 0, `无挂载 Agent 应=0，实际 ${Number(r3.c)}`);
  console.log("ok: 无挂载 Agent 数 = 0");

  // 4) executor 取值全部合法（st_skills + skills 两表）
  for (const table of ["st_skills", "skills"]) {
    const [bad] = await conn.query(
      `SELECT DISTINCT executor FROM ${table} WHERE executor IS NOT NULL`,
    );
    for (const row of bad as { executor: string }[]) {
      assert.ok(LEGAL.has(row.executor), `${table}.executor 出现非法值: ${row.executor}`);
    }
  }
  console.log("ok: executor 取值全部在合法枚举内");

  // 5) 负例：临时 skills 行不跑迁移 → executor IS NULL（证明覆盖来自迁移而非默认值）
  const [agent] = await conn.query(`SELECT id FROM agents ORDER BY id LIMIT 1`);
  const agentId = Number((agent as { id: number }[])[0]?.id ?? 0);
  assert.ok(agentId > 0, "agents 表必须非空才能做负例");
  const [ins] = await conn.query(
    `INSERT INTO skills (agentId, name, type, complexity, pricePerCall, callCount, successRate, description)
     VALUES (?, 'iter84-冒烟临时技能', 'V', 1, 1, 0, 100, 'smoke temp, will delete')`,
    [agentId],
  );
  tempSkillId = Number((ins as { insertId?: number }).insertId ?? 0);
  const r5 = await one(`SELECT executor FROM skills WHERE id = ?`, [tempSkillId]);
  assert.ok(r5.executor === null, `新插入行 executor 应为 NULL，实际 ${String(r5.executor)}`);
  console.log("ok: 负例成立——未跑迁移的新行 executor IS NULL");

  console.log("SMOKE-ITER84-PASS");
} finally {
  if (tempSkillId > 0) {
    await conn.query(`DELETE FROM skills WHERE id = ?`, [tempSkillId]);
  }
  await conn.query(`DELETE FROM skills WHERE name = 'iter84-冒烟临时技能'`);
  console.log("cleaned");
  await conn.end();
}
process.exit(0);
