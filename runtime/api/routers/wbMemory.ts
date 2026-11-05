/**
 * wbMemory —— M23a 数字人记忆（灵枢/星云的长期记忆）。
 *
 * 写入口径三通道：
 * ① 显式口令：voice.utterance 前置本地预判 detectRemember（「记住/帮我记住/记一下」开头），
 *    强制写 kind=note scope=user importance=4，回复「记住了。」（voice.ts 承载，detectRemember 在此）；
 * ② 异步 LLM 提炼：utterance 回复后 scheduleMemoryExtraction 火忘式提炼（flash 槽，
 *    prompt 问「这段对话有没有值得长期记住的偏好/事实」，有→JSON 数组≤2 条，失败静默）；
 * ③ 系统事件写入：M23b 触发器等可 saveMemory 写 fact 类（scope=factory 全厂共享）。
 *
 * 纪律：
 * - 框架层无自动鉴权，token 只在请求体；myMemories/forget 走 sessionMe（同 wbAssets）；
 * - 召回 recallMemories：未删除 + scope=user 属本人 + scope=factory 属本厂 + 同人格，
 *   importance desc + lastUsedAt desc 取 top 8，被召回行 uses+1 lastUsedAt=NOW；
 * - 防脏：单用户（userId+factoryId+scope=user）未删除记忆超 100 条时，新写入后淘汰
 *   超出部分——importance 最低 + 最久未用（lastUsedAt 升序 NULL 在前）+ 最旧创建。
 *   淘汰是物理删除（LRU 语义，不占审计）；forget 是软删（deletedAt 置位，保留审计）；
 * - content 一律 stripSecrets + PII 遮蔽 + 截断 300 字（写入路径统一过 sanitizeMemoryContent）；
 * - 一切记忆读写失败对语音主链静默（voice.ts 调用侧 try/catch），绝不阻断老板说话。
 *
 * M23c（彭总指令「小星也要记得注册用户」）：persona 枚举扩展 'xingxing'——
 * 匠市客服小星的长期记忆。小星记忆与灵枢/星云同表但按 persona 严格隔离：
 * 召回只认 persona='xingxing'（小星不偷看灵枢/星云的日记，反之亦然）；
 * 写入仅 assistant.ask 应答后 scheduleXingxingExtraction 火忘提炼（≤1 条，
 * importance 钳 1-4——前台咨询权重低于老板嘱托）；匿名访客不召回不写入（隐私红线）。
 * myMemories 出参 persona 原样透出（含 'xingxing'），App 记忆管理卡按
 * { lingshu: '灵枢', xingyun: '星云', xingxing: '小星' } 渲染标签（前端映射，后端契约即此注释）。
 */
import { and, asc, desc, eq, inArray, isNull, or, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { wbMemories, type WbMemory } from "@db/schema";
import { sessionMe } from "./wbSession";
import { stripSecrets } from "./voice";
import type { Persona } from "./personaShared";
import { callSlotChat } from "./modelGateway";
import { runThresholdArchive, scheduleLruArchive } from "./memoryArchive";

/**
 * 记忆人格：灵枢/星云之外扩展小星（匠市客服，M23c）。
 * 注意：voice 的 Persona 仍为 'lingshu'|'xingyun'（语音人格不扩展）；
 * 'xingxing' 只存在于记忆底座与匠市客服链路。
 */
export type MemoryPersona = Persona | "xingxing";

/** 单用户（userId+factoryId，scope=user）有效记忆容量上限；超出即 LRU 淘汰 */
export const MEMORY_CAP = 100;
/** 召回条数上限（注入 parseUtterance system prompt「你记得的事」块） */
export const RECALL_TOP_N = 8;
/** 异步提炼单次最多落库条数 */
const EXTRACT_MAX = 2;

type Db = ReturnType<typeof getDb>;

// ─── 显式口令本地预判（通道①，纯本地、零 LLM，宁漏判不误判）─────────────────

/** 「记住/帮我记住/记一下」开头（后可跟冒号/逗号/顿号/空白分隔）；「我记得上次」等不命中 */
const REMEMBER_PREFIX = /^(?:帮我记住|记住|记一下)\s*[:：，,、]?\s*/;
/** 句尾语气词否决：内容以「吗/呢/吧」结尾是疑问/敷衍语气而非嘱托，不记（「记住了吗」类必不中） */
const TAIL_PARTICLE = /[吗呢吧]$/;
/** 判定前剥离的句尾标点（「记住要开会吧。」按「吧」结尾否决） */
const TAIL_PUNCT = /[\s。！？!?…~～.,，]+$/;
/** 实质内容下限：<4 字视为垃圾记忆（「记住就行」「记住了吗」去前缀后仅 2 字，必不中） */
const MIN_REMEMBER_LEN = 4;

/**
 * detectRemember：显式「记住」口令预判。命中返回待记内容（去前缀、截 300）；
 * 以下情况一律 null（不拦截，调用方走正常语音链）：未命中前缀、空口令、
 * 去标点句尾后实质内容 <4 字、内容以「吗/呢/吧」语气词结尾。
 */
export function detectRemember(text: string): { content: string } | null {
  const t = text.trim();
  const m = REMEMBER_PREFIX.exec(t);
  if (!m) return null;
  const content = t.slice(m[0].length).trim();
  const core = content.replace(TAIL_PUNCT, "");
  if (core.length < MIN_REMEMBER_LEN) return null;
  if (TAIL_PARTICLE.test(core)) return null;
  return { content: content.slice(0, 300) };
}

// ─── 写入（三通道共用入口）───────────────────────────────────────────────────

export interface SaveMemoryInput {
  factoryId: number;
  userId: number;
  persona: MemoryPersona;
  scope: "user" | "factory";
  kind: "preference" | "fact" | "note";
  content: string;
  /** 1-5；缺省 3（显式口令通道传 4） */
  importance?: number;
}

/**
 * PII 遮蔽正则（隐私红线双保险之保险二：提炼 prompt 已禁记，落库前再正则兜底）。
 * 三条通道①②③全走 saveMemory → sanitizeMemoryContent，语音通道②与小星提炼自动继承。
 * 独立手机号：1[3-9] 开头 11 位，前后不粘数字（防误伤更长编号串中段）。
 */
const PII_PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
/** 独立身份证：18 位（末位可 X/x），前后不粘数字 */
const PII_ID = /(?<!\d)\d{17}[\dXx](?!\d)/g;
/** 独立银行卡：16-19 位连续数字，前后不粘数字 */
const PII_CARD = /(?<!\d)\d{16,19}(?!\d)/g;

/**
 * 记忆正文统一净化：stripSecrets → PII 遮蔽 → 截 300 → trim；空正文不落库（返回 0）。
 * PII 顺序：先身份证（18 位）再卡号（16-19 位），防 18 位身份证被卡号正则抢先吃掉
 * 而错标成 [卡号]；手机号 11 位与二者位数区间不交叠，次序无影响。
 */
function sanitizeMemoryContent(content: string): string {
  return stripSecrets(content)
    .replace(PII_ID, "[身份证号]")
    .replace(PII_PHONE, "[手机号]")
    .replace(PII_CARD, "[卡号]")
    .slice(0, 300)
    .trim();
}

/**
 * saveMemory：写一条记忆并执行容量淘汰。
 * 淘汰口径（注释即契约）：仅对 scope=user 的本人记忆计容量；写入后未删除数 > MEMORY_CAP
 * 时，按 importance 升序（最低先走）→ lastUsedAt 升序（NULL 最久未用先走）→ id 升序
 * （最旧先走）取超出条数物理删除。scope=factory 的系统事件记忆不占个人容量。
 */
export async function saveMemory(input: SaveMemoryInput, db: Db = getDb()): Promise<number> {
  const content = sanitizeMemoryContent(input.content);
  if (!content) return 0;
  const importance = Math.min(5, Math.max(1, Math.round(input.importance ?? 3)));
  const [{ id }] = await db
    .insert(wbMemories)
    .values({
      factoryId: input.factoryId,
      userId: input.userId,
      persona: input.persona,
      scope: input.scope,
      kind: input.kind,
      content,
      importance,
    })
    .$returningId();

  if (input.scope === "user") {
    const owning = await db
      .select({ id: wbMemories.id })
      .from(wbMemories)
      .where(
        and(
          eq(wbMemories.userId, input.userId),
          eq(wbMemories.factoryId, input.factoryId),
          eq(wbMemories.scope, "user"),
          isNull(wbMemories.deletedAt),
        ),
      );
    const excess = owning.length - MEMORY_CAP;
    if (excess > 0) {
      // M49：淘汰前把内容带上（抢救归档需要正文），仅多三列不增查询成本
      const victims = await db
        .select({ id: wbMemories.id, content: wbMemories.content, kind: wbMemories.kind, importance: wbMemories.importance })
        .from(wbMemories)
        .where(
          and(
            eq(wbMemories.userId, input.userId),
            eq(wbMemories.factoryId, input.factoryId),
            eq(wbMemories.scope, "user"),
            isNull(wbMemories.deletedAt),
          ),
        )
        .orderBy(asc(wbMemories.importance), asc(wbMemories.lastUsedAt), asc(wbMemories.id))
        .limit(excess);
      if (victims.length > 0) {
        // M49 抢救归档：淘汰物理删除前，火忘式送入企业知识库（失败静默，绝不阻断淘汰）
        void scheduleLruArchive(
          input.factoryId,
          input.persona,
          victims.map((v) => ({ content: String(v.content), kind: String(v.kind), importance: Number(v.importance) })),
        );
        // LRU 淘汰即物理删除：被淘汰记忆已归档留证，不占软删审计（forget 才软删）
        await db.delete(wbMemories).where(inArray(wbMemories.id, victims.map((v) => v.id)));
      }
    }
  }
  return Number(id);
}

// ─── 召回（voice.parseUtterance 注入「你记得的事」块的数据源）─────────────────

/**
 * recallMemories：未删除 + 同人格 +（scope=user 属本人 OR scope=factory 属本厂），
 * importance desc + lastUsedAt desc 取 top 8；被召回行 uses+1、lastUsedAt=NOW。
 * 返回正文串（单条≤300 字，写入已截断，此处再截防御）。
 */
export async function recallMemories(
  factoryId: number,
  userId: number,
  persona: MemoryPersona,
  db: Db = getDb(),
  topN: number = RECALL_TOP_N,
): Promise<string[]> {
  const rows = await db
    .select()
    .from(wbMemories)
    .where(
      and(
        eq(wbMemories.persona, persona),
        isNull(wbMemories.deletedAt),
        or(
          and(eq(wbMemories.scope, "user"), eq(wbMemories.userId, userId)),
          and(eq(wbMemories.scope, "factory"), eq(wbMemories.factoryId, factoryId)),
        ),
      ),
    )
    .orderBy(desc(wbMemories.importance), desc(wbMemories.lastUsedAt))
    .limit(topN);
  if (rows.length > 0) {
    await db
      .update(wbMemories)
      .set({ uses: dsql`${wbMemories.uses} + 1`, lastUsedAt: new Date() })
      .where(inArray(wbMemories.id, rows.map((r) => r.id)));
  }
  return rows.map((r) => String(r.content).slice(0, 300));
}

// ─── 通道②：utterance 回复后异步 LLM 提炼（火忘式，失败静默）─────────────────

interface ExtractedMemory {
  kind: "preference" | "fact";
  content: string;
  importance: number;
}

/** LLM 输出 → 合法记忆数组（≤2 条）；任何异常/非法一律空数组 */
export function parseExtractedMemories(raw: string): ExtractedMemory[] {
  try {
    const m = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
    const parsed = JSON.parse((m ? m[1]! : raw).trim()) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: ExtractedMemory[] = [];
    for (const item of parsed.slice(0, EXTRACT_MAX)) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      const kind = it.kind === "preference" || it.kind === "fact" ? it.kind : null;
      const content = typeof it.content === "string" ? it.content.trim() : "";
      if (!kind || !content) continue;
      const importance = Math.min(5, Math.max(1, Math.round(Number(it.importance) || 3)));
      out.push({ kind, content: content.slice(0, 300), importance });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * scheduleMemoryExtraction：一段对话落长期记忆（flash 槽）。
 * 返回 Promise 供测试 await；voice.ts 调用侧 `void` 火忘——任何失败静默，
 * 绝不阻断/拖慢语音主链。
 */
export function scheduleMemoryExtraction(opts: {
  factoryId: number;
  userId: number;
  persona: MemoryPersona;
  userText: string;
  agentReply: string;
}): Promise<void> {
  return (async () => {
    const r = await callSlotChat("flash", {
      messages: [
        {
          role: "system",
          content:
            `你在为数字员工整理长期记忆。读一段老板与数字员工的对话，判断有没有值得长期记住的` +
            `用户偏好或事实（喜好、习惯、长期约束、重要事实；客套、一次性指令、闲聊不记）。` +
            `有 → 输出严格 JSON 数组（≤${EXTRACT_MAX} 条）：` +
            `[{"kind":"preference"|"fact","content":"≤100字","importance":1-5}]；没有 → 输出 []。` +
            `绝不编造，绝不记录票据号/密钥等编号串。`,
        },
        {
          role: "user",
          content: `老板说：「${opts.userText.slice(0, 500)}」\n你回复：「${opts.agentReply.slice(0, 500)}」`,
        },
      ],
      maxTokens: 300,
      temperature: 0.2,
      timeoutMs: 30_000,
    });
    if (!r.ok) return;
    const items = parseExtractedMemories(String((r as { content?: string }).content ?? ""));
    for (const it of items) {
      await saveMemory({
        factoryId: opts.factoryId,
        userId: opts.userId,
        persona: opts.persona,
        scope: "user",
        kind: it.kind,
        content: it.content,
        importance: it.importance,
      });
    }
    // M49 阈值沉淀：本厂本人格记忆达阈值后自动归档企业知识库（火忘，失败静默，
    // 归档失败绝不阻断记忆提炼主链；冷却/表未建由 runThresholdArchive 内部处理）
    void runThresholdArchive(opts.factoryId, opts.persona).catch(() => {});
  })().catch(() => {
    /* 提炼失败静默（LLM 抖动/表未建绝不阻断语音主链） */
  });
}

// ─── M23c：小星（匠市客服）应答后异步提炼（火忘式，复用通道②模式）─────────────

/** 小星单次提炼上限（前台咨询比老板嘱托轻，一轮至多记 1 条） */
const XINGXING_EXTRACT_MAX = 1;
/** 小星记忆 importance 钳制上限（1-4；显式口令/语音通道才可到 4-5） */
const XINGXING_IMPORTANCE_MAX = 4;

/**
 * scheduleXingxingExtraction：匠市客服 ask 应答成功后，把「这轮咨询有没有值得记的
 * 偏好/关注点/未解决诉求」异步提炼进 persona='xingxing' 长期记忆。
 * 与语音通道②的差异：单次 ≤1 条；importance 钳 1-4；persona 固定 'xingxing'
 * （scope=user 本人私有，与灵枢/星云记忆按人格隔离）。
 * 返回 Promise 供测试 await；assistant.ask 调用侧 `void` 火忘——任何失败静默，
 * 绝不阻断/拖慢客服主链。匿名访客由调用侧保证不触发（无 userId 可记）。
 */
export function scheduleXingxingExtraction(opts: {
  factoryId: number;
  userId: number;
  userText: string;
  agentReply: string;
}): Promise<void> {
  return (async () => {
    const r = await callSlotChat("flash", {
      messages: [
        {
          role: "system",
          content:
            `你在为数字匠市客服「小星」整理对注册用户的长期记忆。读一轮用户咨询与小星的答复，` +
            `判断有没有值得长期记住的用户偏好、关注点或未解决诉求（如：反复关心的功能、明确表达的习惯、` +
            `本次未解决留待跟进的诉求；客套、一次性问题、纯寒暄不记）。` +
            `有 → 输出严格 JSON 数组（≤${XINGXING_EXTRACT_MAX} 条）：` +
            `[{"kind":"preference"|"fact","content":"≤100字","importance":1-${XINGXING_IMPORTANCE_MAX}}]；没有 → 输出 []。` +
            `绝不编造，绝不记录票据号/密钥等编号串。` +
            `绝不记录手机号、身份证号、银行卡号、住址、微信号等个人敏感信息；` +
            `咨询类记忆只记偏好/关注点/未解决诉求。`,
        },
        {
          role: "user",
          content: `用户问：「${opts.userText.slice(0, 500)}」\n小星答：「${opts.agentReply.slice(0, 500)}」`,
        },
      ],
      maxTokens: 300,
      temperature: 0.2,
      timeoutMs: 30_000,
    });
    if (!r.ok) return;
    const items = parseExtractedMemories(String((r as { content?: string }).content ?? ""))
      .slice(0, XINGXING_EXTRACT_MAX)
      .map((it) => ({ ...it, importance: Math.min(XINGXING_IMPORTANCE_MAX, it.importance) }));
    for (const it of items) {
      await saveMemory({
        factoryId: opts.factoryId,
        userId: opts.userId,
        persona: "xingxing",
        scope: "user",
        kind: it.kind,
        content: it.content,
        importance: it.importance,
      });
    }
    // M49 阈值沉淀：小星记忆同口径自动归档（火忘，失败静默，绝不阻断客服主链）
    void runThresholdArchive(opts.factoryId, "xingxing").catch(() => {});
  })().catch(() => {
    /* 提炼失败静默（LLM 抖动/表未建绝不阻断客服主链） */
  });
}

// ─── 管理接口 ────────────────────────────────────────────────────────────────

const tokenInput = { token: z.string().trim().min(1) };

function memoryCard(m: WbMemory) {
  return {
    memoryId: m.id,
    persona: m.persona,
    scope: m.scope,
    kind: m.kind,
    content: m.content,
    importance: m.importance,
    uses: m.uses,
    createdAt: m.createdAt,
    lastUsedAt: m.lastUsedAt,
  };
}

export const wbMemoryRouter = createRouter({
  /**
   * wbMemory.myMemories：本人（scope=user，本厂）全部未删除记忆，倒序。
   * 契约：一期仅 scope=user 对前端开放；scope=factory 记忆仅系统写（通道③），
   * 暂无删除端（forget 只受理本人 scope=user）。出参 items[]（同 wbAssets.list 惯例）。
   * 出参 persona 原样透出（M23c 起含 'xingxing'）：App 记忆管理卡需显示小星记忆，
   * persona 标签映射 { lingshu:'灵枢', xingyun:'星云', xingxing:'小星' }（前端渲染约定，本注释即契约）。
   */
  myMemories: publicQuery.input(z.object({ ...tokenInput })).query(async ({ input }) => {
    const db = getDb();
    const { user, factory } = await sessionMe(input.token);
    const rows = await db
      .select()
      .from(wbMemories)
      .where(
        and(
          eq(wbMemories.userId, user.id),
          eq(wbMemories.factoryId, factory.id),
          eq(wbMemories.scope, "user"),
          isNull(wbMemories.deletedAt),
        ),
      )
      .orderBy(desc(wbMemories.id));
    return { items: rows.map(memoryCard) };
  }),

  /** wbMemory.forget：遗忘一条本人记忆（软删 deletedAt；仅本人 scope=user；幂等 ok:true） */
  forget: publicQuery
    .input(z.object({ ...tokenInput, memoryId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const { user, factory } = await sessionMe(input.token);
      await db
        .update(wbMemories)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(wbMemories.id, input.memoryId),
            eq(wbMemories.userId, user.id),
            eq(wbMemories.factoryId, factory.id),
            eq(wbMemories.scope, "user"),
            isNull(wbMemories.deletedAt),
          ),
        );
      // 幂等：不存在/已遗忘/非本人一律 ok:true（不泄露他人记忆存在性）
      return { ok: true as const };
    }),
});
