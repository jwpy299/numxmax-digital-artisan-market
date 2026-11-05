/**
 * guidedForm —— M24 对话式引导填写引擎（数字人帮用户填资料）。
 *
 * 形态：剧本 JSON（GUIDES 注册表）+ 会话状态机。两个剧本：
 * - org_profile    企业画像（industry/scale/products/departments）
 * - asset_register 设备登记（name/category/location，复用 wbAssets.register 现有契约）
 *
 * 纪律（与宪法一致）：
 * 1. 确认才写库（B 级注释）：confirmGuide(confirm) 或确认态口播「确认」才真实落库；
 *    引导过程中一切答案只存内存态，绝不落库；
 * 2. 解析失败不猜：本地规则归一 → flash 槽 LLM 辅助解析（失败静默走原文）→ 校验，
 *    校验不过重问（最多 2 次后跳过选填项），必填项绝不猜测通过；
 * 3. 触发词本地识别宁漏判不误判（voice.utterance 前置链在人格互换/记住之后、
 *    协议技能路由之前调用 detectGuideStart / handleGuideUtterance）；
 * 4. token 只在请求体；token 绝不存入会话状态（提交时由调用方当次传入）。
 *
 * 会话状态：wb 侧内存 Map（sessionKey = factoryId-userId-guideId，30min TTL，
 * 惰性过期）。注意：进程重启丢失引导中状态，可接受（未确认的答案本就不落库，
 * 重来一次即可，无数据一致性风险）。
 */
import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";
import { sessionMe } from "./wbSession";
import { callSlotChat, callSlotChatFast } from "./modelGateway";
import type { CallOpts, LlmCallResult } from "./modelGateway";
import { wbAssetsRouter } from "./wbAssets";
// M27：语音开工作台账号 → 复用 wbInvites.create 现有契约（一次性 iv_ 码，仅 admin）
import { wbInvitesRouter } from "./wbInvites";

// ─── flash 槽（与 voice.ts 同款双通道竞速+回退，失败静默由上层兜底）───────────
async function callFlash(opts: CallOpts): Promise<LlmCallResult> {
  try {
    const r = await callSlotChatFast("flash", opts);
    return r as unknown as LlmCallResult;
  } catch {
    return callSlotChat("flash", opts);
  }
}

// ─── 剧本结构 ────────────────────────────────────────────────────────────────

export type GuideId = "org_profile" | "asset_register" | "wb_invite";

interface GuideOption {
  value: string;
  name: string;
}

interface GuideField {
  key: string;
  label: string;
  /** 灵枢问法（无预填时） */
  ask: string;
  required: boolean;
  options?: GuideOption[];
  /** LLM 辅助解析提示（flash 槽；失败静默走原文） */
  parseHints: string;
  /** 口语归一本地规则：返回归一后的合法值；无法归一返回 null（交给 LLM/原文） */
  parseLocal: (text: string) => string | null;
  /** 校验归一后的值；返回错误文案或 null（通过） */
  validate: (value: string) => string | null;
}

interface GuideDef {
  id: GuideId;
  title: string;
  fields: GuideField[];
}

// ─── 口语数字归一（「八十来个」→ 80）─────────────────────────────────────────

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 简易中文数字 → 阿拉伯（支持 十/百/千 量级，覆盖口语人数表达） */
function cnToNum(s: string): number | null {
  if (!s) return null;
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch]!;
    } else if (ch === "十") {
      section += (digit || 1) * 10;
      digit = 0;
    } else if (ch === "百") {
      section += (digit || 1) * 100;
      digit = 0;
    } else if (ch === "千") {
      total += (section + (digit || 1)) * 1000;
      section = 0;
      digit = 0;
    } else {
      return null;
    }
  }
  return total + section + digit;
}

/** 从口语里抽人数：优先阿拉伯数字，其次中文数字（「八十来个」「一百二十人」） */
function spokenNumber(text: string): number | null {
  const ar = /(\d{1,6})/.exec(text);
  if (ar) return Number(ar[1]);
  const cn = /([一二两三四五六七八九十百千]{1,6})/.exec(text);
  if (cn) return cnToNum(cn[1]!);
  return null;
}

function scaleBucket(n: number): string {
  if (n <= 50) return "1-50";
  if (n <= 100) return "50-100";
  if (n <= 500) return "100-500";
  return "500+";
}

// ─── 选项表与本地归一 ────────────────────────────────────────────────────────

const INDUSTRY_OPTIONS: GuideOption[] = [
  { value: "装备制造", name: "装备制造" },
  { value: "电子信息", name: "电子信息" },
  { value: "纺织服装", name: "纺织服装" },
  { value: "食品加工", name: "食品加工" },
  { value: "其他", name: "其他" },
];

const SCALE_OPTIONS: GuideOption[] = [
  { value: "1-50", name: "1-50 人" },
  { value: "50-100", name: "50-100 人" },
  { value: "100-500", name: "100-500 人" },
  { value: "500+", name: "500 人以上" },
];

type AssetCategory = "production" | "hvac" | "lighting" | "printer" | "office" | "other";
type AssetCodeType = "qr" | "ean13" | "code128" | "manual" | "other";

const CATEGORY_OPTIONS: GuideOption[] = [
  { value: "production", name: "生产设备" },
  { value: "hvac", name: "暖通空调" },
  { value: "lighting", name: "照明" },
  { value: "printer", name: "打印设备" },
  { value: "office", name: "办公设备" },
  { value: "other", name: "其他" },
];

/** 选项命中：精确值/名称包含 → 别名表（宁漏判不误判，别名只收无歧义说法） */
function optionHit(text: string, options: GuideOption[], aliases: Array<[string, string[]]>): string | null {
  for (const o of options) {
    if (text === o.value || text.includes(o.value) || text.includes(o.name)) return o.value;
  }
  for (const [value, words] of aliases) {
    if (words.some((w) => text.includes(w))) return value;
  }
  return null;
}

const parseIndustry = (text: string): string | null =>
  optionHit(text, INDUSTRY_OPTIONS, [
    ["装备制造", ["机械", "装备", "五金", "模具", "零部件"]],
    ["电子信息", ["电子", "半导体", "电路", "元器件"]],
    ["纺织服装", ["纺织", "服装", "制衣", "面料"]],
    ["食品加工", ["食品", "饮料"]],
  ]);

const parseScale = (text: string): string | null => {
  const hit = optionHit(text, SCALE_OPTIONS, [["500+", ["五百以上", "上千"]]]);
  if (hit) return hit;
  const n = spokenNumber(text);
  return n != null && n > 0 ? scaleBucket(n) : null;
};

const parseCategory = (text: string): string | null =>
  optionHit(text, CATEGORY_OPTIONS, [
    ["production", ["生产", "机床", "产线", "注塑", "冲压"]],
    ["hvac", ["空调", "暖通", "新风"]],
    ["lighting", ["灯", "照明"]],
    ["printer", ["打印", "复印"]],
    ["office", ["办公", "电脑"]],
  ]);

/** 文本字段本地归一：仅 trim，绝不截断改写（超长由 validate 重问，不擅自猜） */
const trimText = (_max: number) => (text: string): string | null => {
  const t = text.trim();
  return t || null;
};

/** 部门清单归一：逗号/顿号/分号/空格/「和」分隔 → 「，」连接 */
const parseDepartments = (text: string): string | null => {
  const parts = text
    .split(/[,，、;；\s和]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts.join("，") : null;
};

function optionValidate(options: GuideOption[]) {
  return (value: string): string | null =>
    options.some((o) => o.value === value)
      ? null
      : `请从「${options.map((o) => o.name).join("、")}」里选一个`;
}

const validateProducts = (v: string): string | null =>
  v.length >= 2 && v.length <= 100 ? null : "主要产品要 2-100 个字";

const validateDepartments = (v: string): string | null => {
  const parts = v.split("，").filter(Boolean);
  if (parts.length < 1 || parts.length > 8) return "部门说 1 到 8 个就行";
  if (parts.some((p) => p.length > 16)) return "单个部门名别超过 16 个字";
  return null;
};

const validateAssetName = (v: string): string | null =>
  v.length >= 2 && v.length <= 64 ? null : "设备名称要 2-64 个字";

const validateLocation = (v: string): string | null =>
  v.length <= 128 ? null : "位置别超过 128 个字";

// ─── 剧本注册表 ──────────────────────────────────────────────────────────────

export const GUIDES: Record<GuideId, GuideDef> = {
  org_profile: {
    id: "org_profile",
    title: "企业画像",
    fields: [
      {
        key: "industry",
        label: "行业",
        ask: "咱们企业属于哪个行业？装备制造、电子信息、纺织服装、食品加工，还是其他？",
        required: true,
        options: INDUSTRY_OPTIONS,
        parseHints: "合法取值：装备制造 / 电子信息 / 纺织服装 / 食品加工 / 其他。按语义归一到最接近的一项，输出选项原文。",
        parseLocal: parseIndustry,
        validate: optionValidate(INDUSTRY_OPTIONS),
      },
      {
        key: "scale",
        label: "规模",
        ask: "厂里现在大概多少人？随口说就行，比如「八十来个」。",
        required: true,
        options: SCALE_OPTIONS,
        parseHints: "合法取值：1-50 / 50-100 / 100-500 / 500+。把口语人数（如「八十来个」）归一到对应区间，输出区间原文。",
        parseLocal: parseScale,
        validate: optionValidate(SCALE_OPTIONS),
      },
      {
        key: "products",
        label: "主要产品",
        ask: "主要产品是什么？一句话就行，比如「精密五金件」。",
        required: true,
        parseHints: "把口语描述提炼成 2-100 字的产品描述，保留原意，输出提炼后的文本。",
        parseLocal: trimText(100),
        validate: validateProducts,
      },
      {
        key: "departments",
        label: "部门清单",
        ask: "厂里都有哪些部门？说一到八个，用逗号隔开就行。",
        required: true,
        parseHints: "把口语部门说法归一为逗号分隔的部门清单（1-8 个），输出「，」连接的部门名。",
        parseLocal: parseDepartments,
        validate: validateDepartments,
      },
    ],
  },
  asset_register: {
    id: "asset_register",
    title: "设备登记",
    fields: [
      {
        key: "name",
        label: "设备名称",
        ask: "这台设备叫什么名字？比如「一号注塑机」。",
        required: true,
        parseHints: "把口语叫法提炼成 2-64 字的设备名称，输出提炼后的文本。",
        parseLocal: trimText(64),
        validate: validateAssetName,
      },
      {
        key: "category",
        label: "设备类目",
        ask: "它算哪一类？生产设备、暖通空调、照明、打印设备、办公设备，还是其他？",
        required: true,
        options: CATEGORY_OPTIONS,
        parseHints: "合法取值：production(生产设备) / hvac(暖通空调) / lighting(照明) / printer(打印设备) / office(办公设备) / other(其他)。输出对应英文值。",
        parseLocal: parseCategory,
        validate: optionValidate(CATEGORY_OPTIONS),
      },
      {
        key: "location",
        label: "位置",
        ask: "它放在哪儿？比如「二号车间」。没有就说「没有」。",
        required: false,
        parseHints: "把口语位置描述提炼成不超过 128 字的位置文本，输出提炼后的文本。",
        parseLocal: trimText(128),
        validate: validateLocation,
      },
    ],
  },
  // M27：灵枢为企业成员开工作台账号（复用 wbInvites.create 契约；邀请码绝不进口播）
  wb_invite: {
    id: "wb_invite",
    title: "工作台账号开通",
    fields: [
      {
        key: "displayName",
        label: "姓名",
        ask: "要给谁开工作台账号？说下他的姓名。",
        required: true,
        parseHints: "把口语姓名提炼成 2-32 字的姓名文本（去掉「给」「开账号」等动词），输出纯姓名。",
        parseLocal: trimText(32),
        validate: (v: string) => (v.length >= 2 && v.length <= 32 ? null : "姓名要 2-32 个字"),
      },
      {
        key: "deptName",
        label: "部门",
        ask: "他在哪个部门？说一个就行，比如「生产部」。",
        required: true,
        parseHints: "把口语部门说法提炼成部门名（2-16 字，如「生产部」），输出纯部门名。",
        parseLocal: trimText(16),
        validate: (v: string) => (v.length >= 2 && v.length <= 16 ? null : "部门名要 2-16 个字"),
      },
      {
        key: "role",
        label: "角色",
        ask: "他是部门负责人还是普通员工？",
        required: true,
        options: [
          { value: "manager", name: "负责人" },
          { value: "staff", name: "员工" },
        ],
        parseHints: "合法取值：manager(负责人/经理/主管) / staff(普通员工/员工)。按语义归一，输出英文值。",
        parseLocal: (t: string) => {
          const s = t.trim();
          if (/负责人|经理|主管|部长|head/i.test(s)) return "manager";
          if (/员工|职员|成员|staff/i.test(s)) return "staff";
          return null;
        },
        validate: optionValidate([
          { value: "manager", name: "负责人" },
          { value: "staff", name: "员工" },
        ]),
      },
    ],
  },
};

// ─── 会话状态机（内存态，30min TTL；重启丢失引导中状态可接受）────────────────

const GUIDE_TTL_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 2; // 校验重问上限：超过后选填项跳过（必填项继续重问，绝不猜测通过）

export interface GuideState {
  sessionKey: string;
  guideId: GuideId;
  factoryId: number;
  userKey: string;
  username: string;
  status: "answering" | "confirming";
  index: number;
  attempts: number;
  answers: Record<string, string | null>;
  /** 字段级预填（画像已有数据 / App 传入），问法带「我记得是 X，对吗？」 */
  prefills: Record<string, string>;
  /** 非字段上下文（扫码 codeValue/codeType，由 App 经 startGuide.prefill 传入） */
  context: Record<string, string>;
  expiresAt: number;
}

const sessions = new Map<string, GuideState>();
/** 同人同厂同时只留一个 activeGuide：factoryId-userKey → sessionKey */
const activeByUser = new Map<string, string>();

const userSlot = (factoryId: number, userKey: string) => `${factoryId}-${userKey}`;

function destroy(state: GuideState): void {
  sessions.delete(state.sessionKey);
  const slot = userSlot(state.factoryId, state.userKey);
  if (activeByUser.get(slot) === state.sessionKey) activeByUser.delete(slot);
}

/** 测试与重启排空用（生产代码不调用） */
export function clearGuideSessions(): void {
  sessions.clear();
  activeByUser.clear();
}

/** 查活跃引导（惰性 TTL 过期即销毁）；voice.utterance 前置链与测试共用 */
export function findActiveGuide(factoryId: number, userKey: string): GuideState | null {
  const key = activeByUser.get(userSlot(factoryId, userKey));
  if (!key) return null;
  const s = sessions.get(key);
  if (!s) {
    activeByUser.delete(userSlot(factoryId, userKey));
    return null;
  }
  if (Date.now() > s.expiresAt) {
    destroy(s);
    return null;
  }
  return s;
}

/** 测试断言用：该用户是否还有残留引导 */
export function hasActiveGuide(factoryId: number, userKey: string): boolean {
  return findActiveGuide(factoryId, userKey) != null;
}

// ─── 触发词本地识别（宁漏判不误判）───────────────────────────────────────────

/** 「(帮我)?(完善|填写|填一下).{0,4}(企业)?(资料|画像)」→ org_profile；「登记.{0,2}设备」→ asset_register；
 *  「开/注册/开通…工作台(的)?账号」「给…开账号」「邀请/拉…进工作台」「分发…账号」→ wb_invite（M27，宁漏判不误判） */
export function detectGuideStart(text: string): GuideId | null {
  const t = text.trim();
  if (!t) return null;
  if (/(?:帮我)?(?:完善|填写|填一下|填下).{0,4}(?:企业)?(?:资料|画像)/.test(t)) return "org_profile";
  if (/登记.{0,2}设备/.test(t)) return "asset_register";
  if (/(?:开|注册|开通|办).{0,4}工作台.{0,2}账号/.test(t)) return "wb_invite";
  if (/(?:给|帮|替).{0,6}(?:开|注册|办|分发).{0,2}账号/.test(t)) return "wb_invite";
  if (/(?:邀请|拉).{0,4}(?:进|入|加入).{0,2}工作台/.test(t)) return "wb_invite";
  if (/分发.{0,2}(?:工作台.{0,2})?账号/.test(t)) return "wb_invite";
  return null;
}

// ─── 口播口令 ────────────────────────────────────────────────────────────────

const CANCEL_RE = /(算了|不填了|不弄了|别填了|不用填了)|^(取消|退出)[啊呀呢吧。！!]?$/;
// 否定前缀否决 + 全串锚定（与 AFFIRM_RE 同款）：「好的，部门还要加一个」「行，上一题」绝不误判为确认提交
const CONFIRM_RE = /^(?!不)(确认|提交|没问题|就这样|对|对的|是|是的|好|好的|可以|行)[啊呀呢吧。！!]?$/;
const BACK_RE = /(上一题|上一道|上一条|上一个|回上一题|返回上一题)/;
/** 预填问法的肯定应答：「对/是的/嗯/没错」→ 采用预填值（「不对」被 (?!不) 否决） */
const AFFIRM_RE = /^(?!不)(对|对的|对呀|是|是的|嗯|恩|没错|可以|行|好|好的)[啊呀呢吧。！!]?$/;
/** 选填跳过：「没有/不填/跳过」 */
const SKIP_RE = /^(没有|无|不填|不用|跳过|略过)[啊呀呢吧。！!]?$/;

/**
 * 预填问法的否定修正前缀：「不对，是 X」「不是 X」「不，X」→ 剥离后再走正常解析管线，
 * 否则原文会被文本字段（products 等）整个吞进库、或被 departments 拆出「不对」当部门名。
 * 返回 null = 无否定前缀；返回串 = 剥离后的余文（空串 = 只否定没给新值，由上层重问）。
 * 「不」单独作前缀必须紧跟标点（保护「不锈钢制品」「不行大厦」这类正常文本不被误剥）。
 */
const NEG_PREFIX_RE = /^(?:不对|不是的?|错了?)(?:[，,、。！!\s]*是)?[，,、。！!\s]*|^不[，,、。！!\s]+(?:是[，,、。！!\s]*)?/;

export function stripNegationPrefix(text: string): string | null {
  const t = text.trim();
  const m = NEG_PREFIX_RE.exec(t);
  if (!m) return null;
  return t.slice(m[0].length).trim();
}

// ─── DTO ─────────────────────────────────────────────────────────────────────

interface FieldDto {
  key: string;
  label: string;
  ask: string;
  required: boolean;
  options?: GuideOption[];
  prefilled: string | null;
}

interface SummaryItem {
  key: string;
  label: string;
  value: string | null;
  display: string;
}

type GuideStatus = "answering" | "reask" | "confirming" | "submitted" | "cancelled";

interface GuideReply {
  status: GuideStatus;
  reply: string;
  field?: FieldDto;
  progress: { done: number; total: number };
  attempts?: number;
  summary?: SummaryItem[];
  result?: Record<string, unknown>;
}

function progressOf(state: GuideState): { done: number; total: number } {
  return { done: Object.keys(state.answers).length, total: GUIDES[state.guideId].fields.length };
}

function fieldDto(state: GuideState, field: GuideField): FieldDto {
  return {
    key: field.key,
    label: field.label,
    ask: field.ask,
    required: field.required,
    ...(field.options ? { options: field.options } : {}),
    prefilled: state.prefills[field.key] ?? null,
  };
}

function displayOf(field: GuideField, value: string | null): string {
  if (value == null || value === "") return "（未填）";
  const opt = field.options?.find((o) => o.value === value);
  return opt ? opt.name : value;
}

function summaryOf(state: GuideState): SummaryItem[] {
  return GUIDES[state.guideId].fields.map((f) => ({
    key: f.key,
    label: f.label,
    value: state.answers[f.key] ?? null,
    display: displayOf(f, state.answers[f.key] ?? null),
  }));
}

/** 预填问法：「我记得是 X，对吗？」 */
function askText(field: GuideField, prefilled: string | undefined): string {
  if (prefilled != null) {
    const shown = displayOf(field, prefilled);
    return `${field.label}——我记得是「${shown}」，对吗？不对的话直接告诉我正确的。`;
  }
  return field.ask;
}

// ─── LLM 辅助解析（flash 槽；失败静默返回 null，上层走原文）──────────────────

async function llmParse(field: GuideField, text: string): Promise<string | null> {
  try {
    const r = await callFlash({
      messages: [
        {
          role: "system",
          content:
            `你在把老板口述的答案归一化为表单字段「${field.label}」的合法值。${field.parseHints} ` +
            `只输出归一化后的值本身，一个词或一句话，不要任何解释。无法归一就原样输出原文。`,
        },
        { role: "user", content: text },
      ],
      maxTokens: 60,
      temperature: 0,
      timeoutMs: 15_000,
    });
    if (!r.ok) return null;
    const out = String((r as { content?: string }).content ?? "").trim();
    return out || null;
  } catch {
    return null; // 静默：LLM 抖动不阻断引导，走原文校验
  }
}

/** 当前字段解析管线：预填确认 → 选填跳过 → 本地归一 → LLM 辅助（失败静默走原文）→ 选项名↔值映射 */
async function parseAnswer(
  field: GuideField,
  text: string,
  prefilled: string | undefined,
): Promise<string | null> {
  if (prefilled != null && AFFIRM_RE.test(text)) return prefilled;
  if (!field.required && SKIP_RE.test(text)) return null;
  const local = field.parseLocal(text);
  if (local != null) {
    // 本地命中的文本字段（products/name 等）直接采用；选项字段已归一为合法值
    if (!field.options || field.options.some((o) => o.value === local)) return local;
  }
  // 本地归一不了（多为选项字段的陌生说法）→ flash 槽辅助解析
  const llm = await llmParse(field, text);
  let candidate = (llm ?? local ?? text.trim()).trim();
  if (field.options) {
    // LLM 可能回了选项中文名：名→值映射（仍是显式映射，不是猜测）
    const byName = field.options.find((o) => o.name === candidate || o.value === candidate);
    if (byName) candidate = byName.value;
  }
  return candidate;
}

// ─── 状态机推进 ──────────────────────────────────────────────────────────────

function touch(state: GuideState): void {
  state.expiresAt = Date.now() + GUIDE_TTL_MS;
}

/** 推进到下一未答字段；全部答完 → 进入确认态并复述清单 */
function advance(state: GuideState, prefix = ""): GuideReply {
  const def = GUIDES[state.guideId];
  while (state.index < def.fields.length) {
    const f = def.fields[state.index]!;
    if (!(f.key in state.answers)) {
      state.attempts = 0;
      const pre = state.prefills[f.key];
      return {
        status: "answering",
        reply: prefix + askText(f, pre),
        field: fieldDto(state, f),
        progress: progressOf(state),
      };
    }
    state.index++;
  }
  state.status = "confirming";
  const summary = summaryOf(state);
  const recap = summary.map((s) => `${s.label}：${s.display}`).join("；");
  return {
    status: "confirming",
    reply: `${prefix}都齐了，我复述一遍——${recap}。说「确认」我就提交，说「取消」就全部作废，什么都没保存。`,
    summary,
    progress: progressOf(state),
  };
}

function cancelledReply(): GuideReply {
  return {
    status: "cancelled",
    reply: "好，这次不填了，什么都没有保存。想填的时候再跟我说。",
    progress: { done: 0, total: 0 },
  };
}

/** B 级纪律：唯一真实写库点——仅 confirmGuide(confirm) / 确认态口播「确认」到达此处 */
async function submitCore(state: GuideState, token: string): Promise<GuideReply> {
  const summary = summaryOf(state);
  let reply: string;
  let result: Record<string, unknown>;
  if (state.guideId === "org_profile") {
    result = await saveOrgProfile(state);
    reply = `已提交，企业画像更新好了——${summary.map((s) => `${s.label}：${s.display}`).join("；")}。`;
  } else if (state.guideId === "wb_invite") {
    result = await submitWbInvite(state, token);
    // 失败（无此部门/权限不足/同名重复）→ 人话说明，绝不假装成功
    reply = String(result.reply);
  } else {
    result = await submitAssetRegister(state, token);
    const asset = result.asset as { assetNo?: string } | undefined;
    reply = result.already
      ? `这台设备之前登记过了（资产编号 ${String(asset?.assetNo ?? "")}），没有重复登记。`
      : `登记完成，设备已入台账（资产编号 ${String(asset?.assetNo ?? "")}）。`;
  }
  destroy(state);
  return { status: "submitted", reply, summary, result, progress: { done: summary.length, total: summary.length } };
}

/** answerGuide 核心（voice.utterance 前置链共用）：当前句 → 解析/校验/推进/取消/回退/确认提交 */
async function answerCore(state: GuideState, text: string, token: string): Promise<GuideReply> {
  touch(state);
  // 全局退出口令：「算了/取消/不填了」→ 退出，不残留、不写库
  if (CANCEL_RE.test(text)) {
    destroy(state);
    return cancelledReply();
  }

  if (state.status === "confirming") {
    // 判定顺序：先 BACK/修改意图后 CONFIRM——「行，上一题」绝不误当确认提交
    if (BACK_RE.test(text)) {
      const def = GUIDES[state.guideId];
      state.status = "answering";
      state.index = Math.max(0, def.fields.length - 1);
      delete state.answers[def.fields[state.index]!.key];
      return advance(state, "好，最后一题重来。");
    }
    if (CONFIRM_RE.test(text)) return submitCore(state, token);
    const summary = summaryOf(state);
    return {
      status: "confirming",
      reply: "还没提交。说「确认」我就提交，说「取消」全部作废，说「上一题」回去改最后一条。",
      summary,
      progress: progressOf(state),
    };
  }

  const def = GUIDES[state.guideId];

  // 「上一题」→ 回退一题重答
  if (BACK_RE.test(text)) {
    if (state.index <= 0) {
      const f = def.fields[0]!;
      return {
        status: "reask",
        reply: `这已经是第一题了。${askText(f, state.prefills[f.key])}`,
        field: fieldDto(state, f),
        attempts: state.attempts,
        progress: progressOf(state),
      };
    }
    state.index--;
    const f = def.fields[state.index]!;
    delete state.answers[f.key];
    state.attempts = 0;
    return {
      status: "answering",
      reply: `好，回到上一题。${askText(f, state.prefills[f.key])}`,
      field: fieldDto(state, f),
      progress: progressOf(state),
    };
  }

  const field = def.fields[state.index]!;
  // 否定修正：剥离「不对/不是/不，」类前缀再走解析管线（预填问法答「不对，是 X」→ 落库 X，
  // 不吞原文、不把「不对」拆成部门名）；剥离后为空（只否定没给新值）→ 重问，不猜。
  const stripped = stripNegationPrefix(text);
  if (stripped !== null && !stripped) {
    return {
      status: "reask",
      reply: `好，那正确的怎么说？${askText(field, state.prefills[field.key])}`,
      field: fieldDto(state, field),
      attempts: state.attempts,
      progress: progressOf(state),
    };
  }
  const value = await parseAnswer(field, stripped ?? text, state.prefills[field.key]);

  if (value != null) {
    const err = field.validate(value);
    if (err) {
      state.attempts++;
      if (state.attempts >= MAX_ATTEMPTS && !field.required) {
        // 选填项重问 2 次仍不过 → 跳过（不猜、不硬拦）
        state.answers[field.key] = null;
        state.index++;
        return advance(state, `这项先跳过。`);
      }
      // 校验失败重问：绝不猜测通过
      return {
        status: "reask",
        reply: `这条不太对：${err}。${askText(field, state.prefills[field.key])}`,
        field: fieldDto(state, field),
        attempts: state.attempts,
        progress: progressOf(state),
      };
    }
  }

  state.answers[field.key] = value;
  state.index++;
  return advance(state, "记下了。");
}

// ─── 写库实现（仅 submitCore 调用）───────────────────────────────────────────

interface FactoryRow {
  industry: string;
  industryText: string | null;
  headcount: string;
  departments: Array<{ id: string; name: string; headcount?: string; duty?: string }>;
  profile: Record<string, unknown>;
}

async function loadFactoryRow(factoryId: number): Promise<FactoryRow | null> {
  const rows = rawRows(
    await getDb().execute(
      sql`SELECT industry, industryText, headcount, departments, profile FROM wb_factories WHERE id = ${factoryId} LIMIT 1`,
    ),
  );
  const r = rows[0];
  if (!r) return null;
  const parseJson = (v: unknown): unknown => {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };
  const depts = parseJson(r.departments);
  const profile = parseJson(r.profile);
  return {
    industry: String(r.industry ?? ""),
    industryText: r.industryText == null ? null : String(r.industryText),
    headcount: String(r.headcount ?? ""),
    departments: Array.isArray(depts)
      ? (depts as Array<{ id: string; name: string; headcount?: string; duty?: string }>)
      : [],
    profile: profile && typeof profile === "object" ? (profile as Record<string, unknown>) : {},
  };
}

/**
 * org_profile 提交：画像保存（wb_factories industry/headcount/departments 合并 + profile.products）。
 * headcount 口径：本引导写区间串（1-50/50-100/100-500/500+），与历史既有数字串（如「85」）并列存在，
 * 消费端两处口径都要兼容，不要假设一定是数字。
 */
async function saveOrgProfile(state: GuideState): Promise<Record<string, unknown>> {
  const industry = String(state.answers.industry ?? "");
  const scale = String(state.answers.scale ?? "");
  const products = String(state.answers.products ?? "");
  const deptNames = String(state.answers.departments ?? "")
    .split("，")
    .map((s) => s.trim())
    .filter(Boolean);

  const row = await loadFactoryRow(state.factoryId);
  // 部门合并非破坏性：用户清单在前（同名沿用既有 id/duty/headcount），未提及的既有部门原样保留
  const existing = row?.departments ?? [];
  const merged = deptNames.map((name, i) => {
    const hit = existing.find((d) => d.name === name);
    return hit ?? { id: `gd_${i + 1}`, name };
  });
  for (const d of existing) {
    if (!deptNames.includes(d.name)) merged.push(d);
  }
  const profile = { ...(row?.profile ?? {}), products };
  // industry 选「其他」时同步清 industryText（自由行业描述只对应旧值，不残留错配）；
  // 选到具体行业时保留既有 industryText（非破坏，与 departments 合并同哲学）。
  const industryText = industry === "其他" ? null : (row?.industryText ?? null);

  await getDb().execute(
    sql`UPDATE wb_factories
        SET industry = ${industry}, industryText = ${industryText}, headcount = ${scale},
            departments = ${JSON.stringify(merged)}, profile = ${JSON.stringify(profile)}
        WHERE id = ${state.factoryId}`,
  );
  return { saved: "org_profile", industry, scale, products, departments: merged.map((d) => d.name) };
}

/**
 * M27 wb_invite 提交：复用 wbInvites.create 现有契约（一次性 iv_ 码，72h，仅 admin）。
 * 纪律：
 * - 邀请码明文绝不进口播 reply（敏感串纪律）；只进 result 供 App 屏幕展示/复制（TLS 通道）；
 * - 部门名 → 企业画像 departments 精确/包含匹配，无匹配绝不写库（不烧码不造孤码）；
 * - 权限/重名等契约错误一律人话化返回（saved:false），不抛技术文案给老板。
 */
async function submitWbInvite(state: GuideState, token: string): Promise<Record<string, unknown>> {
  const displayName = String(state.answers.displayName ?? "").trim();
  const deptName = String(state.answers.deptName ?? "").trim();
  const role = String(state.answers.role ?? "staff") === "manager" ? "manager" : "staff";
  const roleText = role === "manager" ? "负责人" : "员工";

  const row = await loadFactoryRow(state.factoryId);
  const depts = row?.departments ?? [];
  const dept =
    depts.find((d) => d.name === deptName) ??
    depts.find((d) => d.name.includes(deptName) || deptName.includes(d.name));
  if (!dept) {
    const known = depts.map((d) => d.name).join("、") || "（画像里还没有部门，先跟我说「完善企业资料」补上）";
    return {
      saved: false,
      reason: "dept_not_found",
      reply: `没找到「${deptName}」这个部门，账号没开成。你们画像里的部门有：${known}。`,
    };
  }

  try {
    const caller = wbInvitesRouter.createCaller({} as never);
    const res = await caller.create({ token, displayName, deptId: dept.id, role });
    return {
      saved: true,
      inviteId: res.inviteId,
      inviteCode: res.code,
      inviteUrl: res.inviteUrl,
      displayName: res.displayName,
      deptName: res.deptName,
      role: res.role,
      expiresAt: res.expiresAt,
      reply:
        `账号开好了：${res.displayName}，${res.deptName}，${roleText}。` +
        `邀请码已放在你屏幕上（我不念出来），72 小时内有效。` +
        `把链接发给他，他设好密码就能入职。`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    let human = `账号没开成：${msg.includes("admin") || msg.includes("权限") ? "这个操作要企业管理员身份才行" : msg.slice(0, 60)}。`;
    if (/同 displayName|未消耗|已存在|重复/.test(msg)) {
      human = `${displayName} 已经有一张没用过的工作台邀请了，别重复开。去工作台「组织」页把原邀请发给他就行。`;
    }
    return { saved: false, reason: "create_failed", reply: human };
  }
}

/** asset_register 提交：复用 wbAssets.register 现有契约（幂等：同码已有 active → already） */
async function submitAssetRegister(state: GuideState, token: string): Promise<Record<string, unknown>> {
  const name = String(state.answers.name ?? "");
  const c = String(state.answers.category ?? "other");
  const category = (CATEGORY_OPTIONS.some((o) => o.value === c) ? c : "other") as AssetCategory;
  const location = state.answers.location ?? null;
  // 扫码上下文（App 经 startGuide.prefill 传入）；无扫码 → manual 手工码
  const rawCodeType = state.context.codeType ?? "manual";
  const codeType = (["qr", "ean13", "code128", "manual", "other"].includes(rawCodeType)
    ? rawCodeType
    : "manual") as AssetCodeType;
  const codeValue =
    state.context.codeValue?.trim() ||
    `MANUAL-${state.factoryId}-${randomBytes(3).toString("hex").toUpperCase()}`;
  const caller = wbAssetsRouter.createCaller({} as never);
  const res = await caller.register({
    token,
    name,
    category,
    codeType,
    codeValue,
    ...(location ? { location } : {}),
  });
  return { saved: "asset_register", already: res.already, asset: res.asset };
}

// ─── startGuide 核心 ─────────────────────────────────────────────────────────

interface StartResult {
  state: GuideState;
  reply: GuideReply;
}

async function startGuideCore(args: {
  factoryId: number;
  userKey: string;
  username: string;
  guideId: GuideId;
  prefill?: Record<string, string>;
}): Promise<StartResult> {
  const { factoryId, userKey, username, guideId } = args;
  // 同人同厂只留一个 activeGuide：新引导覆盖旧引导（旧的从未写库，直接丢弃）
  const prev = findActiveGuide(factoryId, userKey);
  if (prev) destroy(prev);

  const def = GUIDES[guideId];
  const prefills: Record<string, string> = {};
  const context: Record<string, string> = {};

  // 预填数据源①：App 传入（扫码上下文 codeValue/codeType；命中字段 key 的按字段预填）
  const fieldKeys = new Set(def.fields.map((f) => f.key));
  for (const [k, v] of Object.entries(args.prefill ?? {})) {
    if (fieldKeys.has(k)) prefills[k] = v;
    else context[k] = v;
  }

  // 预填数据源②：org_profile 读现有企业画像（已有数据问法带「我记得是 X，对吗？」）
  if (guideId === "org_profile") {
    const row = await loadFactoryRow(factoryId);
    if (row) {
      if (!prefills.industry && INDUSTRY_OPTIONS.some((o) => o.value === row.industry)) {
        prefills.industry = row.industry;
      }
      if (!prefills.scale && SCALE_OPTIONS.some((o) => o.value === row.headcount)) {
        prefills.scale = row.headcount;
      }
      const products = typeof row.profile.products === "string" ? row.profile.products : "";
      if (!prefills.products && products.trim()) prefills.products = products.trim();
      if (!prefills.departments && row.departments.length >= 1 && row.departments.length <= 8) {
        prefills.departments = row.departments.map((d) => d.name).join("，");
      }
    }
  }

  const sessionKey = `${factoryId}-${userKey}-${guideId}`;
  const state: GuideState = {
    sessionKey,
    guideId,
    factoryId,
    userKey,
    username,
    status: "answering",
    index: 0,
    attempts: 0,
    answers: {},
    prefills,
    context,
    expiresAt: Date.now() + GUIDE_TTL_MS,
  };
  sessions.set(sessionKey, state);
  activeByUser.set(userSlot(factoryId, userKey), sessionKey);

  const first = def.fields[0]!;
  const prefilledCount = Object.keys(prefills).length;
  const opening =
    `好，我们来填${def.title}，一共 ${def.fields.length} 项` +
    `${prefilledCount ? `，其中 ${prefilledCount} 项我有印象，你确认就行` : ""}。`;
  const reply: GuideReply = {
    status: "answering",
    reply: opening + askText(first, prefills[first.key]),
    field: fieldDto(state, first),
    progress: progressOf(state),
  };
  return { state, reply };
}

// ─── voice.utterance 前置链入口（人格互换/记住之后、协议技能路由之前）──────────

export interface GuideUtteranceOutcome {
  reply: string;
  guide: {
    guideId: GuideId;
    status: GuideStatus;
    progress: { done: number; total: number };
    summary?: SummaryItem[];
  };
}

/**
 * utterance 前置：会话有 activeGuide → 本句直进引导机（口播式回复）；
 * 无 activeGuide 且本地命中触发词 → startGuide；都不沾 → null（主链照常）。
 */
export async function handleGuideUtterance(args: {
  token: string;
  factoryId: number;
  userKey: string;
  username: string;
  text: string;
}): Promise<GuideUtteranceOutcome | null> {
  const active = findActiveGuide(args.factoryId, args.userKey);
  if (active) {
    const r = await answerCore(active, args.text, args.token);
    return {
      reply: r.reply,
      guide: {
        guideId: active.guideId,
        status: r.status,
        progress: r.progress,
        ...(r.summary ? { summary: r.summary } : {}),
        ...(r.result ? { result: r.result } : {}),
      },
    };
  }
  const guideId = detectGuideStart(args.text);
  if (!guideId) return null;
  const { reply } = await startGuideCore({
    factoryId: args.factoryId,
    userKey: args.userKey,
    username: args.username,
    guideId,
  });
  return {
    reply: reply.reply,
    guide: { guideId, status: reply.status, progress: reply.progress, ...(reply.summary ? { summary: reply.summary } : {}) },
  };
}

// ─── 路由 ────────────────────────────────────────────────────────────────────

const tokenInput = z.object({ token: z.string().trim().min(1) });
const sessionKeyInput = z.string().trim().min(1).max(200);

/** 取引导会话并校验归属（factoryId + userKey），过期/不存在一律 NOT_FOUND */
function requireGuideState(sessionKey: string, factoryId: number, userKey: string): GuideState {
  const s = sessions.get(sessionKey);
  // 归属不匹配（他人 sessionKey）：仅抛 NOT_FOUND，绝不 destroy——不能销毁他人仍在进行的会话；
  // 仅 TTL 过期才 destroy（惰性过期清理）。
  if (!s || s.factoryId !== factoryId || s.userKey !== userKey) {
    throw new TRPCError({ code: "NOT_FOUND", message: "引导会话不存在或已过期，请重新开始" });
  }
  if (Date.now() > s.expiresAt) {
    destroy(s);
    throw new TRPCError({ code: "NOT_FOUND", message: "引导会话不存在或已过期，请重新开始" });
  }
  return s;
}

const userKeyOf = (user: { id?: unknown; username?: unknown }): string =>
  user.id != null ? String(user.id) : String(user.username ?? "");

export const guidedFormRouter = createRouter({
  /**
   * guidedForm.startGuide：开启引导（返回 sessionKey + 第一问 + 进度）。
   * prefill：App 传入的预填/上下文——命中字段 key 的按字段预填（问法带「我记得是 X，对吗？」），
   * 其余进上下文（asset_register 的扫码 codeValue/codeType 由此传入）；
   * org_profile 另自动读现有企业画像预填。
   */
  startGuide: publicQuery
    .input(
      tokenInput.extend({
        guideId: z.enum(["org_profile", "asset_register", "wb_invite"]),
        prefill: z.record(z.string().trim().min(1).max(64), z.string().trim().min(1).max(256)).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const { state, reply } = await startGuideCore({
        factoryId: factory.id,
        userKey: userKeyOf(user),
        username: String(user.username),
        guideId: input.guideId,
        prefill: input.prefill,
      });
      return {
        ok: true as const,
        sessionKey: state.sessionKey,
        guideId: state.guideId,
        guideTitle: GUIDES[state.guideId].title,
        status: reply.status,
        reply: reply.reply,
        field: reply.field!,
        progress: reply.progress,
      };
    }),

  /**
   * guidedForm.answerGuide：当前字段作答 → 解析→校验（失败重问，最多 2 次后跳过选填）→下一问；
   * 口播口令：「算了/取消/不填了」退出（不残留不写库）、「上一题」回退、
   * 全部完成 → 确认态复述清单；确认态说「确认」等同 confirmGuide(confirm) 直接提交。
   */
  answerGuide: publicQuery
    .input(tokenInput.extend({ sessionKey: sessionKeyInput, text: z.string().trim().min(1).max(500) }))
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const state = requireGuideState(input.sessionKey, factory.id, userKeyOf(user));
      const r = await answerCore(state, input.text, input.token);
      return {
        sessionKey: state.sessionKey,
        guideId: state.guideId,
        status: r.status,
        reply: r.reply,
        ...(r.field ? { field: r.field } : {}),
        ...(r.attempts != null ? { attempts: r.attempts } : {}),
        ...(r.summary ? { summary: r.summary } : {}),
        ...(r.result ? { result: r.result } : {}),
        progress: r.progress,
      };
    }),

  /**
   * guidedForm.confirmGuide：确认态提交/丢弃。
   * B 级纪律：decision=confirm 才真实写库（画像保存 / 设备登记复用 wbAssets.register 契约）；
   * cancel → 丢弃，绝不落库。
   */
  confirmGuide: publicQuery
    .input(tokenInput.extend({ sessionKey: sessionKeyInput, decision: z.enum(["confirm", "cancel"]) }))
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const state = requireGuideState(input.sessionKey, factory.id, userKeyOf(user));
      if (state.status !== "confirming") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "还没答完全部问题，未到确认环节" });
      }
      if (input.decision === "cancel") {
        destroy(state);
        return { ok: true as const, sessionKey: state.sessionKey, guideId: state.guideId, status: "cancelled" as const, reply: "已取消，什么都没有保存。" };
      }
      const r = await submitCore(state, input.token);
      return {
        ok: true as const,
        sessionKey: state.sessionKey,
        guideId: state.guideId,
        status: "submitted" as const,
        reply: r.reply,
        summary: r.summary!,
        result: r.result!,
      };
    }),
});
