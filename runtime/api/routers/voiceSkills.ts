/**
 * voiceSkills —— M20 波 1：语音技能路由层（灵枢/星云看得到、调得动技能池）。
 *
 * 三层路由中的「技能层」（A 级，免确认、不改企业状态）：
 * 1. 可见集 loadVisibleSkills：基础包（SKILL_EXECUTOR_MAP 20 个执行器技能，全员可用；
 *    语音可见集剔除 claw_browser_task，见 loadVisibleSkills 注释）
 *    + 已雇佣 Agent 的 skills 表技能（agent_hire_records active 且未过期）；
 * 2. 误判防护：LLM 给的 skillKey 必须 ∈ 可见集，服务端二次校验，不在集内降级 chat 人话说明；
 * 3. 执行：专用 6 技能走 executeSkillTool，通用 14 技能（含 M20 波 2 ppt_make/excel_report）
 *    + 雇佣专业技能走 executeGenericSkill；
 * 4. 记账+熔断：每次调用写 st_skill_calls（表未建静默不阻塞，同 st_llm_usage_daily 哲学），
 *    SKILL_DAILY_BUDGET（默认 500 次/企业/日）超限直接不执行；
 * 5. 文件投递：产出物复制到 dist/public/files/{48hex}.{ext}，返回 /files/ 相对链接，
 *    每次写入顺手 lazy 清理 24h 前文件。
 *
 * 安全纪律（与邀请码「明文一次」同哲学）：文件链接即凭证——无登录态可下载，但 48 位
 * 随机串不可猜测、serveStatic 不提供目录列表不可枚举、24h 过期。敏感文档登录态下载
 * 属二期欠债（见方案 §9）。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";
import {
  executeSkillTool,
  SKILL_TOOL_MAP,
  type ArtifactCtx,
  type ArtifactInfo,
  type MatchedSkill,
} from "./agentTools";
import { executeGenericSkill, SKILL_EXECUTOR_MAP } from "./skillExecutor";
import { screenText } from "./contentScreen";

// ─── 企业实况（voice.ts briefText 同源，抽取共用避免两处算法漂移）──────────────

/**
 * 组织实况一行文（复用 voiceBuddy.buildOrgBrief 口径）：
 * 语音开场白 / utterance 上下文 / M20 波 2 PPT·Excel 执行器数据源，全部共用本函数。
 */
export async function factoryBriefText(factoryId: number): Promise<string> {
  try {
    const { buildOrgBrief } = await import("./voiceBuddy");
    const b = await buildOrgBrief(factoryId);
    return (
      `【本厂实时实况】今日意图 ${b.todayIntents} 条，待确认 ${b.pendingConfirms} 条，` +
      `累计执行 ${b.executedTotal} 条；军团 ${b.deptCount} 部门 ${b.roleCount} 员；` +
      `冻结状态：${b.frozen ? "已冻结" : "正常"}。回答数字以此为准，禁止编造。`
    );
  } catch {
    return ""; // brief 失败不阻塞主流程：执行器按「无实况」降级（数据纪律仍禁止编造）
  }
}

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface VisibleSkill {
  skillKey: string;
  name: string;
  description: string;
  pricePerCall: number;
}

export interface VoiceSkillAttachment {
  kind: "file" | "text";
  url?: string;
  preview: string;
}

export type VoiceSkillOutcome =
  | { kind: "skill"; ok: true; reply: string; attachment?: VoiceSkillAttachment }
  | { kind: "skill"; ok: false; reply: string }
  | { kind: "too_many"; reply: string }
  | { kind: "chat"; reply: string };

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** 注入 prompt 的技能清单上限（防 prompt 膨胀） */
export const VOICE_SKILL_PROMPT_CAP = 12;
/** 分槽配额：基础包前 8 条 + 雇佣技能前 4 条（雇佣优先排前），合计封顶 PROMPT_CAP。
 *  不分槽时 slice(0,12) 会被 18 条基础包挤满，agent_skill_* 永远进不了 prompt（不可达）。 */
export const VOICE_SKILL_BASE_SLOT = 8;
export const VOICE_SKILL_HIRED_SLOT = 4;
/** 基础包技能单次调用记账价（st_skills 无定价列，对齐 drizzle skills 表默认 100 Token） */
const BASE_SKILL_PRICE = 100;
/** 每日技能预算默认值（次/企业/日） */
const DEFAULT_SKILL_DAILY_BUDGET = 500;
/** 投递文件过期时间：24h */
const FILE_TTL_MS = 24 * 60 * 60 * 1000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** st_ 表查询兜底：表缺失/查询失败按空集降级（seed/迁移前的部署窗口） */
async function stRows(statement: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  try {
    return rawRows(await getDb().execute(statement));
  } catch {
    return [];
  }
}

function parseStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  try {
    const arr = JSON.parse(String(v ?? "[]")) as unknown;
    return Array.isArray(arr) ? arr.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

// ─── ① 技能可见集 ────────────────────────────────────────────────────────────

/**
 * loadVisibleSkills：基础包 20 个执行器技能全员可见（语音剔除 claw_browser_task 后 19 个）
 * + 已雇佣 Agent 的专业技能。
 * 雇佣口径沿用 wbToday/wbProfile 既有约定：agent_hire_records.enterpriseId 对齐
 * wb_factories.id（两表非同一域，按 factoryHealth 口径对齐统计）。
 * 雇佣技能无执行器映射，skillKey 取 `agent_skill_<skills.id>`，执行时走
 * executeGenericSkill 通用通道（未映射 key 自动降级 llm_analysis）。
 */
export async function loadVisibleSkills(factoryId: number): Promise<VisibleSkill[]> {
  const out: VisibleSkill[] = [];
  const seen = new Set<string>();

  // 基础包：st_skills 取名字/描述；表缺失时退化为仅有 key 的清单（名字即 key）。
  // 语音可见集剔除 claw_browser_task：浏览器任务虽只读但资源开销大（起浏览器/爬取
  // 页面，分钟级耗时），不适合语音免确认（A 级）触发，保留给文字/手工通道。
  const baseKeys = Object.keys(SKILL_EXECUTOR_MAP).filter((k) => k !== "claw_browser_task");
  const meta = new Map<string, { name: string; description: string }>();
  const rows = await stRows(
    sql`SELECT skill_key, name, description FROM st_skills WHERE status = 'active'`,
  );
  for (const r of rows) {
    meta.set(String(r.skill_key), {
      name: String(r.name ?? r.skill_key),
      description: String(r.description ?? ""),
    });
  }
  for (const key of baseKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const m = meta.get(key);
    out.push({
      skillKey: key,
      name: m?.name ?? key,
      description: m?.description ?? "",
      pricePerCall: BASE_SKILL_PRICE,
    });
  }

  // 已雇佣 Agent 的 skills 表技能（drizzle skills 表：169 技能/36 Agent，V/U 型）
  const hired = await stRows(
    sql`SELECT DISTINCT s.id, s.name, s.description, s.pricePerCall
        FROM skills s
        JOIN agent_hire_records h ON h.agentId = s.agentId
        WHERE h.enterpriseId = ${factoryId} AND h.status = 'active' AND h.endsAt > NOW()
        ORDER BY s.id LIMIT 50`,
  );
  for (const r of hired) {
    const skillKey = `agent_skill_${Number(r.id)}`;
    if (seen.has(skillKey)) continue;
    seen.add(skillKey);
    out.push({
      skillKey,
      name: String(r.name ?? skillKey),
      description: String(r.description ?? ""),
      pricePerCall: Number(r.pricePerCall ?? BASE_SKILL_PRICE) || BASE_SKILL_PRICE,
    });
  }

  // M38 自进化闭环：evo 提案批准落生的新技能（layer='evo'，通用执行器 llm_analysis 兜底执行）
  // —— 批准即上架，全厂可见；MCP 工具面 30s 缓存后自动出现（DSH 下一次任务可调）
  // M43：本厂 evo_opt_out=1 时进化段整体跳过（按厂开关；基础包/雇佣技能不受影响）
  const optRows = await stRows(sql`SELECT evo_opt_out AS v FROM wb_factories WHERE id = ${factoryId} LIMIT 1`);
  const evoOptOut = Number(optRows[0]?.v ?? 0) === 1;
  if (!evoOptOut) {
    const evoRows = await stRows(
      sql`SELECT skill_key, name, description FROM st_skills WHERE status = 'active' AND layer = 'evo' LIMIT 20`,
    );
    for (const r of evoRows) {
      const key = String(r.skill_key);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        skillKey: key,
        name: String(r.name ?? key),
        description: String(r.description ?? ""),
        pricePerCall: BASE_SKILL_PRICE,
      });
    }
  }

  // M48 插件仓层：超终装机的 store 插件技能（layer='store'），全厂可见、不受 evo 开关影响
  const storeRows = await stRows(
    sql`SELECT skill_key, name, description FROM st_skills WHERE status = 'active' AND layer = 'store' LIMIT 20`,
  );
  for (const r of storeRows) {
    const key = String(r.skill_key);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      skillKey: key,
      name: String(r.name ?? key),
      description: String(r.description ?? ""),
      pricePerCall: BASE_SKILL_PRICE,
    });
  }
  return out;
}

/**
 * prompt 注入块：名字 + 一句描述。分槽配额——基础包前 BASE_SLOT 条 + 雇佣技能前
 * HIRED_SLOT 条（雇佣优先排前），合计封顶 PROMPT_CAP 条防膨胀；
 * 保证雇佣技能（agent_skill_*）不被基础包挤占、始终可达 prompt。
 */
export function buildVisibleSkillBlock(skills: VisibleSkill[]): string {
  if (skills.length === 0) return "";
  const hired = skills.filter((s) => s.skillKey.startsWith("agent_skill_")).slice(0, VOICE_SKILL_HIRED_SLOT);
  const base = skills.filter((s) => !s.skillKey.startsWith("agent_skill_")).slice(0, VOICE_SKILL_BASE_SLOT);
  const lines = [...hired, ...base]
    .slice(0, VOICE_SKILL_PROMPT_CAP)
    .map((s) => `- ${s.skillKey}（${s.name}）：${clip(s.description || s.name, 60)}`);
  return `可办技能清单（skillKey 必须从此清单选，除此之外绝不捏造）：\n${lines.join("\n")}\n`;
}

// ─── ④ 记账 + 熔断 ───────────────────────────────────────────────────────────

function skillDailyBudget(): number {
  const n = Number(process.env.SKILL_DAILY_BUDGET);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SKILL_DAILY_BUDGET;
}

/** 内存兜底计数（DB 表未建/抖动时熔断仍然生效）：key = factoryId:YYYY-MM-DD */
const memDayCounts = new Map<string, number>();

function memDayKey(factoryId: number): string {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${factoryId}:${day}`;
}

/** 当日该 factory 已调用次数：DB 计数与内存兜底取大者（防丢未落库增量） */
export async function todaySkillCallCount(factoryId: number): Promise<number> {
  const rows = await stRows(
    sql`SELECT COUNT(*) AS c FROM st_skill_calls
        WHERE factory_id = ${factoryId} AND created_at >= CURDATE()`,
  );
  const dbCount = Number(rows[0]?.c ?? 0);
  const memCount = memDayCounts.get(memDayKey(factoryId)) ?? 0;
  return Math.max(Number.isFinite(dbCount) ? dbCount : 0, memCount);
}

/** 写调用记录：st_skill_calls（db/sync-m20.mts 建表）；失败静默，绝不阻塞主流程 */
async function recordSkillCall(opts: {
  factoryId: number;
  sessionId: number;
  user: string;
  skill: VisibleSkill;
  status: "ok" | "failed";
  note: string;
}): Promise<void> {
  const todayKey = memDayKey(opts.factoryId);
  memDayCounts.set(todayKey, (memDayCounts.get(todayKey) ?? 0) + 1);
  // 顺手 pruning：每次写入清理非当日 key（防跨日内存膨胀，一行级）
  for (const k of memDayCounts.keys()) if (!k.endsWith(todayKey.slice(todayKey.indexOf(":")))) memDayCounts.delete(k);
  try {
    await getDb().execute(
      sql`INSERT INTO st_skill_calls (factory_id, session_id, user, skill_key, skill_name, price, status, note)
          VALUES (${opts.factoryId}, ${opts.sessionId}, ${opts.user}, ${opts.skill.skillKey},
                  ${clip(opts.skill.name, 64)}, ${opts.skill.pricePerCall}, ${opts.status}, ${clip(opts.note, 255)})`,
    );
  } catch {
    // 迁移前表不存在或 DB 抖动：内存计数已兜底，静默
  }
}

// ─── ⑤ 文件安全投递 ──────────────────────────────────────────────────────────

function artifactDir(): string {
  return process.env.ST_ARTIFACT_DIR || path.resolve(process.cwd(), "data", "artifacts");
}

function filesDir(): string {
  return process.env.VOICE_FILES_DIR || path.resolve(process.cwd(), "dist", "public", "files");
}

/** lazy 清理：每次写文件时顺手删除 24h 前的投递文件（无定时任务依赖） */
async function sweepExpiredFiles(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir);
    const now = Date.now();
    for (const name of entries) {
      try {
        const p = path.join(dir, name);
        const st = await fs.stat(p);
        if (st.isFile() && now - st.mtimeMs > FILE_TTL_MS) await fs.unlink(p);
      } catch {
        /* 单文件失败不阻塞 */
      }
    }
  } catch {
    /* 目录不存在：静默 */
  }
}

/**
 * 投递产出物：复制到 files 目录，文件名 = 48 位随机 hex（链接即凭证：
 * 无登录态可下、不可枚举、24h lazy 过期）。失败返回 null（不影响文本回复）。
 */
export async function deliverArtifactFile(artifact: ArtifactInfo): Promise<string | null> {
  try {
    // basename 防御纵深：artifact.filename 来自执行器/DB，剥掉任何路径成分防目录穿越
    const src = path.join(artifactDir(), path.basename(artifact.filename));
    const ext = path.extname(artifact.filename).replace(/[^A-Za-z0-9.]/g, "") || ".bin";
    const dir = filesDir();
    await fs.mkdir(dir, { recursive: true });
    await sweepExpiredFiles(dir);
    const outName = `${crypto.randomBytes(24).toString("hex")}${ext}`;
    await fs.copyFile(src, path.join(dir, outName));
    return `/files/${outName}`;
  } catch {
    return null;
  }
}

// ─── ②③ 技能路由：可见性校验 → 执行 → 人话转述 ──────────────────────────────

/** 组装 MatchedSkill：基础包读 st_skills 五件套；雇佣技能用 name/description 最小五件套 */
async function buildMatchedSkill(skill: VisibleSkill): Promise<MatchedSkill> {
  const base: MatchedSkill = {
    skillKey: skill.skillKey,
    name: skill.name,
    category: "办公",
    slot: "chat",
    triggerHints: [],
    flowSteps: [],
    outputTemplate: "",
    qualityChecklist: [],
    score: 0,
    boost: 0,
  };
  if (skill.skillKey.startsWith("agent_skill_")) {
    base.category = "专业";
    if (skill.description) base.outputTemplate = `【${skill.name}】\n${skill.description}\n\n{成稿}`;
    return base;
  }
  const rows = await stRows(
    sql`SELECT category, slot, trigger_hints, flow_steps, output_template, quality_checklist
        FROM st_skills WHERE skill_key = ${skill.skillKey} LIMIT 1`,
  );
  const r = rows[0];
  if (!r) return base;
  return {
    ...base,
    category: String(r.category ?? base.category),
    slot: String(r.slot ?? "chat"),
    triggerHints: parseStrArray(r.trigger_hints),
    flowSteps: parseStrArray(r.flow_steps),
    outputTemplate: r.output_template == null ? "" : String(r.output_template),
    qualityChecklist: parseStrArray(r.quality_checklist),
  };
}

/**
 * runVoiceSkill：kind=skill 的路由执行。
 * - skillKey ∉ 可见集 → 降级 chat（人话说明，绝不执行）；
 * - 当日调用数 ≥ SKILL_DAILY_BUDGET → too_many（不执行、不记账）；
 * - 执行成功 → 人话摘要 + attachment（有文件给 /files/ 链接，否则文本预览）；
 * - 执行异常 → 兜底道歉（已记账 failed）。
 */
export async function runVoiceSkill(opts: {
  factoryId: number;
  sessionId: number;
  username: string;
  persona: "lingshu" | "xingyun";
  skillKey: string | undefined;
  text: string;
  visible: VisibleSkill[];
  stripSecrets: (t: string) => string;
}): Promise<VoiceSkillOutcome> {
  const skill = opts.visible.find((s) => s.skillKey === opts.skillKey);
  if (!skill) {
    return {
      kind: "chat",
      // 降级回复同样过 stripSecrets（技能名可能含敏感串，与成功 reply 对齐）
      reply: opts.stripSecrets(
        `老板，这件事我手头没有对应的技能可以办（可能未雇佣相关专业员工）。` +
          `我目前能办的有：${opts.visible.slice(0, 6).map((s) => s.name).join("、")}等。换个说法或先去匠市雇佣对应数字员工。`,
      ),
    };
  }

  // 成本闸门：超限不执行、不记账
  const used = await todaySkillCallCount(opts.factoryId);
  if (used >= skillDailyBudget()) {
    return { kind: "too_many", reply: "今日技能额度已用完，明早 6 点重置。急事可以先走手工流程。" };
  }

  const agentName = opts.persona === "lingshu" ? "灵枢" : "星云";
  const ctx: ArtifactCtx = {
    agentCode: `voice-${opts.persona}`,
    threadId: opts.sessionId,
    actor: `voice:${opts.username}`,
    channel: "staff",
  };

  try {
    const matched = await buildMatchedSkill(skill);
    let brief = "";
    let artifacts: ArtifactInfo[] = [];
    let degraded = false;

    if (SKILL_TOOL_MAP[skill.skillKey]) {
      // 6 个专用执行器（docx/xlsx/pptx/data/research/claw）
      const out = await executeSkillTool(matched, opts.text, ctx);
      if (!out) throw new Error("tool returned null");
      brief = out.brief;
      artifacts = out.artifacts;
    } else {
      // 通用执行器（llm_doc/llm_analysis/llm_kb_qa/llm_ppt/llm_sheet）+ 雇佣专业技能兜底通道。
      // M20 波 2：PPT/Excel 执行器需要 briefText 同源企业实况做数据源（禁止编造数字的纪律继承）。
      const officeKind = SKILL_EXECUTOR_MAP[skill.skillKey];
      const contextBrief =
        officeKind === "llm_ppt" || officeKind === "llm_sheet" ? await factoryBriefText(opts.factoryId) : undefined;
      const out = await executeGenericSkill({
        skill: matched,
        content: opts.text,
        agentName,
        factoryId: opts.factoryId,
        ctx,
        contextBrief,
      });
      brief = out.text;
      artifacts = out.artifact ? [out.artifact] : [];
      degraded = out.degraded === true;
    }

    // M44 安全：技能产出物投递前过内容初筛（brief+标题）；命中 → 不出文件，转人工口径
    const screened = screenText(`${brief}\n${artifacts.map((a) => a.title).join("\n")}`);
    if (!screened.ok) {
      await recordSkillCall({
        factoryId: opts.factoryId,
        sessionId: opts.sessionId,
        user: opts.username,
        skill,
        status: "failed",
        note: clip(`content-screened: ${opts.text}`, 120),
      });
      return {
        kind: "skill",
        ok: false,
        reply: opts.stripSecrets(`「${skill.name}」的产出命中平台安全规则，已转人工复审；复审通过后我再交付给你。`),
      };
    }

    // 文件投递：取第一个产出物给下载链接
    let attachment: VoiceSkillAttachment | undefined;
    if (artifacts.length > 0) {
      const url = await deliverArtifactFile(artifacts[0]!);
      // preview 全部过 stripSecrets（标题/brief 可能含敏感串，与 reply 对齐）
      attachment = url
        ? { kind: "file", url, preview: opts.stripSecrets(artifacts[0]!.title) }
        : { kind: "text", preview: opts.stripSecrets(clip(brief.replace(/\s+/g, " ").trim(), 200)) };
    } else {
      attachment = { kind: "text", preview: opts.stripSecrets(clip(brief.replace(/\s+/g, " ").trim(), 200)) };
    }

    const summary = clip(brief.replace(/\s+/g, " ").trim(), 300);
    const reply = opts.stripSecrets(
      `「${skill.name}」已办好。${summary}` +
        (attachment?.kind === "file" && attachment.url ? ` 文档在这里：${attachment.url}（24 小时内有效）` : "") +
        (degraded ? "（智能模型暂不可用，给的是模板预填草稿，请人工补全。）" : ""),
    );
    await recordSkillCall({
      factoryId: opts.factoryId,
      sessionId: opts.sessionId,
      user: opts.username,
      skill,
      status: "ok",
      note: clip(opts.text, 120),
    });
    return { kind: "skill", ok: true, reply, attachment };
  } catch {
    await recordSkillCall({
      factoryId: opts.factoryId,
      sessionId: opts.sessionId,
      user: opts.username,
      skill,
      status: "failed",
      note: clip(opts.text, 120),
    });
    return {
      kind: "skill",
      ok: false,
      // 兜底回复同样过 stripSecrets（技能名可能含敏感串，与 reply 对齐）
      reply: opts.stripSecrets(
        `抱歉老板，「${skill.name}」这次没办成（执行线路异常），已记录。请稍后重试，或换个说法让我再来一次。`,
      ),
    };
  }
}

// ─── ⑥ M38 技能插件直达通道（DSH/MCP 底座消费，与语音链同执行器同预算同记账） ──

export interface DirectSkillResult {
  ok: boolean;
  brief: string;
  artifactUrl?: string;
  artifactTitle?: string;
  reason?: "not_visible" | "budget" | "exec_failed";
}

/**
 * execSkillDirect：技能插件的 agentic 直达执行（mcpBridge 内部通道专用）。
 * 与 runVoiceSkill 同一份执行器/预算闸/记账纪律——技能上 MCP 总线不是旁路，是同管线换个入口。
 * 差异仅在：无会话/人格/口播包装；记账 sessionId=0、user=actor（mcp:<factoryId> 口径）。
 */
export async function execSkillDirect(opts: {
  factoryId: number;
  skillKey: string;
  task: string;
  actor: string;
}): Promise<DirectSkillResult> {
  const visible = await loadVisibleSkills(opts.factoryId);
  const skill = visible.find((s) => s.skillKey === opts.skillKey);
  if (!skill) return { ok: false, brief: "技能不可见（未雇佣或未挂载）", reason: "not_visible" };
  const used = await todaySkillCallCount(opts.factoryId);
  if (used >= skillDailyBudget()) return { ok: false, brief: "今日技能额度已用完，明早 6 点重置", reason: "budget" };

  const ctx: ArtifactCtx = {
    agentCode: "mcp-skill",
    threadId: 0,
    actor: opts.actor,
    channel: "staff",
  };
  try {
    const matched = await buildMatchedSkill(skill);
    let brief = "";
    let artifacts: ArtifactInfo[] = [];
    let degraded = false;
    if (SKILL_TOOL_MAP[skill.skillKey]) {
      const out = await executeSkillTool(matched, opts.task.slice(0, 4000), ctx);
      if (!out) throw new Error("tool returned null");
      brief = out.brief;
      artifacts = out.artifacts;
    } else {
      const officeKind = SKILL_EXECUTOR_MAP[skill.skillKey];
      const contextBrief =
        officeKind === "llm_ppt" || officeKind === "llm_sheet" ? await factoryBriefText(opts.factoryId) : undefined;
      const out = await executeGenericSkill({
        skill: matched,
        content: opts.task,
        agentName: "灵枢",
        factoryId: opts.factoryId,
        ctx,
        contextBrief,
      });
      brief = out.text;
      artifacts = out.artifact ? [out.artifact] : [];
      degraded = out.degraded === true;
    }
    let artifactUrl: string | undefined;
    let artifactTitle: string | undefined;
    if (artifacts.length > 0) {
      // M44 安全：agentic 通道同闸——产出物过内容初筛，命中不交付
      const screened = screenText(`${brief}\n${artifacts.map((a) => a.title).join("\n")}`);
      if (!screened.ok) {
        await recordSkillCall({
          factoryId: opts.factoryId,
          sessionId: 0,
          user: opts.actor,
          skill,
          status: "failed",
          note: clip(`content-screened: ${opts.task}`, 120),
        });
        return { ok: false, brief: "产出命中平台安全规则，已转人工复审", reason: "exec_failed" };
      }
      const url = await deliverArtifactFile(artifacts[0]!);
      if (url) {
        artifactUrl = url;
        artifactTitle = artifacts[0]!.title;
      }
    }
    await recordSkillCall({
      factoryId: opts.factoryId,
      sessionId: 0,
      user: opts.actor,
      skill,
      status: "ok",
      note: clip(opts.task, 120),
    });
    return { ok: true, brief: degraded ? `${brief}（模板预填草稿，需人工补全）` : brief, artifactUrl, artifactTitle };
  } catch {
    await recordSkillCall({
      factoryId: opts.factoryId,
      sessionId: 0,
      user: opts.actor,
      skill,
      status: "failed",
      note: clip(opts.task, 120),
    });
    return { ok: false, brief: "技能执行线路异常，已记录", reason: "exec_failed" };
  }
}
