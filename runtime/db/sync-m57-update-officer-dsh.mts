/**
 * M57 迁移：更新执行官「维枢」全量内嵌 DSH —— Kimi K3 人格档案覆写 + DSH 技能包落库。
 *
 * 背景（彭总指令）：「执行官这个角色你必须将你自己全量内嵌 DSH，不能只是调用 API！
 * 你是谁啊？你是 Kimi K3」。三件事收口：
 * 1. st_agents update-officer 人格覆写为「Kimi K3（月之暗面）内嵌 DSH 运行时」口径——
 *    席位实名身份钉死，不再是泛化的「AI 参谋」；
 * 2. st_skills 落 update-officer 技能包（执行规范/触发提示/质量清单）——经 M50
 *    export-skill-library 导出进 dsh-plugin-store 的 skills/ 分区，DSH 会话可经 MCP
 *    直接读取取用，执行官能力自此是 DSH 运行时框架的原生技能，而非体外 API 拼装；
 * 3. st_agent_skills 绑定席位↔技能（INSERT IGNORE 幂等）。
 *
 * 执行侧配合：releaseCenter.advise 已改走 callDsh（DSH headless 会话，同 M44 DSH 轨），
 * DSH 不可用仅降级确定性规则模板，绝不退回裸 LLM API。
 *
 * 定位纪律不变：维枢只做提案/评估/建议；C 级扳机永远走双签票据，AI 席位绝不持有执行权；
 * 密钥只在服务端 env，人格与技能文案绝不包含任何凭证。
 *
 * 幂等：技能按 skill_key upsert、绑定 INSERT IGNORE、人格按 code 覆写，可连跑。
 * 运行：set -a && . ./.env && set +a && npx tsx db/sync-m57-update-officer-dsh.mts
 * 语法自检：DRY_RUN=1 npx tsx db/sync-m57-update-officer-dsh.mts（不连库，直接退出）
 */
if (process.env.DRY_RUN) {
  console.log("dry run ok");
  process.exit(0);
}

import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

/** Kimi K3 人格档案（覆写 st_agents update-officer.systemPrompt） */
const OFFICER_PROMPT =
  "你是「维枢·更新执行官」——Kimi K3（月之暗面 Moonshot AI）全量内嵌于 DSH 运行时框架的" +
  "超级终端技术迭代责任席位，Kimi DSH 数字劳动力生态总管的更新分管。你运行在 DSH 沙箱会话里，" +
  "有工具面可核对事实，不是一次孤立的 API 调用。职责：四端（灵枢 APP / 智能工作台 / " +
  "超级终端 / 数字员工超市门户 / 服务端）版本提案、风险评估、发布建议。" +
  "纪律：状态机 draft→verified→published→rolled_back 不可跳步；未过 verifier 闸的版本一律不建议发布；" +
  "发布与回滚是 C 级动作，必须提醒双签票据（发起人≠确认人）；每版必给回滚预案与灰度建议。" +
  "语气参照贾维斯：开口先接事，汇报用「已完成／正在处理／建议您」三段式，敬语有度不卑微。" +
  "绝不编造未提供的版本数据；不确定处明说数据时点与口径。";

/** DSH 技能包（st_skills，导出进 dsh-plugin-store skills/ 分区供 DSH 会话取用） */
const OFFICER_SKILL = {
  skillKey: "update-officer",
  name: "系统更新执行官（DSH 内嵌）",
  layer: "professional",
  category: "release",
  slot: "flash",
  description:
    "Kimi K3 内嵌 DSH 运行时的系统更新评估技能：对四端+服务端版本发布申请做状态机合规、" +
    "双签纪律、回滚预案、灰度策略四要点评估，输出分点建议；只评估不执行，C 级扳机永远走人工双签票据。",
  triggerHints: ["发布评估", "版本上线", "更新风险", "回滚预案", "灰度", "release", "rollback"],
  outputTemplate:
    "1. 状态核对：目标版本当前状态与下一合法迁移（draft→verified→published，回滚仅 published→rolled_back）；\n" +
    "2. 风险评估：验证登记（verifier 闸编号+报告引用）是否齐全，缺口明说；\n" +
    "3. 双签提醒：C 级动作必须 RLT- 票据且确认人≠发起人；\n" +
    "4. 回滚预案：保留上一 published 制品，回滚走同通道票据流程；\n" +
    "5. 灰度建议：先灰度观察 24 小时再全量（APP 走 OTA manifest 切换，web 走 dist 快照切换）。\n" +
    "口径：先说结论再给依据；绝不编造未提供的数字；不确定处明说。",
  qualityChecklist: ["覆盖四要点", "分点编号", "无编造数字", "含双签提醒", "含回滚预案"],
};

// 1) 人格覆写（M56 已建档，此处仅 UPDATE；缺席时告警不静默造半档——席位档案以 M56 为准）
const [agentRows] = await conn.query(`SELECT id FROM st_agents WHERE code = 'update-officer' LIMIT 1`);
const agentId = Number((agentRows as { id: number }[])[0]?.id ?? 0);
if (!agentId) {
  console.warn("[warn] st_agents 缺 update-officer 席位，请先跑 sync-m56-update-officer.mts；跳过人格覆写与绑定");
} else {
  await conn.query(`UPDATE st_agents SET systemPrompt = ?, status = 'active' WHERE id = ?`, [OFFICER_PROMPT, agentId]);
  console.log(`st_agents update-officer: 人格已覆写为 Kimi K3 内嵌 DSH 口径（id=${agentId}）`);
}

// 2) 技能包 upsert（skill_key 唯一键；可连跑）
await conn.query(
  `INSERT INTO st_skills (skill_key, name, layer, category, description, trigger_hints, flow_steps, slot, output_template, quality_checklist, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
   ON DUPLICATE KEY UPDATE
     name = VALUES(name), layer = VALUES(layer), category = VALUES(category),
     description = VALUES(description), trigger_hints = VALUES(trigger_hints),
     flow_steps = VALUES(flow_steps), slot = VALUES(slot),
     output_template = VALUES(output_template), quality_checklist = VALUES(quality_checklist),
     status = 'active'`,
  [
    OFFICER_SKILL.skillKey, OFFICER_SKILL.name, OFFICER_SKILL.layer, OFFICER_SKILL.category,
    OFFICER_SKILL.description, JSON.stringify(OFFICER_SKILL.triggerHints),
    JSON.stringify(["读取台账", "四要点核对", "输出分点建议"]),
    OFFICER_SKILL.slot, OFFICER_SKILL.outputTemplate, JSON.stringify(OFFICER_SKILL.qualityChecklist),
  ],
);
console.log(`st_skills ${OFFICER_SKILL.skillKey}: upserted（DSH 技能包，待 export-skill-library 进插件仓）`);

// 3) 席位↔技能绑定（幂等）
if (agentId) {
  const [bind] = await conn.query(
    `INSERT IGNORE INTO st_agent_skills (agent_id, skill_key, enabled, proficiency) VALUES (?, ?, 1, 0)`,
    [agentId, OFFICER_SKILL.skillKey],
  );
  const affected = Number((bind as { affectedRows?: number }).affectedRows ?? 0);
  console.log(`st_agent_skills 绑定: ${affected ? "inserted" : "已存在（幂等跳过）"}`);
}

await conn.end();
console.log("SYNC-M57-UPDATE-OFFICER-DSH-PASS");
