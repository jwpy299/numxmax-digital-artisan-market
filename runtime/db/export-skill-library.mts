/**
 * M50 技能库文件化导出：st_skills 现役技能（general/professional/industry/evo/store 全层）
 * → 每技能一个标准 SKILL.md（YAML frontmatter + 正文），落到本地目录后同步进
 * dsh-plugin-store 的 skills/ 分区，智能体可经 MCP 直接读取取用。
 * 幂等：目录先清后写；index 同步重建。
 * 用法：set -a && . ./.env && set +a && npx tsx db/export-skill-library.mts /tmp/skill-library
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

type Conn = { query: (q: string, params?: unknown[]) => Promise<unknown>; end?: () => Promise<void> };

interface SkillRow {
  skill_key: string;
  name: string;
  layer: string;
  category: string;
  description: string;
  output_template: string | null;
  slot: string;
  status: string;
}

function safeKey(k: string): string {
  return k.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

async function main(conn: Conn, outDir: string): Promise<void> {
  const rows = (await conn.query(
    `SELECT skill_key, name, layer, category, description, output_template, slot, status
     FROM st_skills WHERE status = 'active' ORDER BY layer, id`,
  )) as unknown;
  const skills = (Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows) as SkillRow[];

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const index: Array<Record<string, unknown>> = [];
  for (const s of skills) {
    const key = safeKey(s.skill_key);
    const dir = `${outDir}/${key}`;
    mkdirSync(dir, { recursive: true });
    const fm = [
      "---",
      `name: ${s.name}`,
      `key: ${s.skill_key}`,
      `layer: ${s.layer}`,
      `category: ${s.category || "general"}`,
      `slot: ${s.slot || "chat"}`,
      "source: lingshu-skill-library",
      "---",
      "",
      `# ${s.name}`,
      "",
      s.description || "（无描述）",
      "",
    ].join("\n");
    const body = s.output_template
      ? `## 执行规范\n\n${s.output_template}\n`
      : "## 执行规范\n\n按技能名称与描述履行职责；先结论后依据；绝不编造数字。\n";
    const content = fm + body;
    writeFileSync(`${dir}/SKILL.md`, content, "utf8");
    index.push({
      key: s.skill_key,
      name: s.name,
      layer: s.layer,
      category: s.category || "general",
      description: (s.description || "").slice(0, 120),
      file: `skills/${key}/SKILL.md`,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    });
  }
  writeFileSync(
    `${outDir}/skills-index.json`,
    JSON.stringify(
      { libraryName: "lingshu-skill-library", version: "1.0.0", updatedAt: new Date().toISOString().slice(0, 10), count: index.length, skills: index },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`exported ${index.length} skills → ${outDir}`);
}

const isDirectRun =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL 未配置");
    process.exit(1);
  }
  const outDir = process.argv[2] ?? "/tmp/skill-library";
  const { createConnection } = await import("mysql2/promise");
  const u = new URL(url);
  const conn = await createConnection({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
  });
  await main(conn, outDir);
  await conn.end();
}
