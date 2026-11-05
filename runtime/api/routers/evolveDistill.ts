/**
 * evolveDistill —— 三师经验蒸馏（2026-09-05 彭总立项；当日定稿：三师改三师）。
 *
 * 三师：DeepSeek / Kimi / GLM（全部国产、全部开源权重、权重级微调许可齐）。
 * 美厂两家（OpenAI/Anthropic）与编外 MiniMax 已下牌桌——名册收缩，合规面更干净。
 * 口径铁律：真实战场题 → 三师同考 → 交叉互评（禁自评）→ 养料进库。
 *
 * 循环：每周日 05:10（错开双脑日报）或手工 distillRun——
 *  ① 出题：st_evolve_inbox 未消化信号 + 近 7 天 crash/api_error 高频项
 *  ② 同考：每位有钥匙的老师答同一题（诚实标注 unavailable，绝不装答）
 *  ③ 互评：教师交叉评分（禁自评），均分最高卷进 st_evolve_lessons（source_model 记录出处）
 *  ④ 钥匙/余额断供 → 该师标 key_missing/balance_low，状态页如实公示
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";
import { isEvolveKey } from "./evolveAudit";

// ─── 三师名册（钥匙读 env，零硬编码；状态实测才知道） ────────────────
interface Teacher {
  code: string;
  vendor: string;
  model: string;
  baseUrl: string;
  keyEnv: string;        // 直连 key 的环境变量名
  gatewayModel?: string; // 海禛云网关里的型号名（有则双通道）
  weightLicensed: boolean; // 权重级许可（开源权重）
  temperature?: number;  // 个别模型锁定温度（kimi-k3 只允许 1）
  fallbackModel?: string; // 旗舰欠费时直连降级型号（如实标注 via）
}

export const TEACHERS: Teacher[] = [
  { code: "deepseek", vendor: "DeepSeek（中国）", model: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com/v1", keyEnv: "DISTILL_KEY_DEEPSEEK", gatewayModel: "deepseek-v4-pro", weightLicensed: true },
  { code: "kimi", vendor: "Kimi 月之暗面（中国）", model: "kimi-k3", baseUrl: "https://api.moonshot.cn/v1", keyEnv: "DISTILL_KEY_KIMI", gatewayModel: "kimi-k3", weightLicensed: true, temperature: 1 },
  { code: "glm", vendor: "GLM 智谱（中国）", model: "glm-5.3", baseUrl: "https://open.bigmodel.cn/api/paas/v4", keyEnv: "DISTILL_KEY_GLM", gatewayModel: "glm-5.2", weightLicensed: true, fallbackModel: "glm-4.5-flash" },
];

const GATEWAY_URL = "https://idoictos.com:3443/v1/chat/completions";

interface TeacherReply { ok: boolean; text?: string; reason?: string; via?: string }

/** 单师答题：直连优先，失败落网关（各 30s 封顶；失败如实回原因） */
export async function askTeacher(t: Teacher, system: string, question: string): Promise<TeacherReply> {
  const key = process.env[t.keyEnv];
  if (key) {
    const r = await callChat(t.baseUrl, key, t.model, system, question, t.temperature).catch((e) => ({ ok: false as const, reason: String(e).slice(0, 120) }));
    if (r.ok) return { ...r, via: "direct" };
    // 旗舰欠费/不可用 → 直连降级型号（诚实标 via=direct:fallback）
    if (t.fallbackModel && (r.reason?.includes("Balance") || r.reason?.includes("余额") || r.reason?.includes("资源包") || r.reason?.includes("not found") || r.reason?.includes("Not found"))) {
      const r2 = await callChat(t.baseUrl, key, t.fallbackModel, system, question, t.temperature).catch((e) => ({ ok: false as const, reason: String(e).slice(0, 120) }));
      if (r2.ok) return { ...r2, via: "direct:" + t.fallbackModel };
      if (r2.reason?.includes("Balance") || r2.reason?.includes("余额")) return { ok: false, reason: "balance_low", via: "direct" };
    }
    if (r.reason?.includes("Balance") || r.reason?.includes("余额")) return { ok: false, reason: "balance_low", via: "direct" };
    // 直连非余额类失败 → 尝试网关
  } else if (!t.gatewayModel) {
    return { ok: false, reason: "key_missing" };
  }
  if (t.gatewayModel && process.env.DISTILL_GATEWAY_KEY) {
    const r = await callChat(GATEWAY_URL, process.env.DISTILL_GATEWAY_KEY, t.gatewayModel, system, question, t.temperature).catch((e) => ({ ok: false as const, reason: String(e).slice(0, 120) }));
    if (r.ok) return { ...r, via: "gateway" };
    return { ok: false, reason: r.reason?.includes("balance") || r.reason?.includes("Balance") ? "balance_low" : (r.reason ?? "gateway_error"), via: "gateway" };
  }
  return { ok: false, reason: key ? "direct_failed" : "key_missing" };
}

async function callChat(baseUrl: string, key: string, model: string, system: string, question: string, temperature = 0.3): Promise<TeacherReply> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  try {
    const url = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: question },
        ],
        max_tokens: 3200,
        temperature,
      }),
      signal: ctl.signal,
    });
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
    if (!res.ok) throw new Error(j.error?.message ?? `http_${res.status}`);
    const text = j.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("reasoning_overflow_or_empty");
    return { ok: true, text: text.slice(0, 1800) };
  } finally {
    clearTimeout(timer);
  }
}

// ─── 出题：从真实战场捞 ──────────────────────────────────────────────
async function pickExamCases(limit = 3): Promise<{ id: number; kind: string; title: string }[]> {
  const db = getDb();
  try {
    const rows = rawRows(
      await db.execute(sql`
        SELECT id, kind, LEFT(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.message')),200) AS title
        FROM st_evo_signals
        WHERE created_at > NOW() - INTERVAL 7 DAY AND kind NOT IN ('boot','distill','spirit_intent') -- P2-6 票①：spirit_intent 是高频流量信号（无 message 字段）——不挤占考题源（spirit_miss/radar_miss 等真失败信号优先）
        ORDER BY id DESC LIMIT ${limit * 3}`),
    ) as { id: number; kind: string; title: string }[];
    // 同 kind 去重取代表
    const seen = new Set<string>();
    const out: { id: number; kind: string; title: string }[] = [];
    for (const r of rows) {
      if (seen.has(r.kind)) continue;
      seen.add(r.kind);
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  } catch { return []; }
}

const EXAM_SYSTEM = "你是 NumX Max 组织智能体系统的三师之一。给定真实系统异常案例，输出经验条目（问题/诊断/方案/验证），务实、可执行、不超过 400 字。";
// v2.9.10 域化考卷（彭总令：精灵与扫一扫一起蒸）
// v2.9.11 全系统蒸馏（彭总令：三师蒸馏必须全系统应用）——各域考题配各域名师人设
const DOMAIN_SYSTEM: Record<string, string> = {
  spirit_miss: "你是精灵教练。用户向手机精灵说了带动作意图的话（打开/控制/连接类），系统却落回了闲聊。输出：①该话的正确意图与动作 ②意图路由规则建议（应命中的正则/关键词）③应答话术改进。务实，不超过 300 字。",
  radar_miss: "你是物联网设备识别专家。手机雷达扫到一台识别不出的设备（给出名称/信道信息），或连不上已知设备。输出：①它最可能是什么设备（类别/品牌推断依据）②指纹规则建议（BLE 厂商 ID/名称关键词/mDNS 服务类型，可 JSON 表达）③连接排障建议。务实，不超过 300 字。",
  voice_fail: "你是语音链路专家。语音识别/播报失败案例。输出：①根因定位路径 ②修复方案 ③预防机制。务实，不超过 300 字。",
  asr_fail: "你是语音链路专家。语音识别失败案例。输出：①根因定位路径 ②修复方案 ③预防机制。务实，不超过 300 字。",
  tts_fail: "你是语音链路专家。语音合成失败案例。输出：①根因定位路径 ②修复方案 ③预防机制。务实，不超过 300 字。",
  skill_fail: "你是数字员工教练。驻舱数字员工技能执行失败案例。输出：①失败根因 ②技能修补方案 ③该员工的考核与降级建议。务实，不超过 300 字。",
  device_fail: "你是物联网运维专家。设备控制/连接失败案例。输出：①根因定位 ②修复与重试策略 ③设备指纹/协议层改进建议。务实，不超过 300 字。",
  dag_fail: "你是工作流引擎专家。DAG 编排任务失败案例。输出：①失败节点定位 ②编排层修复 ③重跑与补偿设计。务实，不超过 300 字。",
  mishear_diff: "你是语音语义专家。听错/理解偏差的案例。输出：①偏差根因 ②纠错机制 ③确认话术设计。务实，不超过 300 字。",
};
function examSystemOf(kind: string): string { return DOMAIN_SYSTEM[kind] ?? EXAM_SYSTEM }
const REVIEW_SYSTEM = "你是评审。给同行答卷打分（0-10）并一句点评。只输出 JSON：{\"score\":8,\"note\":\"...\"}";

// ─── 主流程：一轮蒸馏 ────────────────────────────────────────────────
let runLock = false;

export async function distillRunOnce(actor: string): Promise<{
  ran: boolean; cases: number; lessons: number; teachers: Record<string, string>;
}> {
  if (runLock) return { ran: false, cases: 0, lessons: 0, teachers: { lock: "already_running" } };
  runLock = true;
  const db = getDb();
  const cases = await pickExamCases(3);
  const teacherStatus: Record<string, string> = {};
  let lessons = 0;

  if (cases.length === 0) return { ran: false, cases: 0, lessons: 0, teachers: teacherStatus };

  for (const c of cases) {
    // ① 三师同考
    const answers: { code: string; text: string }[] = [];
    await Promise.all(TEACHERS.map(async (t) => {
      const r = await askTeacher(t, examSystemOf(c.kind), `案例 #${c.id}（${c.kind}）：${c.title}`);
      if (r.ok && r.text) {
        answers.push({ code: t.code, text: r.text });
        teacherStatus[t.code] = `ok(${r.via})`;
      } else {
        teacherStatus[t.code] = r.reason ?? "fail";
      }
    }));
    if (answers.length < 2) continue; // 单师无互评，不入库

    // ② 交叉互评（禁自评）
    let best: { code: string; text: string; score: number } | null = null;
    for (const a of answers) {
      const reviewers = answers.filter((x) => x.code !== a.code);
      let total = 0, n = 0;
      for (const rv of reviewers) {
        const t = TEACHERS.find((x) => x.code === rv.code)!;
        const rr = await askTeacher(t, REVIEW_SYSTEM, `题目：${c.title}\n同行答卷：${a.text}`);
        if (rr.ok && rr.text) {
          const m = rr.text.match(/["']?score["']?\s*[:：]\s*(\d+(?:\.\d+)?)/);
          if (m) { total += Math.min(10, Math.max(0, Number(m[1]))); n++; }
        }
      }
      const avg = n > 0 ? total / n : 0;
      if (!best || avg > best.score) best = { ...a, score: avg };
    }
    // 后训练③偏好对：胜卷 vs 最差卷入 DPO 库（中训练弹药）
    if (best) {
      const worst = answers.find((a) => a.code !== best.code);
      if (worst) {
        const { recordDpoPair } = await import("./evolvePost");
        await recordDpoPair(`${c.kind}#${c.id}`, best.text, worst.text, best.code, worst.code, best.score).catch(() => {});
      }
    }
    if (!best) continue;

    // ③ 养料入库（三师双师口径扩容：source_model 记录出处师+均分）
    try {
      await db.execute(sql`
        INSERT INTO st_evolve_lessons (topic, problem, diagnosis, solution, result, source_model, confidence, created_at)
        VALUES (${`三师蒸馏·${c.kind === "spirit_miss" ? "精灵" : c.kind === "radar_miss" ? "扫一扫" : "系统"}`}, ${`${c.kind} #${c.id}`}, ${c.title}, ${best.text},
                ${`三师同考交叉互评均分 ${best.score.toFixed(1)}（参评 ${answers.length} 师）`},
                ${`distill:${best.code}`}, ${best.score >= 8 ? "high" : best.score >= 6 ? "medium" : "low"}, NOW())`);
      lessons++;
    } catch (e) { console.error("[distill] lesson insert failed:", String(e).slice(0, 120)); }
  }

  // ④ 蒸馏轮次留痕（超终可见）
  try {
    await db.execute(sql`
      INSERT INTO st_evo_signals (factory_id, kind, actor, payload)
      VALUES (NULL, 'distill', ${actor}, ${JSON.stringify({ cases: cases.length, lessons, teachers: teacherStatus }).slice(0, 1800)})`);
  } catch { /* 静默 */ }

  runLock = false;
  return { ran: true, cases: cases.length, lessons, teachers: teacherStatus };
}

/** 同日幂等（彭总令：固定每天 05:10 一轮）：今天已有 scheduler 轮次 → true */
export async function distillRanToday(): Promise<boolean> {
  try {
    const db = getDb();
    const rows = rawRows(
      await db.execute(sql`SELECT id FROM st_evo_signals WHERE kind='distill' AND DATE(created_at)=CURDATE() LIMIT 1`),
    );
    return rows.length > 0;
  } catch { return false; }
}

export const evolveDistillRouter = createRouter({
  /** 蒸馏状态页（HQ 或 EVOLVE_KEY）：三师名册+可用性+最近轮次 */
  status: publicQuery.input(z.object({ key: z.string().optional() })).query(async () => {
    const db = getDb();
    const teachers = TEACHERS.map((t) => ({
      code: t.code,
      vendor: t.vendor,
      model: t.model,
      keyPresent: !!process.env[t.keyEnv] || !!t.gatewayModel,
      weightLicensed: t.weightLicensed,
    }));
    let recent: unknown[] = [];
    try {
      recent = rawRows(
        await db.execute(sql`SELECT LEFT(payload,600) AS p, created_at FROM st_evo_signals WHERE kind='distill' ORDER BY id DESC LIMIT 5`),
      );
    } catch { /* 无表静默 */ }
    return { teachers, recent };
  }),

  /** 手工触发一轮（EVOLVE_KEY 或 HQ 管理员） */
  run: publicQuery
    .input(z.object({ key: z.string().optional(), token: z.string().optional() }))
    .mutation(async ({ input }) => {
      if (!isEvolveKey(input.key)) {
        const { sessionMe } = await import("./wbSession");
        const session = await sessionMe(input.token ?? "");
        if (session.factory.id !== 6380240) throw new Error("仅灵智枢");
      }
      return distillRunOnce("manual");
    }),
});
