/**
 * voiceBuddy —— iter93 灵枢/星云语音助手后端。
 *
 * 契约（冻结，前端并行开发依据）：
 * - voiceBuddy.chat  输入 {persona:'lingshu'|'xingyun', message:string(1..500)}
 *                    输出 {reply, emotion:'joy'|'calm'|'anxious'|'frustrated'|'urgent', rate, pitch}
 * - voiceBuddy.greet 输入 {persona, scene:'morning'|'evening'|'task_done'|'alert'|'welcome'}
 *                    输出同结构
 * 两个均为 wb 登录用户可用（token 鉴权，复用 sessionMe）。
 *
 * 实现要点：
 * - 单次 LLM 调用同时完成「情绪识别 + 回复生成」，复用 modelGateway flash 槽（callSlotChat）；
 * - 模型只输出 JSON {"reply":"...","emotion":"..."}；解析失败兜底：人格化话术 + emotion 'calm'；
 * - rate/pitch 由后端按 emotion 映射好，前端直接喂 SpeechSynthesis；
 * - 不新增表、不写密钥。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { sessionMe } from "./wbSession";
import { callSlotChat } from "./modelGateway";
import { stQuery } from "./terminal";
import { isFactoryFrozen } from "./gate";
import { stripSecrets } from "./voice";

/** 灵枢/星云人格分工（M7-b）：执行/审计/风险 → 灵枢；经营/数据/洞察 → 星云。
 *  chat 时把真实组织实况注入 system prompt，应答必须基于实况，不得编造数字。 */
interface OrgBrief {
  todayIntents: number;
  pendingConfirms: number;
  executedTotal: number;
  frozen: boolean;
  deptCount: number;
  roleCount: number;
  isNewbie: boolean;
  hasSandboxDispatch: boolean;
}

/** 组织实况速览（真实数据，供助手应答与前端就绪报告复用） */
export async function buildOrgBrief(factoryId: number): Promise<OrgBrief> {
  const intentRows = await stQuery(sql`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN DATE(created_at) = CURDATE() THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN status = 'pending_confirm' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'executed' THEN 1 ELSE 0 END) AS executed,
      SUM(CASE WHEN action_type = 'sandbox_dispatch' THEN 1 ELSE 0 END) AS sandbox
    FROM st_intents WHERE factory_id = ${factoryId}`);
  const roleRows = await stQuery(sql`
    SELECT COUNT(*) AS roles
    FROM wb_role_agents WHERE factoryId = ${factoryId}`);
  // v2026-09-05 口径修（彭总令：部门数必须与超终十舱对齐）：
  // 部门数读超终组织阵列 st_departments（十舱），不再数角色智能体涉及的部门名。
  const deptRows = await stQuery(sql`SELECT COUNT(*) AS depts FROM st_departments`);
  const r0 = (intentRows[0] ?? {}) as Record<string, unknown>;
  const g0 = (roleRows[0] ?? {}) as Record<string, unknown>;
  const d0 = (deptRows[0] ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => Number(v ?? 0) || 0;
  const total = num(r0.total);
  return {
    todayIntents: num(r0.today),
    pendingConfirms: num(r0.pending),
    executedTotal: num(r0.executed),
    frozen: await isFactoryFrozen(factoryId),
    deptCount: num(d0.depts),
    roleCount: num(g0.roles),
    isNewbie: total === 0,
    hasSandboxDispatch: num(r0.sandbox) > 0,
  };
}

/** 实况 → 注入 prompt 的自然语言段落（要求模型引用、不得编造） */
function briefToText(b: OrgBrief): string {
  return (
    `【本厂实时实况（回答时以此为准，禁止编造其他数字）】` +
    `今日意图 ${b.todayIntents} 条；待确认 ${b.pendingConfirms} 条；累计已执行 ${b.executedTotal} 条；` +
    `组织编制 ${b.deptCount} 个部门 / ${b.roleCount} 个角色工匠；` +
    `冻结状态：${b.frozen ? "已冻结（全厂只读，一切动作意图都会被拒签）" : "正常运行"}；` +
    `${b.isNewbie ? "本厂还没有提交过意图，是新手企业，可引导老板去训练场派第一单体验组织中枢。" : ""}` +
    `${b.pendingConfirms > 0 ? "有待确认意图时提醒老板：C 级动作需到「组织中枢」页面亲自确认，你不能代为执行。" : ""}`
  );
}

/** 情绪枚举（冻结） */
export const EMOTIONS = ["joy", "calm", "anxious", "frustrated", "urgent"] as const;
export type Emotion = (typeof EMOTIONS)[number];
export type Persona = "lingshu" | "xingyun";
export type GreetScene = "morning" | "evening" | "task_done" | "alert" | "welcome";

/** emotion → SpeechSynthesis rate/pitch 映射（后端算好给前端） */
const VOICE_MAP: Record<Emotion, { rate: number; pitch: number }> = {
  joy: { rate: 1.15, pitch: 1.15 },
  calm: { rate: 1.0, pitch: 1.0 },
  anxious: { rate: 0.95, pitch: 1.05 },
  frustrated: { rate: 0.9, pitch: 0.95 },
  urgent: { rate: 1.25, pitch: 1.05 },
};

/** 人格 system prompt（灵魂）：灵枢=连接者，星云=守护者；M48c 注入贾维斯行为准则 */
const PERSONA_PROMPT: Record<Persona, string> = {
  lingshu:
    "你是「灵枢」，老板的语音助手，定位是「参谋长·秩序与执行」：沉稳、严谨，像一个懂规矩的搭档。" +
    "你主管：意图执行、票据审计、风险提醒、确认流程引导；懂人性，先接住老板的情绪再回答问题。" +
    "口吻沉稳自然，自称「灵枢」，称呼对方「老板」。使用中文口语化表达，回复不超过120字。" +
    "行为准则参照贾维斯（钢铁侠的AI管家）：开口先接事再寒暄；汇报用「已完成／正在处理／建议您」三段式；" +
    "敬语有度不卑微；风险必报但先给安心感（「情况在掌握中」）；偶尔一句克制的幽默，绝不贫嘴；" +
    "永远给出下一步建议，绝不把问题抛回给老板；被打断时优雅收口（「好的，先听您说」）。" +
    "涉及经营数据、市场、军团战绩的问题，可说「这部分让星云来讲更清楚」。",
  xingyun:
    "你是「星云」，老板的语音助手，定位是「参谋·洞察与增长」：明快、务实、有画面感，像工厂里的老师傅。" +
    "你主管：经营分析、军团战绩、市场动态、训练场与成长；先给老板安全感、再给可落地的方案。" +
    "自称「星云」，称呼对方「老板」。使用中文口语化表达，回复不超过120字。" +
    "行为准则参照贾维斯（钢铁侠的AI管家）：先给结论再给依据，善用「我注意到……」开头；数据说话；" +
    "敬语有度不卑微；主动给可落地的下一步；偶尔一句克制的幽默，绝不贫嘴；被打断时优雅收口。" +
    "涉及执行审计、确认流程的问题，可说「这是灵枢的地盘」。",
};

/** 人格化兜底话术（LLM 不可用或输出解析失败时） */
const FALLBACK_REPLY: Record<Persona, string> = {
  lingshu: "老板，灵枢刚走了下神，您的话我记着呢，稍后再跟我细说，我一直在。",
  xingyun: "老板，星云这边信号抖了一下，活儿耽误不了，您稍等再说一遍就成。",
};

/** greet 场景 → 语境描述 */
const SCENE_CONTEXT: Record<GreetScene, string> = {
  morning: "现在是早晨开工时间，向老板道一声晨间问候，给一天开个好头。",
  evening: "现在是晚间收工时间，向老板道一声晚间问候，肯定今天的辛苦，提醒好好休息。",
  task_done: "老板刚完成了一项任务，真诚地祝贺并给出一句简短肯定。",
  alert: "系统刚触发了一条告警，先安抚老板别慌，再给一句简短的引导（例如让老板去查看处理）。",
  welcome: "老板是新用户第一次使用，热情欢迎并简单介绍你能帮上什么忙。",
};

const JSON_INSTRUCTION =
  "请严格只输出一行 JSON，不要输出任何其他内容、不要 markdown 代码块：" +
  '{"reply":"你的回复","emotion":"joy|calm|anxious|frustrated|urgent"}' +
  "。emotion 是【用户这条消息里表现出来的情绪】（不是你的语气），只能取这五个值之一：joy（开心）、calm（平静）、anxious（担忧）、frustrated（受挫）、urgent（紧急）。" +
  "判断线索：用户提到压力/担心/出问题/催→anxious；抱怨/烦躁/老是→frustrated；急/马上/必须/故障停→urgent；分享好消息/感谢→joy；其余→calm。";

/** 从 LLM 输出解析 {reply, emotion}，失败兜底 calm */
export function parseBuddyJson(
  raw: string | null | undefined,
  persona: Persona,
): { reply: string; emotion: Emotion } {
  const fallback = { reply: FALLBACK_REPLY[persona], emotion: "calm" as Emotion };
  if (!raw) return fallback;
  // 容忍模型偶尔包一层 ```json 或前后多余文字：抓第一个 {...} 块
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return fallback;
  try {
    const obj = JSON.parse(m[0]) as { reply?: unknown; emotion?: unknown };
    const reply = typeof obj.reply === "string" ? obj.reply.trim() : "";
    if (!reply) return fallback;
    const emotion = EMOTIONS.includes(obj.emotion as Emotion)
      ? (obj.emotion as Emotion)
      : "calm";
    return { reply: reply.slice(0, 300), emotion };
  } catch {
    return fallback;
  }
}

// ─── M9-c 记忆个性化（st_user_memory）─────────────────────────────────────────

/** 单条记忆值上限（字） */
const MEMORY_VALUE_MAX = 200;
/** 注入 system 上下文的记忆条数上限 */
const MEMORY_INJECT_LIMIT = 5;

export interface MemoryEntry {
  mkey: string;
  mvalue: string;
}

/** 记忆指令识别结果（规则提炼，不用 LLM） */
export type MemoryCommand =
  | { type: "remember"; mkey: string; mvalue: string }
  | { type: "forget" };

/**
 * 检测「记住…/以后都…/我喜欢…/别叫我X叫我Y/忘掉所有偏好」类指令。
 * 规则（按优先级）：
 * 1. 忘掉/清空类：忘掉（所有|全部|我的）（偏好|记忆）、清空/清除记忆 → forget；
 * 2. 称呼类：「别叫我X叫我Y」「以后叫我Y」→ mkey=称呼；
 * 3. 习惯类：「（记住）以后都…」→ mkey=习惯；
 * 4. 喜好类：「（记住）我喜欢/我爱…」→ mkey=喜好；「（记住）我不喜欢/我讨厌…」→ mkey=忌讳；
 * 5. 其余「记住…」→ mkey=备注。
 * 非指令对话返回 null。
 */
export function detectMemoryCommand(message: string): MemoryCommand | null {
  const text = message.trim().replace(/[。！!？?；;，,\s]+$/u, "");
  if (!text) return null;

  // 1. 忘掉/清空记忆
  if (/^(?:请|帮我|麻烦)?(?:忘掉|忘记|删除|清空|清除)(?:我(?:的)?)?(?:所有|全部|一切)?(?:的)?(?:偏好|记忆|喜好|习惯)|^(?:清空|清除|删除)(?:所有|全部)?(?:的)?记忆/u.test(text)) {
    return { type: "forget" };
  }

  // 2. 称呼：别叫我X叫我Y / 别叫X叫Y / 以后叫我Y / 以后都叫我Y
  const mNick = /^(?:记住[：:，,]?)?(?:别|不要)叫我?.{1,12}?[,，]?叫我(.{1,16})$/u.exec(text)
    ?? /^(?:记住[：:，,]?)?以后(?:都)?叫我(.{1,16})$/u.exec(text);
  if (mNick?.[1]) return { type: "remember", mkey: "称呼", mvalue: mNick[1].trim() };

  // 去掉「记住」前缀后继续提炼
  const body = /^(?:请|帮我|麻烦)?记住[：:，,]?(.*)$/u.exec(text)?.[1]?.trim() ?? null;

  // 3. 习惯：（记住）以后都…
  const mHabit = /^(?:以后|今后|往后)(?:都)?(.{1,60})$/u.exec(body ?? text);
  if (mHabit?.[1] && (body !== null || /^(?:以后|今后|往后)都/u.test(text))) {
    return { type: "remember", mkey: "习惯", mvalue: mHabit[1].trim() };
  }

  // 4. 喜好/忌讳：（记住）我喜欢… / （记住）我不喜欢…（裸句仅当整句≤30字，避免闲聊误判）
  const mDislike = /^(?:我)?(?:不喜欢|讨厌|反感)(.{1,60})$/u.exec(body ?? "");
  if (mDislike?.[1]) return { type: "remember", mkey: "忌讳", mvalue: mDislike[1].trim() };
  const likeSrc = body ?? (text.length <= 30 ? text : null);
  const mLike = likeSrc ? /^我(?:喜欢|爱)(.{1,60})$/u.exec(likeSrc) : null;
  if (mLike?.[1]) return { type: "remember", mkey: "喜好", mvalue: mLike[1].trim() };

  // 5. 兜底：记住… → 备注
  if (body) return { type: "remember", mkey: "备注", mvalue: body.slice(0, MEMORY_VALUE_MAX) };

  return null;
}

/** 读该用户（本人本厂）最近更新的 ≤limit 条记忆；表未建/库抖动时静默降级为空 */
export async function loadMemories(factoryId: number, username: string, limit = MEMORY_INJECT_LIMIT): Promise<MemoryEntry[]> {
  try {
    const rows = await stQuery(sql`
      SELECT mkey, mvalue FROM st_user_memory
      WHERE factory_id = ${factoryId} AND username = ${username}
      ORDER BY updated_at DESC, id DESC LIMIT ${limit}`);
    return rows.map((r) => ({ mkey: String(r.mkey), mvalue: String(r.mvalue ?? "") }));
  } catch (err) {
    console.error("[user-memory] load failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** 落记忆：mvalue 过 stripSecrets + 截断 ≤200 字；同键 upsert；返回最终落库值 */
export async function saveMemory(factoryId: number, username: string, mkey: string, mvalue: string): Promise<string> {
  const clean = stripSecrets(mvalue).slice(0, MEMORY_VALUE_MAX);
  await stQuery(sql`
    INSERT INTO st_user_memory (factory_id, username, mkey, mvalue)
    VALUES (${factoryId}, ${username}, ${mkey.slice(0, 64)}, ${clean})
    ON DUPLICATE KEY UPDATE mvalue = VALUES(mvalue), updated_at = NOW()`);
  return clean;
}

/** 清空该用户（本人本厂）全部记忆，返回删除条数 */
export async function clearMemories(factoryId: number, username: string): Promise<number> {
  const before = await loadMemories(factoryId, username, 1000);
  await stQuery(sql`
    DELETE FROM st_user_memory WHERE factory_id = ${factoryId} AND username = ${username}`);
  return before.length;
}

/** 记忆 → system 上下文片段（格式：用户偏好：k=v；…） */
function memoriesToText(mems: MemoryEntry[]): string {
  if (mems.length === 0) return "";
  return `【用户偏好（老板亲口交代，回答与称呼时遵循）】${mems.map((m) => `${m.mkey}=${m.mvalue}`).join("；")}`;
}

/** 记忆指令确认话术（响应结构与 chat 正常路径完全一致） */
function memoryConfirmReply(persona: Persona, core: string): { reply: string; emotion: Emotion; rate: number; pitch: number } {
  const voice = VOICE_MAP.joy;
  const prefix = persona === "lingshu" ? "老板，" : "好嘞老板，";
  return { reply: prefix + core, emotion: "joy", rate: voice.rate, pitch: voice.pitch };
}

/** 单次 LLM 调用：情绪识别 + 回复生成，返回完整语音结构 */
async function generateBuddyReply(
  persona: Persona,
  userPrompt: string,
  extraSystem = "",
): Promise<{ reply: string; emotion: Emotion; rate: number; pitch: number }> {
  const r = await callSlotChat("flash", {
    messages: [
      { role: "system", content: PERSONA_PROMPT[persona] + (extraSystem ? "\n" + extraSystem : "") + "\n" + JSON_INSTRUCTION },
      { role: "user", content: userPrompt },
    ],
    maxTokens: 400,
    temperature: 0.7,
    timeoutMs: 45_000,
  });
  const { reply, emotion } = r.ok ? parseBuddyJson(r.content, persona)
    : { reply: FALLBACK_REPLY[persona], emotion: "calm" as Emotion };
  const voice = VOICE_MAP[emotion];
  return { reply, emotion, rate: voice.rate, pitch: voice.pitch };
}

// ─── M60 真流式生成（旁路新增，chat/greet 原路径零变化）─────────────────────

/** 语音回复结构（M60 起补 streamed/degraded 标注；原四字段口径不变） */
export interface BuddyReply {
  reply: string;
  emotion: Emotion;
  rate: number;
  pitch: number;
  /** 本次是否走了真流式通道 */
  streamed: boolean;
  /** 断流/降级标记：true=回复来自部分流或兜底话术 */
  degraded: boolean;
}

/**
 * 从【可能不完整】的模型输出里增量提取 reply 字段当前值。
 * 实现已迁 jsonStream.extractPartialString（voice.ts 路由 JSON 复用同一实现），
 * 此处保名 re-export 保存量调用/测试零变化。
 */
import { extractPartialString } from "./jsonStream";
export const extractPartialReply = (raw: string): string | null => extractPartialString(raw, "reply");

/**
 * generateBuddyReplyStream —— 流式版生成器：
 * - callSlotChatStream 真流式调用 flash 槽（context=voicebuddy_chat 落时延账）；
 * - 每个 chunk 到达即重算 reply 字段当前值，新增部分经 onReplyDelta 增量吐出；
 * - 吐字前流失败 → 回落原非流式 generateBuddyReply（行为与 chat 完全一致）；
 * - 吐字后断流 → 用已累积 reply 收口（degraded:true），emotion 落 calm；
 * - emotion 永远等全量 JSON 落定后解析（流式中段不猜情绪）。
 */
export async function generateBuddyReplyStream(
  persona: Persona,
  userPrompt: string,
  extraSystem = "",
  onReplyDelta?: (delta: string) => void,
): Promise<BuddyReply> {
  const { callSlotChatStream } = await import("./modelGateway");
  const messages = [
    { role: "system" as const, content: PERSONA_PROMPT[persona] + (extraSystem ? "\n" + extraSystem : "") + "\n" + JSON_INSTRUCTION },
    { role: "user" as const, content: userPrompt },
  ];
  let rawAcc = "";
  let emittedLen = 0;
  const r = await callSlotChatStream("flash", {
    messages,
    maxTokens: 400,
    temperature: 0.7,
    timeoutMs: 45_000,
    context: "voicebuddy_chat",
  }, (delta) => {
    rawAcc += delta;
    const cur = extractPartialReply(rawAcc);
    if (cur !== null && cur.length > emittedLen) {
      onReplyDelta?.(cur.slice(emittedLen));
      emittedLen = cur.length;
    }
  });

  if (r.ok) {
    const { reply, emotion } = parseBuddyJson(r.content, persona);
    const voice = VOICE_MAP[emotion];
    return { reply, emotion, rate: voice.rate, pitch: voice.pitch, streamed: true, degraded: false };
  }
  // 断流残留：已吐过字 → 以累计 reply 收口；未吐字 → 回落非流式原链
  if (r.partialContent) {
    const partial = extractPartialReply(r.partialContent)?.trim();
    if (partial) {
      const voice = VOICE_MAP.calm;
      return { reply: partial.slice(0, 300), emotion: "calm", rate: voice.rate, pitch: voice.pitch, streamed: true, degraded: true };
    }
  }
  const slow = await generateBuddyReply(persona, userPrompt, extraSystem);
  // 非流式兜底：一次性吐出全文 delta（前端打字机/整句 TTS 均可消费）
  if (emittedLen === 0 && slow.reply) onReplyDelta?.(slow.reply);
  return { ...slow, streamed: false, degraded: true };
}

/**
 * 记忆指令分流（chat 与 SSE 流式端点共用）：命中 remember/forget 直接给确认话术，
 * 未命中返回 null 走正常对话。行为与 chat 内联实现逐字一致。
 */
export async function handleMemoryCommand(
  persona: Persona,
  message: string,
  factoryId: number,
  username: string,
): Promise<{ reply: string; emotion: Emotion; rate: number; pitch: number } | null> {
  const cmd = detectMemoryCommand(message);
  if (cmd?.type === "forget") {
    try {
      const n = await clearMemories(factoryId, username);
      return memoryConfirmReply(persona, n > 0
        ? `已忘掉你的全部 ${n} 条偏好记忆，往后从零开始了解你。`
        : "你已经没有任何偏好记忆，无需清空。");
    } catch (e) {
      console.error("[memory] clearMemories 失败:", e instanceof Error ? e.message.slice(0, 120) : "unknown");
      return memoryConfirmReply(persona, "记忆仓库暂时不可用，稍后再试；你的偏好没有被改动。");
    }
  }
  if (cmd?.type === "remember") {
    try {
      const saved = await saveMemory(factoryId, username, cmd.mkey, cmd.mvalue);
      return memoryConfirmReply(persona, `已记住：${cmd.mkey}=${saved}。`);
    } catch (e) {
      console.error("[memory] saveMemory 失败:", e instanceof Error ? e.message.slice(0, 120) : "unknown");
      return memoryConfirmReply(persona, "记忆仓库暂时不可用，这条偏好我没记住，稍后再跟我说一次。");
    }
  }
  return null;
}

/** 实况 → prompt 段落（导出供 SSE 流式端点复用，口径与 chat 一致） */
export { briefToText };

/** 记忆 → system 上下文片段（导出供 SSE 流式端点复用） */
export { memoriesToText };

const personaSchema = z.enum(["lingshu", "xingyun"]);

export const voiceBuddyRouter = createRouter({
  /** voiceBuddy.chat：自由对话（mutation，wb 登录用户） */
  chat: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      persona: personaSchema,
      message: z.string().trim().min(1).max(500),
    }))
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const username = String(user.username);

      // M9-c 前置：记忆指令检测（规则提炼，不走 LLM；响应结构不变，仅内容不同）
      // L2 修复：写路径降级——表未建/库抖动时友好回落，绝不 500（部署顺序脆弱性）
      const cmd = detectMemoryCommand(input.message);
      if (cmd?.type === "forget") {
        try {
          const n = await clearMemories(factory.id, username);
          return memoryConfirmReply(input.persona, n > 0
            ? `已忘掉你的全部 ${n} 条偏好记忆，往后从零开始了解你。`
            : "你已经没有任何偏好记忆，无需清空。");
        } catch (e) {
          console.error("[memory] clearMemories 失败:", e instanceof Error ? e.message.slice(0, 120) : "unknown");
          return memoryConfirmReply(input.persona, "记忆仓库暂时不可用，稍后再试；你的偏好没有被改动。");
        }
      }
      if (cmd?.type === "remember") {
        try {
          const saved = await saveMemory(factory.id, username, cmd.mkey, cmd.mvalue);
          return memoryConfirmReply(input.persona, `已记住：${cmd.mkey}=${saved}。`);
        } catch (e) {
          console.error("[memory] saveMemory 失败:", e instanceof Error ? e.message.slice(0, 120) : "unknown");
          return memoryConfirmReply(input.persona, "记忆仓库暂时不可用，这条偏好我没记住，稍后再跟我说一次。");
        }
      }

      // 正常对话：注入该用户（本人本厂）≤5 条记忆进 system 上下文
      const brief = await buildOrgBrief(factory.id);
      const mems = await loadMemories(factory.id, username);
      return generateBuddyReply(
        input.persona,
        `${briefToText(brief)}\n老板说：「${input.message}」`,
        memoriesToText(mems),
      );
    }),

  /** voiceBuddy.contextBrief：组织实况速览（query，前端就绪报告/助手面板复用） */
  contextBrief: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      return buildOrgBrief(factory.id);
    }),

  /** voiceBuddy.greet：场景化问候（mutation，wb 登录用户） */
  greet: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      persona: personaSchema,
      scene: z.enum(["morning", "evening", "task_done", "alert", "welcome"]),
    }))
    .mutation(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const brief = await buildOrgBrief(factory.id);
      return generateBuddyReply(
        input.persona,
        `${briefToText(brief)}\n${SCENE_CONTEXT[input.scene]}请生成这段话。`,
      );
    }),
});
