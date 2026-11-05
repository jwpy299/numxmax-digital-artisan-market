/**
 * assistant —— NumX Max 智能客服（全确定性，无外部大模型调用）。
 *
 * 设计原则：
 * - 3 个 procedure 均为 publicQuery 声明；token 仅在请求体携带且可选，
 *   token 无效 / 库不可用时一律降级为匿名访客，绝不抛鉴权错误。
 * - 回答由品牌知识库 + 确定性意图路由 + 业务表只读 count 检索驱动；
 *   四大模型经统一网关接入：ask 优先 LLM 联网生成（失败静默回退确定性路由），capabilities 如实反映 configured/verified。
 * - 语音朗读为浏览器端能力（speechSynthesis / 语音识别，若前端支持）。
 * - stats 全部为只读 count；任一表查询失败对应字段置 null，不阻塞整体响应。
 * - handoff 不新增表、不落库，序号由现有表 count 确定性派生（同库态同序号）。
 * - M23c 小星记忆：已登录用户（token 命中 wbUsers）召回 persona='xingxing' 记忆
 *   注入 LLM prompt（仅作背景参考），应答后火忘式提炼写入；匿名访客不召回不写入
 *   （隐私红线）；记忆读写失败一律静默，绝不阻断客服主链。
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import { count, eq, sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { resolveWbUserByToken } from "./wbSession"; // portal#86 必修：双轨解析单点同引（明文直读退役）
import { callModelChat, callSlotChatFast, ensureProbed, getModelGatewayStatus } from "./modelGateway";
import { recordHarnessRun } from "../harness/ledger";
import { XINGXING_STYLE } from "./personaShared";
import { recallMemories, scheduleXingxingExtraction } from "./wbMemory";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";
import {
  agents,
  wbContracts,
  wbEvoPlans,
  wbFactories,
  wbListings,
} from "@db/schema"; // wbUsers 摘（portal#86：双轨单点后零消费[TS6133]）

// ─── 输入 ────────────────────────────────────────────────────────────────────
const optionalToken = z.string().trim().min(1).max(128).optional();
const optionalPath = z.string().trim().max(256).optional();

const welcomeInput = z.object({ token: optionalToken, path: optionalPath });
const askInput = z.object({
  token: optionalToken,
  message: z.string().trim().min(1).max(1000),
  path: optionalPath,
  sessionId: z.string().trim().max(64).optional(),
});
const handoffInput = z.object({
  token: optionalToken,
  message: z.string().trim().max(1000).optional(),
  contact: z.string().trim().max(128).optional(),
});

// ─── 匿名降级身份解析（token 无效 → null，不抛错）────────────────────────────
// 已登录用户身份载体：token（仅请求体）→ wbUsers.authToken 命中即已登录；
// userId/factoryId 直接取自 wbUsers/wbFactories 行——小星记忆（persona='xingxing'）的归属键。
export interface AssistantIdentity {
  displayName: string;
  enterpriseName: string;
  role: string;
  /** 已登录工作台用户 id（wb_users.id）——小星记忆归属人 */
  userId: number;
  /** 所属企业 id（wb_factories.id）——记忆企业隔离 */
  factoryId: number;
}

export async function resolveIdentity(token?: string): Promise<AssistantIdentity | null> {
  if (!token) return null;
  try {
    const db = getDb();
    const user = await resolveWbUserByToken(db, token); // portal#86 必修：明文直读→双轨单点（指纹迁移行可读面封死）
    if (!user) return null;
    const [factory] = await db
      .select()
      .from(wbFactories)
      .where(eq(wbFactories.id, user.factoryId))
      .limit(1);
    if (!factory) return null;
    return {
      displayName: user.displayName,
      enterpriseName: factory.enterpriseName,
      role: user.role,
      userId: user.id,
      factoryId: factory.id,
    };
  } catch {
    return null; // 库不可用同样降级匿名
  }
}

// ─── cs_config（运营中心可配置客服文案；30s 内存缓存；无配置用现有默认）─────
export interface CsConfig {
  welcome: string;
  personaPrompt: string;
  handoffHint: string;
}

let csConfigCache: { at: number; cfg: CsConfig | null } = { at: 0, cfg: null };

/** 读取 cs_config（id=1）；表缺失/库不可用/无配置一律返回 null，绝不阻断客服 */
export async function loadCsConfig(): Promise<CsConfig | null> {
  if (Date.now() - csConfigCache.at < 30_000) return csConfigCache.cfg;
  let cfg: CsConfig | null = null;
  try {
    const result = await getDb().execute(
      sql`SELECT welcome, persona_prompt, handoff_hint FROM cs_config WHERE id = 1 LIMIT 1`,
    );
    const rows = (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) as Array<
      Record<string, unknown>
    >;
    const row = rows?.[0];
    if (row) {
      cfg = {
        welcome: row.welcome ? String(row.welcome) : "",
        personaPrompt: row.persona_prompt ? String(row.persona_prompt) : "",
        handoffHint: row.handoff_hint ? String(row.handoff_hint) : "",
      };
    }
  } catch {
    cfg = null;
  }
  csConfigCache = { at: Date.now(), cfg };
  return cfg;
}

/** saveCsConfig 后调用：立即失效缓存（opsCenter 使用） */
export function invalidateCsConfigCache(): void {
  csConfigCache = { at: 0, cfg: null };
}

// ─── 业务统计（只读 count，单表失败置 null 不阻塞）───────────────────────────
export interface AssistantStats {
  agents: number | null;
  wbListings: number | null;
  wbContracts: number | null;
  wbEvoPlans: number | null;
}

async function safeCount(run: () => Promise<number>): Promise<number | null> {
  try {
    return await run();
  } catch {
    return null;
  }
}

// v157c：loadStats 快照缓存（60s TTL）——实测该函数 5.2s 慢查询是 ask 首字 SLA 元凶
let statsCache: { at: number; data: AssistantStats } | null = null;
export async function loadStats(): Promise<AssistantStats> {
  if (statsCache && Date.now() - statsCache.at < 60_000) return statsCache.data;
  const data = await loadStatsUncached();
  statsCache = { at: Date.now(), data };
  return data;
}
async function loadStatsUncached(): Promise<AssistantStats> {
  const db = getDb();
  const [agentsCount, listingsCount, contractsCount, plansCount] = await Promise.all([
    safeCount(async () => {
      const [row] = await db.select({ c: count() }).from(agents);
      return row.c;
    }),
    safeCount(async () => {
      const [row] = await db
        .select({ c: count() })
        .from(wbListings)
        .where(eq(wbListings.status, "listed"));
      return row.c;
    }),
    safeCount(async () => {
      const [row] = await db.select({ c: count() }).from(wbContracts);
      return row.c;
    }),
    safeCount(async () => {
      const [row] = await db.select({ c: count() }).from(wbEvoPlans);
      return row.c;
    }),
  ]);
  return {
    agents: agentsCount,
    wbListings: listingsCount,
    wbContracts: contractsCount,
    wbEvoPlans: plansCount,
  };
}

// ─── 品牌知识库（静态确定性文案）────────────────────────────────────────────
const BRAND = "NumX Max";

function honestNote(): string {
  const gw = getModelGatewayStatus();
  return gw.configuredCount > 0
    ? `说明：当前客服由品牌知识库与业务检索确定性驱动；四大模型密钥已配置 ${gw.configuredCount}/${gw.totalCount}（未联网验证），本次回答未调用模型生成。`
    : "说明：当前客服由品牌知识库与业务检索确定性驱动，四大模型服务尚未接入，回答不涉及自由生成。";
}

const GUIDE = [
  {
    title: "逛数字匠市 · 雇佣数字员工",
    desc: "在数字匠市浏览老师傅经验封装的技能与数字员工，支持试用、签约与按单结算。",
    to: "/market",
  },
  {
    title: "登录或注册智能工作台",
    desc: "注册企业画像、创建部门与成员账号，登录后进入属于你的智能工作台。",
    to: "/wb/login",
  },
  {
    title: "一键 SSO 跳转工作台",
    desc: "已登录用户可从匠市一键签发一次性跳转票据，免密直达工作台落地页。",
    to: "/workbench",
  },
  {
    title: "进化中枢 · 查看自主调度",
    desc: "数字员工自主规划任务排程，关键计划经 30 秒人工确认门后执行，全程可追溯。",
    to: "/wb/evolution",
  },
] as const;

const QUICK_PROMPTS = [
  "NumX Max 是做什么的？",
  "我是新用户，怎么注册并进入工作台？",
  "数字匠市怎么雇佣数字员工？",
  "怎么一键跳转到智能工作台？",
  "任务执行台怎么下达任务？",
  "进化中枢的 30 秒人工确认是什么？",
  "工业 Token 积分怎么计费？",
  "支持语音对话吗？",
  "如何申请人工接管？",
] as const;

function buildCapabilities() {
  const gw = getModelGatewayStatus();
  return {
    llmConfigured: gw.configuredCount > 0,
    llmConfiguredCount: gw.configuredCount,
    llmTotalCount: gw.totalCount,
    llmVerifiedCount: gw.verifiedCount,
    // 有任一家联网验证通过即为 true（诚实：反映真实验证状态）
    llmConnected: gw.verifiedCount > 0,
    voice: "browser",
    realtimeVoice: "browser-if-available",
  } as const;
}

// ─── 意图路由（关键词确定性匹配，规则自上而下命中即停）──────────────────────
export type IntentId =
  | "device"
  | "greeting"
  | "handoff"
  | "pricing"
  | "voice"
  | "evolution"
  | "task"
  | "sso"
  | "hire"
  | "onboarding"
  | "brand"
  | "fallback";

interface IntentRule {
  id: IntentId;
  keywords: string[];
}

const INTENT_RULES: IntentRule[] = [
  // v158：问候/寒暄意图（彭总实锤：「你好」误落 fallback→LLM 导航走歪「打开数字人」）
  { id: "greeting", keywords: ["你好", "您好", "在吗", "在么", "hi", "hello", "早上好", "下午好", "晚上好", "嗨", "喂"] },
  // v161 物理 MCP 直调（语音使唤设备）
  { id: "device", keywords: ["打印", "读数", "传感器", "开闸", "锁门", "截图", "设备"] },
  { id: "evolution", keywords: ["进化", "自主", "调度", "30 秒", "30秒", "确认门", "信任等级", "反思"] },
  { id: "handoff", keywords: ["人工接管", "转人工", "真人", "接管", "客服介入"] },
  { id: "pricing", keywords: ["价格", "收费", "计费", "多少钱", "token", "积分", "结算", "报价"] },
  { id: "voice", keywords: ["语音", "说话", "朗读", "声音", "麦克风", "实时对话"] },
  { id: "task", keywords: ["任务", "下达", "执行台", "派单", "工单", "排产"] },
  { id: "sso", keywords: ["sso", "跳转", "免密", "票据", "ticket", "bridge", "一键"] },
  { id: "hire", keywords: ["雇佣", "试用", "签约", "匠市", "数字员工", "技能", "上架", "师傅"] },
  { id: "onboarding", keywords: ["注册", "登录", "新用户", "开户", "入门", "新手", "开始使用"] },
  { id: "brand", keywords: ["灵枢", "星云", "品牌", "介绍", "是什么", "做什么", "平台", "你是谁"] },
];

export function routeIntent(message: string): IntentId {
  const text = message.toLowerCase();
  for (const rule of INTENT_RULES) {
    if (rule.keywords.some((k) => text.includes(k.toLowerCase()))) {
      return rule.id;
    }
  }
  return "fallback";
}

// ─── 各意图确定性回答 ────────────────────────────────────────────────────────
export interface AskResult {
  answer: string;
  suggestions: string[];
  links: { label: string; to: string }[];
  speak: string;
  intent: IntentId;
  stats?: AssistantStats;
  llmUsed: boolean;
  generatedBy: { provider: string; label: string; model: string } | null;
}

function statsLine(stats: AssistantStats): string {
  const fmt = (label: string, v: number | null) =>
    v === null ? `${label} 暂不可查` : `${label} ${v}`;
  return `当前平台实况：${fmt("数字员工", stats.agents)}，${fmt("在售上架", stats.wbListings)}，${fmt("合约", stats.wbContracts)}，${fmt("进化计划", stats.wbEvoPlans)}。`;
}

function buildAnswerBase(
  intent: IntentId,
  identity: AssistantIdentity | null,
  stats: AssistantStats,
  cs?: CsConfig | null,
): Omit<AskResult, "llmUsed" | "generatedBy"> {
  const greet = identity ? `${identity.displayName}（${identity.enterpriseName}），` : "";
  switch (intent) {
    case "greeting":
      return {
        intent,
        answer: `${greet}你好！我是灵枢，你的数字劳动力搭子。有什么活儿尽管吩咐——查资料、写方案、派任务、逛匠市都行。`,
        suggestions: ["你能干什么？", "怎么雇佣数字员工？", "去工作台看看"],
        links: [],
        speak: `${greet}你好！我是灵枢，有什么活儿尽管吩咐我。`,
        stats,
      };
    case "brand":
      return {
        intent,
        answer:
          `${greet}${BRAND}是工业数字劳动力市场 + 智能工作台：一端连接企业的真实生产需求，一端连接可雇佣的数字员工与老师傅沉淀的经验技能。` +
          `企业可以在数字匠市挑选、试用、签约数字员工，在智能工作台下达任务、查看执行，再由进化中枢驱动数字员工自主规划与持续成长。` +
          `${statsLine(stats)}${honestNote()}`,
        suggestions: ["怎么雇佣数字员工？", "新用户怎么开始？", "进化中枢是什么？"],
        links: [
          { label: "逛数字匠市", to: "/market" },
          { label: "了解定价", to: "/pricing" },
          { label: "平台架构", to: "/architecture" },
        ],
        speak: `${BRAND}是工业数字劳动力市场加智能工作台，连接企业、数字员工与老师傅经验。`,
        stats,
      };
    case "onboarding":
      return {
        intent,
        answer:
          `${greet}新用户三步上手：1）在登录页注册企业画像并创建成员账号；2）登录后进入智能工作台，完善部门与岗位编制；` +
          `3）回到数字匠市雇佣数字员工并签约，即可在任务执行台下达任务。支持从匠市一键 SSO 免密跳转工作台。${honestNote()}`,
        suggestions: ["怎么一键跳转工作台？", "怎么雇佣数字员工？", "工作台里能做什么？"],
        links: [
          { label: "登录 / 注册工作台", to: "/wb/login" },
          { label: "先去逛匠市", to: "/market" },
        ],
        speak: "注册企业账号，登录智能工作台，再从匠市雇佣数字员工，三步即可开工。",
      };
    case "hire":
      return {
        intent,
        answer:
          `${greet}在数字匠市雇佣数字员工走两段式流程：先浏览在售上架（技能或数字员工，均来自老师傅经验封装），可发起试用；` +
          `满意后提交签约，合约状态为待确认，经企业方确认后转为生效。价格以工业 Token 积分按上架标价结算。` +
          `${statsLine(stats)}${honestNote()}`,
        suggestions: ["签约后怎么下达任务？", "工业 Token 积分怎么计费？", "有哪些在售上架？"],
        links: [
          { label: "进入数字匠市", to: "/market" },
          { label: "查看定价规则", to: "/pricing" },
        ],
        speak: "在匠市挑选数字员工，先试用再签约，确认生效后即可下达任务。",
        stats,
      };
    case "sso":
      return {
        intent,
        answer:
          `${greet}已登录工作台的用户可使用一键 SSO：服务端签发一次性跳转票据（限时有效、仅用一次），` +
          `前端整页跳转到工作台桥接页完成免密登录并落到目标页面（部门、仪表盘、市场等落地页）。票据仅在签发响应中出现一次。${honestNote()}`,
        suggestions: ["还没账号怎么注册？", "工作台里能做什么？"],
        links: [
          { label: "了解跳转入口", to: "/workbench" },
          { label: "登录工作台", to: "/wb/login" },
        ],
        speak: "一键 SSO 会签发一次性限时票据，免密跳转到你的智能工作台。",
      };
    case "task":
      return {
        intent,
        answer:
          `${greet}在智能工作台的任务执行台下达任务：选择已签约生效的数字员工，填写任务目标、交付要求与期限后提交；` +
          `数字员工按计划执行并回写进度，你可在执行台跟踪状态与验收结果。关键排程也可交由进化中枢自主规划。${honestNote()}`,
        suggestions: ["进化中枢怎么自主排程？", "怎么雇佣数字员工？"],
        links: [
          { label: "打开任务执行台", to: "/wb/tasks" },
          { label: "查看工作台仪表盘", to: "/wb/dashboard" },
        ],
        speak: "在任务执行台选择数字员工，填写目标与期限并提交，即可跟踪执行与验收。",
      };
    case "evolution":
      return {
        intent,
        answer:
          `${greet}进化中枢是数字员工的自主调度引擎：它基于记忆与反思为数字员工生成执行计划。` +
          `默认每个计划进入 30 秒人工确认门——超时未确认即自动拒绝，确认后才进入执行；` +
          `随着连续审批通过累积信任等级，高信任等级的例行计划可免确认自动执行，全程留痕可追溯。${honestNote()}`,
        suggestions: ["信任等级怎么提升？", "任务执行台怎么用？"],
        links: [
          { label: "打开进化中枢", to: "/wb/evolution" },
          { label: "了解生命周期", to: "/lifecycle" },
        ],
        speak: "进化中枢自主生成计划，默认经 30 秒人工确认门，超时自动拒绝，确认后执行。",
      };
    case "pricing":
      return {
        intent,
        answer:
          `${greet}${BRAND}统一使用工业 Token 积分计价：它是平台内部的工业结算积分，用于支付数字员工劳务与老师傅经验分成，按上架标价与合约据实结算，` +
          `不具备任何投机属性，也不面向个人发行。具体单价与分成比例以定价页与各上架标价为准。${honestNote()}`,
        suggestions: ["怎么雇佣数字员工？", "老师傅分成怎么算？"],
        links: [
          { label: "查看定价页", to: "/pricing" },
          { label: "逛数字匠市", to: "/market" },
        ],
        speak: "平台统一用工业 Token 积分计价，用于支付数字员工劳务与老师傅分成，按合约据实结算。",
      };
    case "voice":
      return {
        intent,
        answer:
          `${greet}语音能力由浏览器端提供：回答可通过浏览器语音合成朗读，若前端已接入浏览器语音识别，也支持语音输入；` +
          `实时语音对话同样取决于浏览器与前端支持情况（browser-if-available）。服务端不额外提供语音通道。${honestNote()}`,
        suggestions: ["NumX Max 能做什么？", "怎么联系人工？"],
        links: [{ label: "返回首页体验", to: "/" }],
        speak: "语音朗读与识别由浏览器能力提供，若前端支持即可使用。",
      };
    case "handoff": {
      const hint = cs?.handoffHint?.trim();
      return {
        intent,
        answer:
          `${greet}${hint ? `${hint}` : "可以申请人工接管：流程为两段式——客服先即时响应并登记你的诉求，人工专员复核后再跟进处理。"}` +
          `请留下问题描述与联系方式（如企业名称或邮箱），我会为你生成登记单号。${honestNote()}`,
        suggestions: ["帮我登记人工接管", "继续咨询其他问题"],
        links: [{ label: "查看平台架构", to: "/architecture" }],
        speak: "可以申请人工接管，客服先登记，人工复核后跟进。",
      };
    }
    default:
      return {
        intent: "fallback",
        answer:
          `${greet}我是${BRAND}智能客服，可以解答品牌介绍、注册登录、匠市雇佣、SSO 跳转、任务下达、进化中枢、Token 积分计价与人工接管等问题。` +
          `你可以换个说法再问，或从下方建议中选择。${honestNote()}`,
        suggestions: [...QUICK_PROMPTS.slice(0, 4)],
        links: [
          { label: "逛数字匠市", to: "/market" },
          { label: "登录工作台", to: "/wb/login" },
        ],
        speak: "我是 NumX Max 智能客服，可以解答品牌、雇佣、工作台与计价等问题。",
      };
  }
}

/** 确定性回答统一出口：补齐 LLM 元数据字段（确定性路径恒为未使用）。 */
export function buildAnswer(
  intent: IntentId,
  identity: AssistantIdentity | null,
  stats: AssistantStats,
  cs?: CsConfig | null,
): AskResult {
  const result = buildAnswerBase(intent, identity, stats, cs);
  return { ...result, llmUsed: false, generatedBy: null };
}

// ─── LLM 联网生成（失败静默回退确定性路由；提示词不含金融/社交词汇）─────────
// 默认人格：小星（灵枢派驻数字匠市的前台分身，人格原文见 personaShared.XINGXING_STYLE）；
// cs_config.personaPrompt 仍可覆盖（见 buildAssistantSystemPrompt，运营配置优先）。
const LLM_SYSTEM_PROMPT = [
  XINGXING_STYLE,
  "核心事实：数字匠市支持浏览在售上架、试用、签约（两段式，签约后待企业确认生效）；统一用工业 Token 积分按上架标价据实结算（平台内部工业结算积分，无投机属性）；已登录用户可一键 SSO 免密跳转工作台；任务执行台可选择已签约数字员工下达任务并跟踪验收；进化中枢为数字员工自主规划排程，默认经 30 秒人工确认门（超时自动拒绝），连续审批累积信任等级后例行计划可免确认，全程留痕。",
  // v167 缓存稳定前缀块：以下为静态平台知识（全为已上线真实规则），拉长稳定前缀以提升 DeepSeek 上下文缓存命中率（网关实测 64 token 粒度块缓存）；易变内容（身份/实况/记忆）一律后置在 user 消息，勿入此块
  "平台知识：NumX Max 由 Nebula Harness 组织智能体运行时驱动，四端为灵枢超级APP（个人版/企业版）、智能工作台（Windows 桌面端与网页版）、数字员工超市（门户）、灵枢超级终端（管理员）。个人版：首页免费领取第一位数字分身（小灵枢），装扮间可穿技能职业装（客服/导购/财税/巡检，29~39 词元）、工具（文档/表格生成器，19 词元）、皮肤（海洋蓝/紫罗兰，9 词元）；工作台可派实习单（每日最多 3 单），实习合格（评分细则命中≥60%）才计验收；完成实习≥10 单且雇主评分≥4.2 才可申请上架超市（硬闸，月租自 99 元起）；在职满 2 个月且评分≥4.0 解锁新名额，每人最多 10 个分身，评分低于 3.5 的名额冻结冷却 30 天。企业版：造人工坊五模板造人（客服/导购/财税/巡检/自定义），喂经验、实习考核、行业类必经合规审查；企业店铺上架收租（月租自 299 元起）；厂牌评分低于 3.0 且砸牌≥3 次全厂降曝光（连坐）。注册时选性别：男用户灵枢男声称「兄弟」，女用户星云女声称「姐妹」。组织绑定须本人确认才生效，离职可解绑，信用随人。汇报总线每日最多 10 条，22:00-08:00 免打扰（告警除外）。",
  "回答规则：中文；专业温和；不超过 200 字；只基于以上事实与给到的平台实况数据，不得编造数字与功能；不得使用金融/社交词汇；不要自称人类；结尾不要加免责声明。",
  "寒暄纪律（v158）：用户纯打招呼（你好/在吗等）时只回问候，绝不输出导航/打开页面类动作——页面跳转建议只在用户明确问路时给。",
].join("\n");

/**
 * system prompt 拼装（单一出口，便于测试）：
 * 运营中心配置的客服人设（cs_config.personaPrompt）拼入前部、覆盖优先——
 * 小星（XINGXING_STYLE）只是默认人格，运营配置仍可压过它。
 */
export function buildAssistantSystemPrompt(cs?: CsConfig | null): string {
  const persona = cs?.personaPrompt?.trim();
  return persona ? `${persona}\n\n${LLM_SYSTEM_PROMPT}` : LLM_SYSTEM_PROMPT;
}

// ─── M23c 小星记忆（彭总指令「小星也要记得注册用户」）─────────────────────────
// 口径：仅已登录用户（identity 含 userId）召回/写入 persona='xingxing' 记忆；
// 匿名访客不召回也不写入——匿名不记不记得，隐私红线。
// 小星记忆与灵枢/星云按 persona 严格隔离（小星不偷看灵枢/星云的日记）。

/** 小星单次召回条数（注入 LLM userContent 的「你记得的这位用户的事」块） */
const XINGXING_RECALL_TOP_N = 5;

/**
 * 小星记忆召回：identity 无 userId（匿名）→ 直接空数组（不查库）。
 * 记忆底座故障（表未建/库抖动）静默降级为空——记忆是增强项，绝不阻断客服主链。
 */
export async function recallXingxingMemories(identity: AssistantIdentity | null): Promise<string[]> {
  if (!identity) return [];
  try {
    return await recallMemories(identity.factoryId, identity.userId, "xingxing", undefined, XINGXING_RECALL_TOP_N);
  } catch {
    return [];
  }
}

/**
 * 小星记忆写入：ask 应答成功后火忘式提炼（复用 scheduleMemoryExtraction 模式）。
 * 匿名（identity=null）不触发——没有 userId 可归属，且匿名不该被记住。
 */
export function rememberXingxing(identity: AssistantIdentity | null, userText: string, agentReply: string): void {
  if (!identity) return;
  void scheduleXingxingExtraction({
    factoryId: identity.factoryId,
    userId: identity.userId,
    userText,
    agentReply,
  });
}

/** ask 消息构建（单一出口：非流式 askWithLlm 与流式 askWithLlmStream 共用，防双写漂移） */
export function buildAskMessages(
  identity: AssistantIdentity | null,
  memories: string[],
  stats: AssistantStats,
  path: string | undefined,
  message: string,
  cs?: CsConfig | null,
): { role: "system" | "user"; content: string }[] {
  const systemPrompt = buildAssistantSystemPrompt(cs);
  const userContent = [
    identity ? `用户身份：${identity.displayName}（${identity.enterpriseName}，${identity.role}）。` : "用户身份：匿名访客。",
    memories.length > 0
      ? `你记得的这位用户的事（仅作背景参考，不主动复述除非相关）：\n${memories.map((m) => `- ${m}`).join("\n")}`
      : "",
    statsLine(stats),
    path ? `当前页面：${path}。` : "",
    `用户问题：${message}`,
  ].filter(Boolean).join("\n");
  // v157 快轨刀：交互问答 flash 槽优先（实测 705ms vs chat 2.4s），chat 竞速降级语义原样保留。
  // M59 原注：chat 槽走双通道竞速（主+备同发取先回，败者中止）；竞速双败（抛错）时保持原降级语义——callModelChat 多提供方故障转移兜底不变。
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
}

/** v168 流式应答：stream:true 逐 token 经 onDelta 直推；流式未吐字失败 → 回落 askWithLlm 非流式全链（竞速/多提供方兜底原样） */
export async function askWithLlmStream(
  message: string,
  intent: IntentId,
  identity: AssistantIdentity | null,
  stats: AssistantStats,
  path: string | undefined,
  cs: CsConfig | null | undefined,
  memories: string[],
  onDelta: (delta: string) => void,
): Promise<(AskResult & { streamed?: boolean; firstTokenMs?: number }) | null> {
  const base = buildAnswer(intent, identity, stats, cs);
  const msgs = buildAskMessages(identity, memories, stats, path, message, cs);
  try {
    const { callSlotChatStream } = await import("./modelGateway");
    let acc = "";
    const r = await callSlotChatStream("flash", {
      messages: msgs,
      maxTokens: 380, // v167 时延刀口径（思维链预算随上限膨胀实测）
      temperature: 0.3,
      // v168 流式棒交 DeepSeek Flash：kimi-k3 流式经网关 30s 卡死（产线实锤），flash 实测首字 1.2-2.5s；
      // 顺序降级链原样（flash 未吐字失败才换槽），超时收紧 12s 让降级更快介入
      modelOverride: "deepseek-v4-flash",
      timeoutMs: 12_000,
      context: "assistant_ask_stream",
    }, (delta) => {
      acc += delta;
      onDelta(delta);
    });
    if (r.ok && acc.trim()) {
      const answer = acc.trim().slice(0, 400);
      return {
        ...base, answer, speak: answer.slice(0, 80), llmUsed: true,
        generatedBy: { provider: r.provider ?? "", label: r.providerLabel ?? "", model: r.model ?? "" },
        streamed: true, firstTokenMs: r.firstTokenMs,
      };
    }
    if (acc.trim()) {
      // 吐过字但断流：已推内容有效，如实收口（不再重复全量推）
      const answer = acc.trim().slice(0, 400);
      return {
        ...base, answer, speak: answer.slice(0, 80), llmUsed: true,
        generatedBy: { provider: r.provider ?? "", label: r.providerLabel ?? "", model: r.model ?? "" },
        streamed: true, firstTokenMs: r.firstTokenMs,
      };
    }
  } catch {
    // 流式异常 → 落非流式
  }
  const full = await askWithLlm(message, intent, identity, stats, path, cs ?? null, memories);
  return full ? { ...full, streamed: false } : null;
}

async function askWithLlm(
  message: string,
  intent: IntentId,
  identity: AssistantIdentity | null,
  stats: AssistantStats,
  path?: string,
  cs?: CsConfig | null,
  memories: string[] = [],
): Promise<AskResult | null> {
  const base = buildAnswer(intent, identity, stats, cs); // 复用 suggestions/links 兜底
  const msgs = buildAskMessages(identity, memories, stats, path, message, cs);
  const fastRes = await callSlotChatFast("flash", {
    messages: msgs,
    // v167 时延刀：600→380（产线实测思维链预算随 max_tokens 膨胀：600→2.7s/117tok 推理，350→1.2s/38tok 且 finish=stop 完整收口；回答规则本身限 200 字≈300 token，380 留足余量）
    maxTokens: 380,
    temperature: 0.3,
    timeoutMs: 20_000,
    context: "assistant_ask",
  }).catch(() => null);
  // v167 缓存命中观测：命中率=命中/(命中+未命中)，为前缀稳定化收益提供产线真账
  if (fastRes && fastRes.ok && ((fastRes.cacheHitTokens ?? 0) + (fastRes.cacheMissTokens ?? 0)) > 0) {
    const hit = fastRes.cacheHitTokens ?? 0;
    const miss = fastRes.cacheMissTokens ?? 0;
    console.info(`[ask-prof] cache: hit=${hit} miss=${miss} rate=${Math.round((hit / (hit + miss)) * 100)}%`);
  }
  // Fast 正常 resolve 时 ok 恒真；显式再判 ok 是为保持「槽失败→多提供方转移」的原降级形态
  const res = fastRes && fastRes.ok
    ? fastRes
    : await callModelChat({
        messages: msgs,
        maxTokens: 600,
        temperature: 0.3,
        timeoutMs: 20_000,
      });
  recordHarnessRun({ tier: "interactive", lane: "assistant_ask", ok: !!(res.ok && res.content), durationMs: 0 });
  if (!res.ok || !res.content) return null; // 静默回退确定性
  return {
    ...base,
    answer: res.content,
    speak: res.content.slice(0, 80),
    llmUsed: true,
    generatedBy: { provider: res.provider ?? "", label: res.providerLabel ?? "", model: res.model ?? "" },
  };
}

// ─── 迭代 28：客服访客信息回传（cs_sessions / cs_messages，fire-and-forget）──
/** 从 ctx.req（fetch Request）提取客户端 IP / UA；拿不到按空串处理 */
function ctxIpUa(ctx: unknown): { ip: string; ua: string } {
  try {
    const headers = (ctx as { req?: { headers?: Headers } }).req?.headers;
    const rawIp = (ctx as { clientIp?: unknown }).clientIp;
    const ip = typeof rawIp === "string" ? rawIp : "";
    const ua = headers?.get?.("user-agent") ?? "";
    return { ip, ua };
  } catch {
    return { ip: "", ua: "" };
  }
}

/** 记录一次 ask 会话：upsert cs_sessions + 写 user/bot 两条 cs_messages（全部静默 catch） */
export function recordCsAsk(entry: {
  sessionId?: string;
  ip: string;
  ua: string;
  userContent: string;
  intent: string;
  botContent: string;
}): void {
  void (async () => {
    try {
      const sessionKey =
        entry.sessionId && entry.sessionId.length > 0
          ? entry.sessionId
          : `anon-${createHash("sha256").update(`${entry.ip}|${entry.ua}`).digest("hex").slice(0, 16)}`;
      const db = getDb();
      await db.execute(
        sql`INSERT INTO cs_sessions (session_key, ip, ua, msg_count)
            VALUES (${sessionKey}, ${entry.ip.slice(0, 64)}, ${entry.ua.slice(0, 255)}, 2)
            ON DUPLICATE KEY UPDATE
              last_at = CURRENT_TIMESTAMP, msg_count = msg_count + 2,
              ip = VALUES(ip), ua = VALUES(ua)`,
      );
      await db.execute(
        sql`INSERT INTO cs_messages (session_key, role, content, intent)
            VALUES (${sessionKey}, 'user', ${entry.userContent}, ${entry.intent})`,
      );
      await db.execute(
        sql`INSERT INTO cs_messages (session_key, role, content, intent)
            VALUES (${sessionKey}, 'bot', ${entry.botContent}, NULL)`,
      );
    } catch {
      // 表缺失/写入失败：静默
    }
  })();
}

/** v161 设备意图直调：匹配本厂 MCP 工具目录，B 级真下发，C 级引导双签（确定性，不问模型） */
export async function dispatchDeviceIntent(message: string, factoryId: number): Promise<AskResult | null> {
  const rows = rawRows(
    await getDb().execute(sql`SELECT device_id AS deviceId, manifest FROM st_device_mcp WHERE factory_id=${factoryId} AND status='online'`),
  );
  if (rows.length === 0) return null;
  const { capOfTool } = await import("./deviceMcp");
  for (const r of rows) {
    let manifest: { tools?: { name: string; desc: string; level: string }[] } | null = null;
    const raw = r.manifest;
    manifest = typeof raw === "object" && raw !== null ? (raw as never) : null;
    if (!manifest) { try { manifest = JSON.parse(String(raw)); } catch { continue; } }
    for (const t of manifest?.tools ?? []) {
      const hit = message.includes(t.desc) || message.includes(t.name) || (t.name.includes("print") && message.includes("打印")) || (t.name.includes("sensor") && (message.includes("读数") || message.includes("传感器")));
      if (!hit) continue;
      const { level } = capOfTool(t.name);
      if (level === "C" || t.level === "C") {
        return {
          intent: "device",
          answer: `设备 ${String(r.deviceId)} 的「${t.desc}」是 C 级能力，需要双签票据才能下发。请到超级终端开票后再使唤。`,
          suggestions: [], links: [], speak: "这个操作需要双签票据，请到超级终端开票。",
          llmUsed: false, generatedBy: null,
        };
      }
      const ins = await getDb().execute(
        sql`INSERT INTO st_device_commands (device_id, factory_id, cap, payload, status, client_key)
            SELECT s.id, ${factoryId}, ${capOfTool(t.name).cap}, ${JSON.stringify({ _mcp_tool: t.name, _from: "assistant" })}, 'pending', ${`voice-${String(r.deviceId)}-${t.name}`}
            FROM st_devices s WHERE s.factory_id=${factoryId} AND s.name LIKE ${`%${String(r.deviceId).slice(-8)}`} LIMIT 1`,
      );
      const ok = Number((Array.isArray(ins) ? ins[0] : ins as { affectedRows?: number })?.affectedRows ?? 0) > 0;
      return {
        intent: "device",
        answer: ok ? `已下发：让设备执行「${t.desc}」。执行结果会推送汇报给你。` : "设备登记册里没找到这台，请先在扫一扫里完成接管。",
        suggestions: [], links: [],
        speak: ok ? `已下发，${t.desc}` : "设备未完成接管。",
        llmUsed: false, generatedBy: null,
      };
    }
  }
  return null;
}

// ─── 路由 ────────────────────────────────────────────────────────────────────
export const assistantRouter = createRouter({
  /**
   * welcome（query，token 可选）：品牌欢迎语 + 引导 + 快捷提问 + 能力声明 + 实况统计。
   * 输出 { brand, welcome, guide, quickPrompts, capabilities, stats }
   */
  welcome: publicQuery.input(welcomeInput).query(async ({ input }) => {
    await ensureProbed();
    const identity = await resolveIdentity(input.token);
    const stats = await loadStats();
    const cs = await loadCsConfig();
    const configuredWelcome = cs?.welcome?.trim();
    const welcome = configuredWelcome
      ? configuredWelcome
      : identity
        ? `${identity.displayName}，欢迎回到${BRAND}！这里是工业数字劳动力市场与智能工作台：连接企业、数字员工与老师傅经验。我可以带你逛匠市、讲清雇佣与任务流程，也可以帮你跳转工作台。`
        : `欢迎来到${BRAND}！这里是工业数字劳动力市场 + 智能工作台：连接企业真实需求、可雇佣的数字员工，以及老师傅沉淀的经验技能。我可以介绍平台、带你注册登录、讲解雇佣与任务流程。`;
    return {
      brand: BRAND,
      welcome,
      guide: GUIDE.map((g) => ({ ...g })),
      quickPrompts: [...QUICK_PROMPTS],
      capabilities: buildCapabilities(),
      stats,
    };
  }),

  /**
   * ask（mutation，token 可选）：确定性意图路由 + 业务数据检索。
   * 输出 { answer, suggestions, links, speak, intent, stats? }
   */
  ask: publicQuery.input(askInput).mutation(async ({ input, ctx }) => {
    const t0 = Date.now();
    const lap = (tag: string) => console.info(`[ask-prof] ${tag}: ${Date.now() - t0}ms`);
    const identity = await resolveIdentity(input.token);
    lap("identity");
    const stats = await loadStats();
    lap("stats");
    const cs = await loadCsConfig();
    lap("cs");
    const intent = routeIntent(input.message);
    // 迭代 28：响应返回后 fire-and-forget 记录访客会话（cs_sessions/cs_messages）
    const { ip, ua } = ctxIpUa(ctx);
    const log = (answer: string) =>
      recordCsAsk({
        sessionId: input.sessionId,
        ip,
        ua,
        userContent: input.message,
        intent,
        botContent: answer,
      });
    // v161 物理 MCP 直调：device 意图先查本厂工具目录，有匹配 B 级工具则真下发
    if (intent === "device" && identity) {
      const r = await dispatchDeviceIntent(input.message, identity.factoryId);
      if (r) {
        lap("device-mcp");
        log(r.answer);
        return r;
      }
    }
    // handoff 为事务性登记，保持确定性；greeting 全确定性直通（v158：寒暄绝不问模型——防导航走歪复发）
    if (intent === "greeting") {
      const r = buildAnswer(intent, identity, stats, cs);
      lap("greeting-direct");
      log(r.answer);
      return r;
    }
    // 其余意图优先 LLM 生成，失败静默回退
    if (intent !== "handoff") {
      // M23c：已登录用户召回小星记忆注入 prompt（匿名不召回——隐私红线）
      const memories = await recallXingxingMemories(identity);
      lap("recall");
      const llm = await askWithLlm(input.message, intent, identity, stats, input.path, cs, memories);
      lap("llm");
      if (llm) {
        log(llm.answer);
        rememberXingxing(identity, input.message, llm.answer); // M23c 火忘提炼，匿名不写
        return llm;
      }
    }
    const fallback = { ...buildAnswer(intent, identity, stats, cs), llmUsed: false, generatedBy: null };
    log(fallback.answer);
    rememberXingxing(identity, input.message, fallback.answer); // 确定性应答同样提炼（含 handoff 登记）
    return fallback;
  }),

  /**
   * handoff（mutation，token 可选）：人工接管真实登记（iter97 起真实落库 st_handoff_tickets）。
   * 单号 = 真实工单 id（HD-<六位id>）；失败兜底仍返回受理文案但标注登记异常。
   */
  handoff: publicQuery.input(handoffInput).mutation(async ({ input }) => {
    const cs = await loadCsConfig();
    let ticket = "";
    try {
      const res = await getDb().execute(
        sql`INSERT INTO st_handoff_tickets (session_id, message, contact, status) VALUES (${input.token ? "wb" : "anon"}, ${input.message ?? null}, ${input.contact ?? null}, 'open')`,
      );
      const id = Number(
        ((res as unknown as Array<{ insertId?: number | string }>)[0] as { insertId?: number | string } | undefined)?.insertId ?? 0,
      );
      ticket = `HD-${String(id).padStart(6, "0")}`;
    } catch {
      ticket = "HD-PENDING";
    }
    const hint = cs?.handoffHint?.trim();
    const real = ticket !== "HD-PENDING";
    return {
      ok: true as const,
      ticket,
      message: real
        ? hint
          ? `${hint}（工单 ${ticket} 已真实受理：客服先响应，人工复核后跟进）`
          : `已受理人工接管请求（工单 ${ticket}：客服先响应，人工复核后跟进）`
        : "人工接管登记暂时异常，请稍后再试或直接联系平台客服",
    };
  }),
});
