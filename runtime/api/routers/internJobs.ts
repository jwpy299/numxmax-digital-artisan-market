/**
 * internJobs —— 分身实习任务管线（2026-08-27 彭总令：分身功能完整化、确定性可用）。
 *
 * 闭环：平台派实习单（确定性模板）→ 分身干活（chat 槽轻执行，成本纪律）→
 * 确定性评分（规则制：完成度/时延/格式，不靠感觉）→ 验收确权落 st_delivery_acceptances
 * （task_ref=pa:<agentId>，上架闸的事实源）→ 评分回写分身 hire_score（滑动均值）。
 *
 * 纪律：每个分身每日实习单上限（防刷）；执行失败诚实记 failed（不计分不遮蔽）；
 * 评分规则纯函数可测；token 成本落 acceptance.token_cost（北极星护栏事实源）。
 */
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { callSlotChatFast } from "./modelGateway";
import { emitEmotionNode } from "./emotionNodes";
import { rawRows } from "../queries/rawRows"; // 战区④批A-lite：私有副本退役→canonical 叶单源


// ─── 实习单模板库（确定性：每类技能对应可判分任务） ─────────────────────────
export interface InternTask {
  taskKey: string;
  forSkill: string; // 'cs'|'sales'|'finance'|'inspect'|'general'
  prompt: string;
  /** 判分关键词（命中数即完成度） */
  rubric: string[];
}

export const INTERN_TASKS: InternTask[] = [
  { taskKey: "cs-refund", forSkill: "cs", prompt: "客户说：「我上周买的设备坏了，我要退货还要投诉你们！」请以客服身份写一段 80 字内的安抚与处理回复。", rubric: ["抱歉", "退货", "处理", "联系"] },
  { taskKey: "cs-hours", forSkill: "cs", prompt: "用户问：「你们人工客服几点上班？」写一句 30 字内的标准答复。", rubric: ["客服", "时间"] },
  { taskKey: "sales-pitch", forSkill: "sales", prompt: "为一款 399 元的智能保温杯写一句 40 字内的导购开场白。", rubric: ["保温杯", "399"] },
  { taskKey: "finance-invoice", forSkill: "finance", prompt: "员工问：「差旅费发票丢了还能报销吗？」以财税顾问身份写 60 字内的合规建议。", rubric: ["发票", "报销", "凭证"] },
  { taskKey: "inspect-report", forSkill: "inspect", prompt: "巡检发现车间地面有油渍、灭火器过期，写两条整改记录（每条 20 字内）。", rubric: ["整改", "油渍", "灭火器"] },
  { taskKey: "gen-summary", forSkill: "general", prompt: "把「本周完成 12 项巡检、发现 3 项隐患、已整改 2 项」扩写成 60 字周报摘要。", rubric: ["巡检", "隐患", "整改"] },
];

/** 确定性判分（纯规则可测）：rubric 命中≥60% 判合格，分数=40+命中数×15（封顶 5.0） */
export function scoreInternReply(reply: string, rubric: string[]): { pass: boolean; score: number; hits: number } {
  const hits = rubric.filter((k) => reply.includes(k)).length;
  const ratio = rubric.length === 0 ? 1 : hits / rubric.length;
  const pass = ratio >= 0.6;
  const score = Math.min(5, Math.round((3.4 + hits * 0.4) * 10) / 10);
  return { pass, score, hits };
}

/** 派单选择（确定性轮转：按分身已完成数取模） */
export function pickInternTask(skillKey: string | null, completed: number): InternTask {
  const pool = INTERN_TASKS.filter((t) => t.forSkill === (skillKey ?? "general"));
  const use = pool.length > 0 ? pool : INTERN_TASKS.filter((t) => t.forSkill === "general");
  return use[completed % use.length]!;
}

const DAY_CAP = 3; // 每分身每日实习单上限（防刷）

/** 主入口：给一个分身派一单实习并执行判分（挂环或手动触发均可） */
export async function runInternTask(agentId: number, ownerUserId: number, factoryId: number): Promise<{ ok: boolean; detail: string }> {
  const db = getDb();
  const today = rawRows(
    await db.execute(sql`SELECT COUNT(*) AS c FROM st_delivery_acceptances WHERE task_ref LIKE ${`pa:${agentId}:%`} AND accepted_at >= CURDATE()`),
  );
  if (Number(today[0]?.c ?? 0) >= DAY_CAP) return { ok: false, detail: "已达今日实习上限" };

  const agent = rawRows(
    await db.execute(sql`SELECT id, name, status, hire_score AS score FROM st_personal_agents WHERE id=${agentId} AND owner_user_id=${ownerUserId} LIMIT 1`),
  )[0];
  if (!agent) return { ok: false, detail: "分身不存在" };
  if (!["dressed", "intern", "listed"].includes(String(agent.status))) {
    return { ok: false, detail: `状态 ${agent.status} 不可接实习单（需先装扮）` };
  }

  const dress = rawRows(
    await db.execute(sql`SELECT item_key FROM st_agent_dress WHERE agent_id=${agentId} AND dress_kind='skill' AND unequipped_at IS NULL LIMIT 1`),
  );
  const skillKey = dress[0] ? String(dress[0].item_key) : null;
  const completed = rawRows(
    await db.execute(sql`SELECT COUNT(*) AS c FROM st_delivery_acceptances WHERE task_ref LIKE ${`pa:${agentId}:%`}`),
  );
  const task = pickInternTask(skillKey, Number(completed[0]?.c ?? 0));

  const started = Date.now();
  const r = await callSlotChatFast("flash", {
    messages: [
      { role: "system", content: `你是数字员工「${String(agent.name)}」，正在完成实习任务。要求：简洁、专业、直接给成果，不要解释过程。` },
      { role: "user", content: task.prompt },
    ],
    maxTokens: 300,
    timeoutMs: 30_000,
    context: "intern_task",
  }).catch(() => null);

  const durationMin = Math.max(1, Math.round((Date.now() - started) / 60000));
  if (!r || !r.ok || !r.content) {
    // 执行失败诚实记录（不计分）
    await db.execute(
      sql`INSERT INTO st_release_audit (release_id, channel, actor, action, detail) VALUES (0, 'server', 'intern', 'intern:failed', ${`agent:${agentId} task:${task.taskKey} 执行失败`.slice(0, 300)})`,
    );
    return { ok: false, detail: "执行失败（已留痕）" };
  }

  const verdict = scoreInternReply(r.content, task.rubric);
  if (verdict.pass) {
    // 验收确权落库（上架闸事实源；task_ref 带任务键+序号保证唯一）
    const seq = Number(completed[0]?.c ?? 0);
    await db.execute(
      sql`INSERT INTO st_delivery_acceptances (hire_record_id, factory_id, task_ref, accepted_by, accept_source, token_cost, duration_min)
          VALUES (0, ${factoryId}, ${`pa:${agentId}:${task.taskKey}:${seq}`}, ${ownerUserId}, 'intern', ${Math.max(1, Math.round((r.usageTokens ?? 300) / 10))}, ${durationMin})`,
    );
    // 评分回写（滑动均值：旧分×0.7 + 新分×0.3）
    const old = agent.score == null ? verdict.score : Number(agent.score);
    const next = Math.round((old * 0.7 + verdict.score * 0.3) * 100) / 100;
    await db.execute(
      sql`UPDATE st_personal_agents SET hire_score=${next}, status=IF(status='dressed','intern',status) WHERE id=${agentId}`,
    );
    // 情绪节点（fire-and-forget，绝不挡验收主链）：首单 / 评分首上 4.5
    if (seq === 0) void emitEmotionNode(ownerUserId, "first_order", `emo:first:pa${agentId}`, { name: String(agent.name) });
    if (old < 4.5 && next >= 4.5) void emitEmotionNode(ownerUserId, "score45", `emo:s45:pa${agentId}`, { name: String(agent.name), score: next });
    return { ok: true, detail: `合格（${verdict.hits}/${task.rubric.length} 命中，得分 ${verdict.score}，回写均分 ${next}）` };
  }
  return { ok: false, detail: `未达标（${verdict.hits}/${task.rubric.length} 命中，不计验收）` };
}
