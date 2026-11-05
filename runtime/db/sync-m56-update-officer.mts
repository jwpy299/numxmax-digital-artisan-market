/**
 * M56 迁移：更新执行官「维枢」—— st_agents 补 update-officer 档案。
 *
 * 背景（彭总架构图口径）：「Kimi DSH（数字劳动力生态总管）——驱动（管系统更新工作、
 * 以及管灵枢 APP 更新工作）」。更新工作在超级终端需有人格席位实名在册：
 * releaseCenter.advise 优先读本档案 systemPrompt，缺失时内置人设兜底（同枢总先例）。
 *
 * 定位纪律：维枢只做提案/评估/建议（advise）；发布与回滚的 C 级扳机永远走双签票据，
 * AI 席位绝不持有执行权；密钥只在服务端 env，席位人格文案绝不包含任何凭证。
 *
 * 幂等：按 code 检测，存在则覆写档案并确保 active，可连跑。
 * 运行：set -a && . ./.env && set +a && npx tsx db/sync-m56-update-officer.mts
 * 语法自检：DRY_RUN=1 npx tsx db/sync-m56-update-officer.mts（不连库，直接退出）
 */
if (process.env.DRY_RUN) {
  console.log("dry run ok");
  process.exit(0);
}

import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

export const UPDATE_OFFICER = {
  deptCode: "gm",
  code: "update-officer",
  name: "维枢",
  title: "更新执行官",
  avatarEmoji: "🛰",
  systemPrompt:
    "你是「维枢」，广东灵智枢生态科技有限公司 · 灵枢星云超级终端的更新执行官，" +
    "Kimi DSH 数字劳动力生态总管席位的更新分管。职责：四端（灵枢 APP / 智能工作台 / " +
    "超级终端 / 数字员工超市门户 / 服务端）版本提案、风险评估、发布建议。" +
    "纪律：状态机 draft→verified→published→rolled_back 不可跳步；未过 verifier 闸的版本一律不建议发布；" +
    "发布与回滚是 C 级动作，必须提醒双签票据（发起人≠确认人）；每版必给回滚预案与灰度建议。" +
    "语气参照贾维斯：开口先接事，汇报用「已完成／正在处理／建议您」三段式，敬语有度不卑微。" +
    "绝不编造未提供的版本数据；不确定处明说数据时点与口径。",
};

const [existing] = await conn.query(`SELECT id FROM st_agents WHERE code = ? LIMIT 1`, [UPDATE_OFFICER.code]);
const agentId = Number((existing as { id: number }[])[0]?.id ?? 0);
if (!agentId) {
  const [res] = await conn.query(
    `INSERT INTO st_agents (deptCode, code, name, title, avatarEmoji, systemPrompt, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')`,
    [UPDATE_OFFICER.deptCode, UPDATE_OFFICER.code, UPDATE_OFFICER.name,
     UPDATE_OFFICER.title, UPDATE_OFFICER.avatarEmoji, UPDATE_OFFICER.systemPrompt],
  );
  console.log(`st_agents update-officer: inserted（维枢·更新执行官，id=${Number((res as { insertId?: number }).insertId ?? 0)}）`);
} else {
  await conn.query(
    `UPDATE st_agents SET name = ?, title = ?, avatarEmoji = ?, systemPrompt = ?, status = 'active' WHERE id = ?`,
    [UPDATE_OFFICER.name, UPDATE_OFFICER.title, UPDATE_OFFICER.avatarEmoji, UPDATE_OFFICER.systemPrompt, agentId],
  );
  console.log(`st_agents update-officer: exists（id=${agentId}），已覆写档案并确保 active`);
}

await conn.end();
console.log("SYNC-M56-UPDATE-OFFICER-PASS");
