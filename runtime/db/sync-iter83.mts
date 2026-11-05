// iter83 迁移：3D 数字人工程 —— agents + avatar_config(JSON) + intro_text
// avatar_config：{seed, palette:{primary,accent}, ring} 由 slug 确定性生成（与前端引擎同一 hash）
// intro_text：基于 名称/行业/能力标签/战绩 生成自我介绍（购买前播放）
// 幂等：列存在跳过；仅填充 NULL 行。
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

if (!(await hasColumn("agents", "avatar_config"))) {
  await conn.query(`ALTER TABLE agents ADD COLUMN avatar_config JSON NULL AFTER avatar`);
  console.log("agents.avatar_config added");
} else console.log("agents.avatar_config exists");

if (!(await hasColumn("agents", "intro_text"))) {
  await conn.query(`ALTER TABLE agents ADD COLUMN intro_text TEXT NULL`);
  console.log("agents.intro_text added");
} else console.log("agents.intro_text exists");

// 行业色系（低饱和暖色优先，禁蓝紫渐变）
const PALETTES: Array<[string, string]> = [
  ["#e8a33d", "#7dd3c8"], // 琥珀×青
  ["#d98e4a", "#a8c686"], // 赭×苔绿
  ["#c9b458", "#e07a5f"], // 金×珊瑚
  ["#8fb8a8", "#e8a33d"], // 青灰×琥珀
  ["#d97b6c", "#9db4c0"], // 砖红×灰蓝
  ["#b5a642", "#7fa6a3"], // 橄榄×黛青
];
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const [agents] = await conn.query(
  `SELECT id, slug, name, industry, capabilityTags, tasksCompleted, successRate, monthlyPrice
   FROM agents WHERE avatar_config IS NULL OR intro_text IS NULL`,
) as Array<Record<string, unknown>>[];

let filled = 0;
for (const a of agents) {
  const h = hash(String(a.slug));
  const [primary, accent] = PALETTES[h % PALETTES.length];
  const cfg = { seed: String(a.slug), palette: { primary, accent }, ring: h % 2 === 0 };
  let tags: string[] = [];
  try { tags = JSON.parse(String(a.capabilityTags ?? "[]")) as string[]; } catch { tags = []; }
  const tagText = tags.slice(0, 3).join("、") || `${String(a.industry)}全流程`;
  const intro =
    `你好！我是${String(a.name)}，你的${String(a.industry)}数字员工。` +
    `我擅长${tagText}，已完成 ${Number(a.tasksCompleted ?? 0)} 次任务，成功率 ${Number(a.successRate ?? 98)}%。` +
    `雇佣我之后，我会 7×24 小时在岗，把重复的工作都交给我，你只管做决策。` +
    `每月 ${(Number(a.monthlyPrice ?? 0) / 100).toFixed(0)} Token，点下方按钮带我上岗吧！`;
  await conn.query(
    `UPDATE agents SET avatar_config = CAST(? AS JSON), intro_text = ? WHERE id = ? AND (avatar_config IS NULL OR intro_text IS NULL)`,
    [JSON.stringify(cfg), intro, a.id],
  );
  filled++;
}
console.log(`avatar_config/intro_text filled: ${filled}`);
await conn.end();
