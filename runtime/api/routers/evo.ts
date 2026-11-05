/**
 * evo —— 迭代 30「自学习自进化引擎」服务端路由（契约 §3）。
 *
 * 数据表（db/sync-ops.mts 幂等创建，一律 raw SQL 访问）：
 * - st_skill_feedback  反馈信号（useful/useless/rework，双轨鉴权写入）
 * - st_evo_proposals   进化提案（pending→approved→applied / rejected，全程留痕）
 * - st_evo_reports     进化周报（week 唯一，重生成覆盖）
 *
 * 鉴权：管理类 requireAdmin（token 只在请求体）；feedback 双轨——
 * 先 requireAdmin，失败则按工作台企业会话（wb_users.authToken）取 factoryId，
 * 客户端传入的 factoryId 必须与该 token 对应企业一致。
 * LLM 全部走 modelGateway.callSlotChat（brain 槽 = kimi-k3，调用层已强制 temperature=1）；
 * 失败静默回退规则模板，绝不向上抛错、不回传错误原因。
 */
import { z } from "zod";
import { resolveWbUserByToken } from "./wbSession"; // P3-6 双轨解析单点
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { noteSilent } from "./silentWatch";
import { rawRows, requireAdmin } from "./terminal";
import { callSlotChat } from "./modelGateway";
import { writeAdminAudit, adminDisplayName } from "./adminAnalytics";
import { getSkillEffectiveness } from "./agentTools";

const tokenInput = z.object({ token: z.string().trim().min(1) });

/** st_ 表查询兜底：表缺失按空集降级 */
async function stRows(statement: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  try {
    return rawRows(await getDb().execute(statement));
  } catch {
    return [];
  }
}

/** ISO 周编号（如 2026W31） */
export function isoWeek(d = new Date()): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // 周一=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // 本周周四
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${date.getUTCFullYear()}W${String(week).padStart(2, "0")}`;
}

// ─── feedback 双轨鉴权 ──────────────────────────────────────────────────────
type FeedbackActor =
  | { kind: "admin"; username: string; factoryId: number | null }
  | { kind: "factory"; username: string; factoryId: number };

/** 先 requireAdmin；失败则按工作台企业 token（wb_users.authToken）取 factoryId */
async function feedbackActor(token: string, clientFactoryId?: number): Promise<FeedbackActor> {
  try {
    const admin = await requireAdmin(token);
    return {
      kind: "admin",
      username: String(admin.username ?? "admin"),
      factoryId: clientFactoryId ?? null, // admin 可为任意企业代录
    };
  } catch (err) {
    if (!(err instanceof TRPCError)) throw err;
  }
  const db = getDb();
  const user = await resolveWbUserByToken(db, token); // P3-6 双轨单点同引
  if (!user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "需要管理员或企业账号权限" });
  }
  const factoryId = Number(user.factoryId);
  if (clientFactoryId !== undefined && clientFactoryId !== factoryId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "factoryId 与当前企业账号不一致" });
  }
  return { kind: "factory", username: String(user.username ?? "enterprise"), factoryId };
}

// ─── 周复盘数据汇总 ─────────────────────────────────────────────────────────
interface WeeklyDigest {
  feedback: Array<Record<string, unknown>>;
  alertsOpen: number;
  alertsWeek: number;
  csSessionsWeek: number;
  mounts: number;
  skills: number;
}

async function collectWeeklyDigest(): Promise<WeeklyDigest> {
  const [feedback, alertsOpenRows, alertsWeekRows, csRows, mountRows, skillRows] = await Promise.all([
    stRows(
      sql`SELECT agent_id, skill_key,
                 SUM(\`signal\` = 'useful') AS useful,
                 SUM(\`signal\` = 'useless') AS useless,
                 SUM(\`signal\` = 'rework') AS rework,
                 COUNT(*) AS total
          FROM st_skill_feedback
          WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
          GROUP BY agent_id, skill_key ORDER BY total DESC LIMIT 50`,
    ),
    stRows(sql`SELECT COUNT(*) AS c FROM ops_alerts WHERE status = 'open'`),
    stRows(sql`SELECT COUNT(*) AS c FROM ops_alerts WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`),
    stRows(sql`SELECT COUNT(*) AS c FROM cs_sessions WHERE last_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`),
    stRows(sql`SELECT COUNT(*) AS c FROM st_agent_skills WHERE enabled = 1`),
    stRows(sql`SELECT COUNT(*) AS c FROM st_skills WHERE status = 'active'`),
  ]);
  return {
    feedback,
    alertsOpen: Number(alertsOpenRows[0]?.c ?? 0),
    alertsWeek: Number(alertsWeekRows[0]?.c ?? 0),
    csSessionsWeek: Number(csRows[0]?.c ?? 0),
    mounts: Number(mountRows[0]?.c ?? 0),
    skills: Number(skillRows[0]?.c ?? 0),
  };
}

/** 规则兜底提案：为低分技能（差评/返工聚集）生成改进提案 */
function fallbackProposals(digest: WeeklyDigest): Array<{
  target_type: "skill" | "agent" | "knowledge" | "ops";
  target_key: string;
  title: string;
  content: string;
  evidence: string;
}> {
  const out: Array<{ target_type: "skill"; target_key: string; title: string; content: string; evidence: string }> = [];
  for (const f of digest.feedback) {
    const useless = Number(f.useless ?? 0);
    const rework = Number(f.rework ?? 0);
    const useful = Number(f.useful ?? 0);
    const total = Number(f.total ?? 0);
    if (total >= 1 && useless + rework > useful) {
      out.push({
        target_type: "skill",
        target_key: String(f.skill_key),
        title: `改进技能「${String(f.skill_key)}」的产出质量`,
        content:
          `近 7 天该技能在员工 #${Number(f.agent_id)} 上收到 ${useless} 次「没用」、${rework} 次「返工」反馈，` +
          `高于「有用」反馈（${useful} 次）。建议：①复核该技能流程步骤与输出模板是否匹配实际业务场景；` +
          `②针对返工原因补充质量检查清单；③必要时调整槽位模型或收紧触发范围。`,
        evidence: `近7天反馈：有用 ${useful} / 没用 ${useless} / 返工 ${rework}（员工 #${Number(f.agent_id)}）`,
      });
    }
  }
  if (out.length === 0) {
    out.push({
      target_type: "skill",
      target_key: "_global",
      title: "保持技能体系观察，暂无低分技能",
      content:
        "近 7 天技能反馈未出现差评/返工聚集。建议持续观察高频使用技能的反馈结构，" +
        "并在下次复盘时对 proficiency 增长最快的技能沉淀最佳实践。",
      evidence: `近7天反馈记录 ${digest.feedback.length} 组（员工×技能），未检出低分聚集`,
    });
  }
  return out.slice(0, 8);
}

interface LlmProposal {
  target_type?: string;
  target_key?: string;
  title?: string;
  content?: string;
  evidence?: string;
}

/** 从 LLM 文本中解析提案 JSON 数组（容错截取首个 [...] 片段） */
function parseProposals(text: string): LlmProposal[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? (parsed as LlmProposal[]) : [];
  } catch {
    return [];
  }
}

const TARGET_TYPES = new Set(["skill", "agent", "knowledge", "ops"]);

/** 迭代59/62 共用：已 applied 技能提案的前后窗口采纳率对比（观察期诚实标注） */
async function loadAppliedImpacts() {
  const props = await stRows(
    sql`SELECT id, target_key, applied_at FROM st_evo_proposals
        WHERE status = 'applied' AND target_type = 'skill' AND applied_at IS NOT NULL
        ORDER BY id DESC LIMIT 50`,
  );
  const items = [];
  for (const p of props) {
    const appliedAt = new Date(String(p.applied_at));
    if (Number.isNaN(appliedAt.getTime())) continue;
    const skillKey = String(p.target_key);
    // mysql2 日期拼回 SQL 前统一转 'YYYY-MM-DD HH:mm:ss'
    const pad = (n: number) => String(n).padStart(2, "0");
    const appliedSql = `${appliedAt.getFullYear()}-${pad(appliedAt.getMonth() + 1)}-${pad(appliedAt.getDate())} ${pad(appliedAt.getHours())}:${pad(appliedAt.getMinutes())}:${pad(appliedAt.getSeconds())}`;
    const rows = await stRows(
      sql`SELECT
            SUM(CASE WHEN f.created_at < ${appliedSql} AND f.created_at >= DATE_SUB(${appliedSql}, INTERVAL 7 DAY) AND f.fb_signal = 'adopted' THEN 1 ELSE 0 END) AS bA,
            SUM(CASE WHEN f.created_at < ${appliedSql} AND f.created_at >= DATE_SUB(${appliedSql}, INTERVAL 7 DAY) AND f.fb_signal = 'rejected' THEN 1 ELSE 0 END) AS bR,
            SUM(CASE WHEN f.created_at >= ${appliedSql} AND f.fb_signal = 'adopted' THEN 1 ELSE 0 END) AS aA,
            SUM(CASE WHEN f.created_at >= ${appliedSql} AND f.fb_signal = 'rejected' THEN 1 ELSE 0 END) AS aR
          FROM st_artifact_feedback f
          JOIN st_agent_artifacts a ON a.id = f.artifact_id
          WHERE a.skillKey = ${skillKey}`,
    );
    const r = rows[0] ?? {};
    const bA = Number(r.bA ?? 0), bR = Number(r.bR ?? 0);
    const aA = Number(r.aA ?? 0), aR = Number(r.aR ?? 0);
    const daysAfter = Math.max(0, Math.floor((Date.now() - appliedAt.getTime()) / 86_400_000));
    const rate = (a: number, rr: number) => (a + rr > 0 ? Math.round((a / (a + rr)) * 100) : null);
    const beforeRate = rate(bA, bR);
    const afterRate = rate(aA, aR);
    let verdict: "观察期" | "暂无反馈" | "改善" | "持平" | "恶化";
    if (daysAfter < 7) verdict = "观察期";
    else if (aA + aR === 0) verdict = "暂无反馈";
    else if (beforeRate === null || afterRate === null) verdict = "暂无反馈";
    else if (afterRate - beforeRate > 10) verdict = "改善";
    else if (afterRate - beforeRate < -10) verdict = "恶化";
    else verdict = "持平";
    items.push({
      proposalId: Number(p.id),
      skillKey,
      appliedAt,
      before: { adopted: bA, rejected: bR, adoptRate: beforeRate },
      after: { adopted: aA, rejected: aR, adoptRate: afterRate, days: daysAfter, fullWindow: daysAfter >= 7 },
      verdict,
    });
  }
  return items;
}

/** 迭代64：进化链 LLM 调用事件落库（fire-and-forget，表不存在/写失败均静默） */
function recordLlmEvent(context: string, slot: string, ok: boolean, fallback: boolean, latencyMs: number): void {
  void getDb()
    .execute(
      sql`INSERT INTO st_llm_events (context, slot, ok, fallback, latency_ms)
          VALUES (${context.slice(0, 32)}, ${slot.slice(0, 16)}, ${ok ? 1 : 0}, ${fallback ? 1 : 0}, ${Math.max(0, Math.round(latencyMs))})`,
    )
    .catch((e) => { noteSilent("evo.llmEvent.write", e); });
}

/** 迭代63 抽核：周报生成（brain 槽写中文周报，失败回退规则模板；week 唯一覆盖） */
export async function runWeeklyReport(week: string): Promise<{ week: string }> {
  const [digest, proposalRows, orderRows, factoryRows, callRows] = await Promise.all([
    collectWeeklyDigest(),
    stRows(
      sql`SELECT status, COUNT(*) AS c FROM st_evo_proposals WHERE week = ${week} GROUP BY status`,
    ),
    stRows(sql`SELECT COUNT(*) AS c FROM pkg_orders WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`),
    stRows(sql`SELECT COUNT(*) AS c FROM wb_factories`),
    stRows(sql`SELECT COUNT(*) AS c FROM ops_access_log WHERE ts >= DATE_SUB(NOW(), INTERVAL 7 DAY)`),
  ]);
  const feedbackTotals = digest.feedback.reduce<{ useful: number; useless: number; rework: number }>(
    (acc, f) => ({
      useful: acc.useful + Number(f.useful ?? 0),
      useless: acc.useless + Number(f.useless ?? 0),
      rework: acc.rework + Number(f.rework ?? 0),
    }),
    { useful: 0, useless: 0, rework: 0 },
  );
  const stats = {
    week,
    feedback: feedbackTotals,
    feedbackGroups: digest.feedback.length,
    proposals: Object.fromEntries(proposalRows.map((r) => [String(r.status), Number(r.c ?? 0)])),
    orders7d: Number(orderRows[0]?.c ?? 0),
    factories: Number(factoryRows[0]?.c ?? 0),
    apiCalls7d: Number(callRows[0]?.c ?? 0),
    alertsWeek: digest.alertsWeek,
    alertsOpen: digest.alertsOpen,
    csSessionsWeek: digest.csSessionsWeek,
    skills: digest.skills,
    mounts: digest.mounts,
    llm: null as null | { total: number; fallbacks: number; byContext: { context: string; total: number; fallbacks: number }[] },
  };
  // 迭代68·周报自我可观测：近7天进化链 LLM 调用/兜底纳入 stats 与撰写素材；表缺失静默
  try {
    const llmRows = await stRows(
      sql`SELECT context, COUNT(*) AS total, SUM(fallback) AS fb
          FROM st_llm_events
          WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
          GROUP BY context`,
    );
    const byContext = llmRows.map((r) => ({
      context: String(r.context),
      total: Number(r.total ?? 0),
      fallbacks: Number(r.fb ?? 0),
    }));
    stats.llm = {
      total: byContext.reduce((a, x) => a + x.total, 0),
      fallbacks: byContext.reduce((a, x) => a + x.fallbacks, 0),
      byContext,
    };
  } catch { /* st_llm_events 未建时静默缺省 */ }
  const statsDigest =
    `反馈：有用 ${stats.feedback.useful} / 没用 ${stats.feedback.useless} / 返工 ${stats.feedback.rework}（${stats.feedbackGroups} 组员工×技能）；` +
    `提案：${JSON.stringify(stats.proposals)}；近7天套餐订单 ${stats.orders7d}，入驻企业累计 ${stats.factories}，` +
    `API 调用 ${stats.apiCalls7d} 次；运维预警本周 ${stats.alertsWeek}（未关闭 ${stats.alertsOpen}），客服会话 ${stats.csSessionsWeek} 个。` +
    (stats.llm
      ? `进化链 LLM 调用 ${stats.llm.total} 次（兜底 ${stats.llm.fallbacks} 次${stats.llm.total > 0 ? `，兜底率 ${Math.round((stats.llm.fallbacks / stats.llm.total) * 100)}%` : ""}）。`
      : "");
  let content = "";
  const t0 = Date.now();
  try {
    const res = await callSlotChat("brain", {
      messages: [
        {
          role: "system",
          content:
            "你是 NumX Max 平台的首席运营官，以管理语气撰写「数字员工自进化周报」。" +
            "结构：①本周概览（一句话判断）；②技能反馈分析（亮点与问题）；③进化提案执行情况；④运营与风险；⑤下周建议（分点可执行）。" +
            "务实、有判断、不编造数据，不超过 600 字。",
        },
        { role: "user", content: `周期：${week}\n${statsDigest}` },
      ],
      maxTokens: 1500,
      timeoutMs: 90_000,
    });
    if (res.ok && res.content) {
      content = res.content;
      recordLlmEvent("weekly_report", "brain", true, false, Date.now() - t0);
    } else {
      recordLlmEvent("weekly_report", "brain", false, true, Date.now() - t0);
    }
  } catch {
    recordLlmEvent("weekly_report", "brain", false, true, Date.now() - t0);
    // 静默回退规则模板
  }
  if (!content) {
    content = [
      `【数字员工自进化周报（规则生成）】${week}`,
      `一、本周概览：技能反馈 ${stats.feedback.useful + stats.feedback.useless + stats.feedback.rework} 条（有用 ${stats.feedback.useful}、没用 ${stats.feedback.useless}、返工 ${stats.feedback.rework}），进化提案 ${JSON.stringify(stats.proposals)}。`,
      `二、技能反馈分析：覆盖 ${stats.feedbackGroups} 组员工×技能；技能库 ${stats.skills} 个技能、启用挂载 ${stats.mounts} 处。`,
      `三、运营与风险：近7天套餐订单 ${stats.orders7d}、API 调用 ${stats.apiCalls7d} 次；运维预警本周 ${stats.alertsWeek} 条（未关闭 ${stats.alertsOpen}），客服会话 ${stats.csSessionsWeek} 个。` +
        (stats.llm ? `进化链 LLM 调用 ${stats.llm.total} 次（兜底 ${stats.llm.fallbacks} 次）。` : ""),
      `四、下周建议：优先处理未关闭预警与返工聚集技能；推进 pending 提案审批；对高 proficiency 技能沉淀最佳实践。`,
    ].join("\n");
  }
  await getDb().execute(
    sql`INSERT INTO st_evo_reports (week, content, stats)
        VALUES (${week}, ${content}, ${JSON.stringify(stats)})
        ON DUPLICATE KEY UPDATE content = VALUES(content), stats = VALUES(stats)`,
  );
  return { week };
}

/** 迭代63 抽核+收紧：差评技能草拟（7 天内已有该技能提案<任何状态>即跳过，防观察期重复打扰） */
export async function runAutoDraftBadSkills(): Promise<{ generated: number; skipped: number; items: string[] }> {
  const eff = await getSkillEffectiveness();
  const bad = [...eff.entries()]
    .map(([skillKey, e]) => ({ skillKey, ...e, net: e.adopted - e.rejected }))
    .filter((x) => x.net <= -3 && x.adopted + x.rejected >= 3);
  if (bad.length === 0) return { generated: 0, skipped: 0, items: [] };
  const recentRows = await stRows(
    sql`SELECT target_key FROM st_evo_proposals
        WHERE target_type = 'skill' AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
  );
  const recentKeys = new Set(recentRows.map((r) => String(r.target_key)));
  const week = isoWeek();
  const db = getDb();
  let generated = 0;
  let skipped = 0;
  const items: string[] = [];
  for (const b of bad) {
    if (recentKeys.has(b.skillKey)) { skipped += 1; continue; }
    const title = `优化差评技能「${b.skillKey}」的产出质量`.slice(0, 128);
    const evidence = `产出物反馈：采纳 ${b.adopted} / 驳回 ${b.rejected}（净 ${b.net}，样本 ${b.adopted + b.rejected}），累计使用 ${b.uses} 次`;
    const template =
      `该技能在真实使用中净采纳为 ${b.net}（采纳 ${b.adopted}、驳回 ${b.rejected}），已达差评阈值。` +
      `建议复核其 trigger_hints 与输出模板，补强质量检查清单；批准后 st_agent_skills.revisions+1 留痕。`;
    let content = template;
    let source = "auto";
    const t0 = Date.now();
    try {
      const r = await callSlotChat("flash", {
        messages: [
          { role: "system", content: "你是进化提案撰写助手。基于给定的技能差评数据，写一段≤120字的改进建议，务实、具体、面向审批人。只输出正文。" },
          { role: "user", content: `技能：${b.skillKey}\n${evidence}` },
        ],
        maxTokens: 300,
        temperature: 0.3,
        timeoutMs: 30_000,
      });
      if (r.ok && r.content && r.content.trim().length >= 20) {
        content = r.content.trim().slice(0, 500);
        source = "llm";
        recordLlmEvent("auto_draft", "flash", true, false, Date.now() - t0);
      } else {
        recordLlmEvent("auto_draft", "flash", false, true, Date.now() - t0);
      }
    } catch {
      recordLlmEvent("auto_draft", "flash", false, true, Date.now() - t0);
      /* 静默降级模板 */
    }
    await db.execute(
      sql`INSERT INTO st_evo_proposals
          (week, target_type, target_key, title, content, evidence, status, \`source\`)
          VALUES (${week}, 'skill', ${b.skillKey}, ${title}, ${content}, ${evidence}, 'pending', ${source})`,
    );
    generated += 1;
    items.push(b.skillKey);
  }
  return { generated, skipped, items };
}

/** 迭代63：每周自动进化（调度器与 weeklyAutoRunNow 同路径）——
 *  同周幂等（审计标记 evo.weeklyAuto），跑周报 + 差评扫描，审计留痕。 */
export async function weeklyAutoRun(actorName: string): Promise<{ week: string; ran: boolean; report: boolean; drafts: { generated: number; skipped: number; items: string[] }; alert?: string }> {
  const week = isoWeek();
  const marker = await stRows(
    sql`SELECT id FROM st_admin_audit WHERE action = 'evo.weeklyAuto' AND target = ${week} LIMIT 1`,
  );
  if (marker.length > 0) {
    return { week, ran: false, report: false, drafts: { generated: 0, skipped: 0, items: [] } };
  }
  // 先落标记再执行：并发/重启窗口宁可跳过也不双跑
  writeAdminAudit(0, actorName, "evo.weeklyAuto", week, { phase: "start" });
  try {
    await runWeeklyReport(week);
    const drafts = await runAutoDraftBadSkills();
    const alert = await checkLlmFallbackAlert(week);
    // 迭代73·成功自愈：关闭此前「每周进化失败」同键 open 预警
    try {
      await getDb().execute(
        sql`UPDATE ops_alerts SET status = 'resolved', resolved_at = NOW()
            WHERE dedup_key = 'evo-weekly-fail' AND status IN ('open','ack')`,
      );
    } catch { /* 静默 */ }
    writeAdminAudit(0, actorName, "evo.weeklyAutoDone", week, { drafts, alert });
    return { week, ran: true, report: true, drafts, alert };
  } catch (err) {
    // 迭代73·失败可告警可重试：删开始标记（下小时 tick 重试）+ ops_alerts + 审计，错误上抛
    const msg = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
    try {
      await getDb().execute(
        sql`DELETE FROM st_admin_audit WHERE \`action\` = 'evo.weeklyAuto' AND target = ${week}`,
      );
      const openRows = await stRows(
        sql`SELECT id FROM ops_alerts WHERE dedup_key = 'evo-weekly-fail' AND status IN ('open','ack') LIMIT 1`,
      );
      if (openRows.length === 0) {
        await getDb().execute(
          sql`INSERT INTO ops_alerts (server, severity, title, detail, status, dedup_key)
              VALUES ('s1', 'high', '每周自动进化执行失败',
                      ${`${week} 执行失败：${msg}。开始标记已清除，下一小时 tick 将自动重试；连续失败请检查 brain 槽位与数据库。`},
                      'open', 'evo-weekly-fail')`,
        );
      }
    } catch { /* 告警失败静默，不影响上抛 */ }
    writeAdminAudit(0, actorName, "evo.weeklyAutoFail", week, { error: msg });
    throw err;
  }
}

/** 迭代70：进化链兜底率超阈值自动预警——近7天 total≥3 且 >30% 写 ops_alerts（dedup_key 去重），
 *  回落 ≤30% 自动关闭同键 open 预警；任何异常静默不影响主流程。 */
async function checkLlmFallbackAlert(week: string): Promise<string> {
  const DEDUP = "evo-llm-fallback";
  try {
    const rows = await stRows(
      sql`SELECT COUNT(*) AS total, COALESCE(SUM(fallback), 0) AS fb
          FROM st_llm_events WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
    );
    const total = Number(rows[0]?.total ?? 0);
    const fb = Number(rows[0]?.fb ?? 0);
    const rate = total > 0 ? fb / total : 0;
    const openRows = await stRows(
      sql`SELECT id FROM ops_alerts WHERE dedup_key = ${DEDUP} AND status IN ('open','ack') LIMIT 1`,
    );
    if (total >= 3 && rate > 0.3) {
      if (openRows.length > 0) return "skipped-open";
      await getDb().execute(
        sql`INSERT INTO ops_alerts (server, severity, title, detail, status, dedup_key)
            VALUES ('s1', 'warning', '进化链 LLM 兜底率超阈值',
                    ${`近7天进化链调用 ${total} 次、兜底 ${fb} 次（${Math.round(rate * 100)}%）> 30% 阈值（${week}）。请检查 brain/flash 槽位可用性与密钥额度。`},
                    'open', ${DEDUP})`,
      );
      return "raised";
    }
    if (openRows.length > 0) {
      await getDb().execute(
        sql`UPDATE ops_alerts SET status = 'resolved', resolved_at = NOW() WHERE dedup_key = ${DEDUP} AND status IN ('open','ack')`,
      );
      return "resolved";
    }
    return "ok";
  } catch {
    return "error-silent";
  }
}

export const evoRouter = createRouter({
  /** feedback（mutation，双轨）：写入反馈信号；useful → proficiency+1；skill 不存在 → 404 */
  feedback: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        agentId: z.number().int().positive(),
        skillKey: z.string().trim().min(1).max(64),
        factoryId: z.number().int().positive().optional(),
        signal: z.enum(["useful", "useless", "rework"]),
        note: z.string().trim().max(255).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const actor = await feedbackActor(input.token, input.factoryId);
      const db = getDb();
      // 技能定位：精确命中优先；'general' 或未命中 → 回退该员工已挂载的第一个 general 层技能；
      // 员工无任何挂载 → 兜底记录到 doc_write（存在时）。保证前端简化调用不 404。
      let skillKey = input.skillKey;
      let skillRows = await stRows(
        sql`SELECT skill_key FROM st_skills WHERE skill_key = ${skillKey} LIMIT 1`,
      );
      if (skillRows.length === 0) {
        const fallback = await stRows(
          sql`SELECT m.skill_key FROM st_agent_skills m
              JOIN st_skills s ON s.skill_key = m.skill_key
              WHERE m.agent_id = ${input.agentId} AND m.enabled = 1 AND s.layer = 'general'
              ORDER BY m.id LIMIT 1`,
        );
        if (fallback.length > 0) {
          skillKey = String(fallback[0].skill_key);
          skillRows = fallback;
        } else {
          const docWrite = await stRows(
            sql`SELECT skill_key FROM st_skills WHERE skill_key = 'doc_write' LIMIT 1`,
          );
          if (docWrite.length > 0) {
            skillKey = "doc_write";
            skillRows = docWrite;
          }
        }
      }
      if (skillRows.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "技能不存在" });
      }
      await db.execute(
        sql`INSERT INTO st_skill_feedback (agent_id, skill_key, factory_id, \`signal\`, note)
            VALUES (${input.agentId}, ${skillKey}, ${actor.factoryId}, ${input.signal}, ${input.note ?? null})`,
      );
      if (input.signal === "useful") {
        await db.execute(
          sql`UPDATE st_agent_skills SET proficiency = proficiency + 1
              WHERE agent_id = ${input.agentId} AND skill_key = ${skillKey}`,
        );
      }
      return { ok: true as const, actor: actor.kind, factoryId: actor.factoryId, skillKey };
    }),

  /** feedbackSummary（query，admin）：近 N 天按员工×技能聚合信号 */
  feedbackSummary: publicQuery
    .input(tokenInput.extend({ days: z.number().int().min(1).max(90).optional().default(7) }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const days = input.days ?? 7;
      const rows = await stRows(
        sql`SELECT f.agent_id, a.name AS agent_name, f.skill_key, s.name AS skill_name,
                   SUM(f.\`signal\` = 'useful') AS useful,
                   SUM(f.\`signal\` = 'useless') AS useless,
                   SUM(f.\`signal\` = 'rework') AS rework,
                   COUNT(*) AS total,
                   MAX(f.created_at) AS last_at
            FROM st_skill_feedback f
            LEFT JOIN agents a ON a.id = f.agent_id
            LEFT JOIN st_skills s ON s.skill_key = f.skill_key
            WHERE f.created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
            GROUP BY f.agent_id, a.name, f.skill_key, s.name
            ORDER BY total DESC LIMIT 200`,
      );
      return rows.map((r) => ({
        agentId: Number(r.agent_id),
        agentName: r.agent_name == null ? null : String(r.agent_name),
        skillKey: String(r.skill_key),
        skillName: r.skill_name == null ? String(r.skill_key) : String(r.skill_name),
        useful: Number(r.useful ?? 0),
        useless: Number(r.useless ?? 0),
        rework: Number(r.rework ?? 0),
        total: Number(r.total ?? 0),
        lastAt: r.last_at ? new Date(String(r.last_at)) : null,
      }));
    }),

  /** runWeeklyReview（mutation，admin）：复盘引擎 → brain 槽生成 3-8 条提案，失败规则兜底 */
  runWeeklyReview: publicQuery
    .input(tokenInput.extend({ week: z.string().trim().regex(/^\d{4}W\d{2}$/).optional() }))
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const week = input.week ?? isoWeek();
      const digest = await collectWeeklyDigest();
      const feedbackDigest = digest.feedback.length
        ? digest.feedback
            .slice(0, 20)
            .map(
              (f) =>
                `员工#${Number(f.agent_id)} 技能 ${String(f.skill_key)}：有用${Number(f.useful ?? 0)}/没用${Number(f.useless ?? 0)}/返工${Number(f.rework ?? 0)}`,
            )
            .join("\n")
        : "近7天无技能反馈记录";
      let proposals: LlmProposal[] = [];
      try {
        const res = await callSlotChat("brain", {
          messages: [
            {
              role: "system",
              content:
                "你是 NumX Max 平台的自进化引擎。根据近7天数字员工技能反馈与运维数据，生成 3-8 条进化提案。" +
                "严格输出 JSON 数组，每项含 target_type（skill/agent/knowledge/ops）、target_key、title、content、evidence 五个字段；" +
                "proposal 必须基于数据证据，content 给出可执行的改进步骤。只输出 JSON，不要其他文字。",
            },
            {
              role: "user",
              content:
                `周期：${week}\n技能反馈（近7天）：\n${feedbackDigest}\n` +
                `运维预警：本周新增 ${digest.alertsWeek} 条，未关闭 ${digest.alertsOpen} 条；` +
                `客服会话（近7天）：${digest.csSessionsWeek} 个；` +
                `技能库：${digest.skills} 个技能，启用挂载 ${digest.mounts} 处。`,
            },
          ],
          maxTokens: 2500,
          timeoutMs: 90_000,
        });
        if (res.ok && res.content) proposals = parseProposals(res.content);
      } catch (e) {
        // 静默回退规则模板（A3：打点观测，周报照常产出）
        noteSilent("evo.weeklyReport.brain", e);
      }
      let normalized = proposals
        .filter((p) => p && typeof p.title === "string" && p.title.trim())
        .map((p) => ({
          target_type: TARGET_TYPES.has(String(p.target_type)) ? String(p.target_type) : "skill",
          target_key: String(p.target_key ?? "").slice(0, 64),
          title: String(p.title).slice(0, 128),
          content: String(p.content ?? ""),
          evidence: String(p.evidence ?? ""),
        }))
        .slice(0, 8);
      if (normalized.length === 0) normalized = fallbackProposals(digest);
      const db = getDb();
      let generated = 0;
      for (const p of normalized) {
        await db.execute(
          sql`INSERT INTO st_evo_proposals (week, target_type, target_key, title, content, evidence, status)
              VALUES (${week}, ${p.target_type}, ${p.target_key}, ${p.title}, ${p.content}, ${p.evidence}, 'pending')`,
        );
        generated += 1;
      }
      writeAdminAudit(Number(admin.id), adminDisplayName(admin), "evo.runWeeklyReview", week, { generated });
      return { week, generated };
    }),

  /** proposals（query，admin）：提案列表，可按 status/week 过滤 */
  proposals: publicQuery
    .input(
      tokenInput.extend({
        status: z.enum(["pending", "approved", "rejected", "applied"]).optional(),
        week: z.string().trim().max(8).optional(),
      }),
    )
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const rows = await stRows(
        sql`SELECT id, week, target_type, target_key, title, content, evidence, status,
                   decided_by, decided_at, applied_at, created_at
            FROM st_evo_proposals
            WHERE 1=1
            ${input.status ? sql`AND status = ${input.status}` : sql``}
            ${input.week ? sql`AND week = ${input.week}` : sql``}
            ORDER BY id DESC LIMIT 200`,
      );
      const toDate = (v: unknown) => (v ? new Date(String(v)) : null);
      return rows.map((r) => ({
        id: Number(r.id),
        week: String(r.week),
        targetType: String(r.target_type),
        targetKey: String(r.target_key ?? ""),
        title: String(r.title ?? ""),
        content: r.content == null ? "" : String(r.content),
        evidence: r.evidence == null ? "" : String(r.evidence),
        status: String(r.status),
        decidedBy: r.decided_by == null ? null : String(r.decided_by),
        decidedAt: toDate(r.decided_at),
        appliedAt: toDate(r.applied_at),
        createdAt: toDate(r.created_at),
      }));
    }),

  /** decide（mutation，admin）：审批提案；approved+skill → revisions+1 且直接 applied */
  decide: publicQuery
    .input(
      tokenInput.extend({
        id: z.number().int().positive(),
        action: z.enum(["approved", "rejected"]),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const db = getDb();
      const rows = await stRows(
        sql`SELECT id, target_type, target_key, status FROM st_evo_proposals WHERE id = ${input.id} LIMIT 1`,
      );
      const proposal = rows[0];
      if (!proposal) {
        throw new TRPCError({ code: "NOT_FOUND", message: "提案不存在" });
      }
      if (String(proposal.status) !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "提案已处理，不可重复审批" });
      }
      const decidedBy = String(admin.username ?? "admin");
      const applyNow = input.action === "approved" && String(proposal.target_type) === "skill";
      await db.execute(
        sql`UPDATE st_evo_proposals
            SET status = ${applyNow ? "applied" : input.action},
                decided_by = ${decidedBy}, decided_at = NOW()
                ${applyNow ? sql`, applied_at = NOW()` : sql``}
            WHERE id = ${input.id}`,
      );
      if (applyNow) {
        await db.execute(
          sql`UPDATE st_agent_skills SET revisions = revisions + 1 WHERE skill_key = ${String(proposal.target_key)}`,
        );
        // M38 自进化闭环：提案指向【新技能】（st_skills 无此 key）→ 批准即落生技能行
        // （layer='evo'），经 loadVisibleSkills 进化段全厂可见、MCP 工具面自动出现——
        // 进化产出即插件，评审（decide）即闸口，挂载零人工。
        const targetKey = String(proposal.target_key);
        const exists = await stRows(sql`SELECT id FROM st_skills WHERE skill_key = ${targetKey} LIMIT 1`);
        if (exists.length === 0 && /^[a-z][a-z0-9_]{2,48}$/.test(targetKey)) {
          const titleRows = await stRows(sql`SELECT title, content FROM st_evo_proposals WHERE id = ${input.id} LIMIT 1`);
          const t = titleRows[0];
          await db.execute(
            sql`INSERT INTO st_skills (skill_key, name, layer, category, description, executor, executor_kind, status, created_at)
                VALUES (${targetKey}, ${String(t?.title ?? targetKey).slice(0, 64)}, 'evo', 'evolution',
                        ${String(t?.content ?? "").slice(0, 500)}, 'llm_analysis', 'generic', 'active', NOW())`,
          );
        }
      }
      writeAdminAudit(Number(admin.id), adminDisplayName(admin), "evo.decide", String(input.id), {
        action: input.action,
        result: applyNow ? "applied" : input.action,
        targetType: String(proposal.target_type),
        targetKey: String(proposal.target_key),
      });
      return { ok: true as const, status: applyNow ? ("applied" as const) : input.action };
    }),

  /** autoDraftBadSkills（mutation，admin）：迭代58 闭环收紧——
   *  平台级产出物反馈净采纳 ≤-3 且样本 ≥3 的技能自动草拟进化提案（pending），
   *  复用 proposals/decide 审批链；LLM 仅增强 content（source 列如实标注）；
   *  幂等：同 skill_key 已有 pending 即跳过。 */
  autoDraftBadSkills: publicQuery
    .input(tokenInput)
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const r = await runAutoDraftBadSkills();
      writeAdminAudit(Number(admin.id), adminDisplayName(admin), "evo.autoDraftBadSkills", isoWeek(), r);
      return r;
    }),

  /** proposalImpact（query，admin）：迭代59 效果回看——
   *  已 applied 的技能提案，应用前 7 天 vs 应用后至今的采纳率对比；观察期不足 7 天诚实标注。 */
  proposalImpact: publicQuery
    .input(tokenInput)
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      return { items: await loadAppliedImpacts() };
    }),

  /** cockpit（query，admin）：迭代62 进化驾驶舱——闭环四段+记忆规模一屏聚合（只读）。 */
  cockpit: publicQuery
    .input(tokenInput)
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      // ① 反馈趋势：近 14 天逐日采纳/驳回
      const trendRows = await stRows(
        sql`SELECT DATE(created_at) AS d,
              SUM(fb_signal = 'adopted') AS adopted,
              SUM(fb_signal = 'rejected') AS rejected
            FROM st_artifact_feedback
            WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
            GROUP BY DATE(created_at) ORDER BY d`,
      );
      // ② 在途提案
      const pendingRows = await stRows(
        sql`SELECT id, title, target_key, created_at FROM st_evo_proposals
            WHERE status = 'pending' ORDER BY id DESC LIMIT 5`,
      );
      const pendingCountRows = await stRows(
        sql`SELECT COUNT(*) AS c FROM st_evo_proposals WHERE status = 'pending'`,
      );
      // ③ 应用效果（复用效果回看逻辑）
      const impacts = await loadAppliedImpacts();
      const verdicts: Record<string, number> = {};
      for (const im of impacts) verdicts[im.verdict] = (verdicts[im.verdict] ?? 0) + 1;
      // ④ 技能健康榜（样本≥1 反馈才参与采纳率排名）
      const eff = await getSkillEffectiveness();
      const ranked = [...eff.entries()]
        .map(([skillKey, e]) => ({
          skillKey,
          ...e,
          adoptRate: e.adopted + e.rejected > 0 ? Math.round((e.adopted / (e.adopted + e.rejected)) * 100) : null,
        }))
        .filter((x) => x.adoptRate !== null)
        .sort((a, b) => (b.adoptRate ?? 0) - (a.adoptRate ?? 0));
      // ⑤ 记忆规模
      const memRows = await stRows(
        sql`SELECT COUNT(*) AS total, COUNT(DISTINCT agent_code) AS agents, COUNT(DISTINCT actor) AS actors
            FROM st_agent_memories`,
      );
      const m = memRows[0] ?? {};
      // ⑥ LLM 兜底率（迭代64）：近14天进化链调用；表不存在时静默缺省
      let llmHealth: {
        total: number; fallbacks: number; fallbackRate: number | null;
        byContext: { context: string; total: number; fallbacks: number; avgLatencyMs: number }[];
      } = { total: 0, fallbacks: 0, fallbackRate: null, byContext: [] };
      try {
        const evRows = await stRows(
          sql`SELECT context, COUNT(*) AS total, SUM(fallback) AS fb, AVG(latency_ms) AS avg_lat
              FROM st_llm_events
              WHERE created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)
              GROUP BY context`,
        );
        const byContext = evRows.map((r) => ({
          context: String(r.context),
          total: Number(r.total ?? 0),
          fallbacks: Number(r.fb ?? 0),
          avgLatencyMs: Math.round(Number(r.avg_lat ?? 0)),
        }));
        const total = byContext.reduce((a, x) => a + x.total, 0);
        const fallbacks = byContext.reduce((a, x) => a + x.fallbacks, 0);
        llmHealth = { total, fallbacks, fallbackRate: total > 0 ? Math.round((fallbacks / total) * 100) : null, byContext };
      } catch { /* 表未建时静默 */ }
      return {
        feedbackTrend: trendRows.map((r) => ({
          date: String(r.d).slice(0, 10),
          adopted: Number(r.adopted ?? 0),
          rejected: Number(r.rejected ?? 0),
        })),
        pendingProposals: {
          count: Number(pendingCountRows[0]?.c ?? 0),
          latest: pendingRows.map((r) => ({
            id: Number(r.id),
            title: String(r.title ?? ""),
            targetKey: String(r.target_key ?? ""),
          })),
        },
        impactVerdicts: { total: impacts.length, ...verdicts },
        skillHealth: {
          top: ranked.slice(0, 3),
          bottom: ranked.length > 3 ? ranked.slice(-3).reverse() : [],
        },
        memory: {
          total: Number(m.total ?? 0),
          agents: Number(m.agents ?? 0),
          actors: Number(m.actors ?? 0),
        },
        llmHealth,
      };
    }),

  /** generateReport（mutation，admin）：kimi-k3 写中文周报，week 唯一覆盖重生成 */
  generateReport: publicQuery
    .input(tokenInput.extend({ week: z.string().trim().regex(/^\d{4}W\d{2}$/).optional() }))
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const week = input.week ?? isoWeek();
      await runWeeklyReport(week);
      writeAdminAudit(Number(admin.id), adminDisplayName(admin), "evo.generateReport", week, null);
      return { week };
    }),

  /** weeklyAutoRunNow（mutation，admin）：迭代63 手动触发每周自动进化（与调度器同一代码路径） */
  weeklyAutoRunNow: publicQuery
    .input(tokenInput)
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      return weeklyAutoRun(adminDisplayName(admin));
    }),

  /** reports（query，admin）：周报历史列表（含全文） */
  reports: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const rows = await stRows(
      sql`SELECT id, week, content, stats, created_at, updated_at FROM st_evo_reports ORDER BY week DESC LIMIT 52`,
    );
    return rows.map((r) => ({
      id: Number(r.id),
      week: String(r.week),
      content: r.content == null ? "" : String(r.content),
      stats: (() => {
        if (typeof r.stats !== "string") return r.stats ?? null;
        try {
          return JSON.parse(r.stats) as unknown;
        } catch (e) { /* 历史脏行：stats 置空不阻断周报 */
          noteSilent("evo.report.stats.parse", e);
          return null;
        }
      })(),
      createdAt: r.created_at ? new Date(String(r.created_at)) : null,
      updatedAt: r.updated_at ? new Date(String(r.updated_at)) : null,
    }));
  }),

  /** latestReport（query，admin）：最新一期周报 */
  latestReport: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const rows = await stRows(
      sql`SELECT id, week, content, stats, created_at FROM st_evo_reports ORDER BY week DESC LIMIT 1`,
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: Number(r.id),
      week: String(r.week),
      content: r.content == null ? "" : String(r.content),
      stats: (() => {
        if (typeof r.stats !== "string") return r.stats ?? null;
        try {
          return JSON.parse(r.stats) as unknown;
        } catch (e) { /* 历史脏行：stats 置空不阻断周报 */
          noteSilent("evo.report.stats.parse", e);
          return null;
        }
      })(),
      createdAt: r.created_at ? new Date(String(r.created_at)) : null,
    };
  }),
});
