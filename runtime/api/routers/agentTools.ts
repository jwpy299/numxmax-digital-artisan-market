/**
 * agentTools —— 迭代 41「部门 Agent 技能执行层」。
 *
 * T1 技能接线：matchDeptSkills 按 trigger_hints 匹配 st_skills，buildSkillPromptBlock
 *   把 flow_steps/output_template/quality_checklist 真正注入聊天 prompt；
 * T2 文档三件套：doc_write→.docx / sheet_stats→.xlsx / ppt_draft→.pptx（LLM 产结构化 JSON，服务端渲染真文件）；
 * T3 数据速查：data_query → 白名单口径真查统一库，返回真实数据表格（多行时附 .xlsx 产出物）；
 * T4 联网调研：web_research → DuckDuckGo 检索 + 原文抓取 + LLM 综合，产出带来源简报 .docx。
 *
 * 产出物落盘 ST_ARTIFACT_DIR（默认 <cwd>/data/artifacts），台账记 st_agent_artifacts。
 * 全程静默降级：任一步失败返回 null，聊天退化为普通文本回复，绝不向前端抛错。
 */
import { promises as fs } from "fs";
import { rawRows } from "../queries/rawRows"; // ④逐点核：canonical 叶同引
import path from "path";
import crypto from "crypto";
import { sql } from "drizzle-orm";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import * as XLSX from "xlsx";
import PptxGenJS from "pptxgenjs";
import { getDb } from "../queries/connection";
import { callSlotChat, type SlotId } from "./modelGateway";
import { writeAdminAudit } from "./adminAnalytics";
import { noteSilent } from "./silentWatch";
import { sanitizeWebText } from "./webSanitize";

// ─── 基础工具 ────────────────────────────────────────────────────────────────

function clipT(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function stRows(statement: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  return rawRows(await getDb().execute(statement)); // ④逐点核：委托 canonical rawRows（私有等价提取路径=漂移面封死——wb 同件同形对齐）
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

/** LLM 输出 JSON 对象（容错：截取首个 {...} 块） */
async function llmJson(
  instruction: string,
  slot: SlotId = "brain",
  maxTokens = 2200,
  timeoutMs = 90_000,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await callSlotChat(slot, {
      messages: [
        { role: "system", content: "你是结构化输出助手，只输出一个 JSON 对象，不要输出任何其他文字、不要 markdown 代码围栏。" },
        { role: "user", content: instruction },
      ],
      maxTokens,
      timeoutMs,
    });
    if (!res.ok || !res.content) return null;
    const m = String(res.content).match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]) as unknown;
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ─── T1 技能匹配与 prompt 注入 ───────────────────────────────────────────────

export interface MatchedSkill {
  skillKey: string;
  name: string;
  category: string;
  slot: string;
  triggerHints: string[];
  flowSteps: string[];
  outputTemplate: string;
  qualityChecklist: string[];
  score: number;
  /** 迭代57：效果加权分（净采纳 clamp[-3,3]×0.5），排序用 score+boost，score 本身不变 */
  boost: number;
}

// ─── 迭代57 技能效果统计（采纳率驱动排序；60s 缓存；失败静默回退空表）───────
export interface SkillEffectiveness { uses: number; adopted: number; rejected: number }
let effCache: { at: number; map: Map<string, SkillEffectiveness> } | null = null;

export async function getSkillEffectiveness(): Promise<Map<string, SkillEffectiveness>> {
  if (effCache && Date.now() - effCache.at < 60_000) return effCache.map;
  try {
    const rows = await stRows(
      sql`SELECT a.skillKey,
            COUNT(DISTINCT a.id) AS uses,
            COALESCE(SUM(CASE WHEN f.fb_signal = 'adopted' THEN 1 ELSE 0 END), 0) AS adopted,
            COALESCE(SUM(CASE WHEN f.fb_signal = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected
          FROM st_agent_artifacts a
          LEFT JOIN st_artifact_feedback f ON f.artifact_id = a.id
          GROUP BY a.skillKey`,
    );
    const map = new Map<string, SkillEffectiveness>();
    for (const r of rows) {
      map.set(String(r.skillKey), {
        uses: Number(r.uses ?? 0),
        adopted: Number(r.adopted ?? 0),
        rejected: Number(r.rejected ?? 0),
      });
    }
    effCache = { at: Date.now(), map };
    return map;
  } catch {
    return effCache?.map ?? new Map();
  }
}

/** 效果加权：净采纳截断 [-3,3] × 0.5（好技能最多 +1.5，差技能最多 -1.5，不压倒字面命中） */
export function effectivenessBoost(e: SkillEffectiveness | undefined): number {
  if (!e) return 0;
  const net = Math.max(-3, Math.min(3, e.adopted - e.rejected));
  return net * 0.5;
}

/** iter97 基础教育包·标配技能保底池：全员自带，触发词大扩容（口语化全覆盖），
 *  不再只靠 st_skills 的种子触发词撞运气 */
const BASE_KIT: Array<{ skillKey: string; name: string; hints: string[] }> = [
  { skillKey: "doc_write", name: "文档撰写", hints: ["写一份","起草","拟定","帮我写","出个方案","写个文档","写文档","做文档","word","文档","报告"] },
  { skillKey: "sheet_stats", name: "表格整理", hints: ["整理成表","统计一下","汇总","做个表格","做表格","excel","表格","台账","清单"] },
  { skillKey: "ppt_draft", name: "演示大纲", hints: ["做个PPT","做ppt","ppt","PPT","演示","汇报提纲","路演","幻灯片","演示稿"] },
  { skillKey: "daily_report", name: "日报周报", hints: ["日报","写日报","今日总结","今天的工作","日报生成","每日汇报"] },
];

/** 按 trigger_hints 对用户消息打分，返回得分>0 的前 2 个技能（驻部 Agent 共享技能库）。
 *  传 agentCode 时：该 agent 在 st_agent_skills 挂载且字面命中的技能 +3 分（未挂载保持原分）。 */
export async function matchDeptSkills(content: string, agentCode?: string): Promise<MatchedSkill[]> {
  try {
    const rows = await stRows(
      sql`SELECT skill_key, name, category, slot, trigger_hints, flow_steps, output_template, quality_checklist
          FROM st_skills WHERE status = 'active'`,
    );
    // 迭代84：查该 agent 挂载的技能（agent_id 兼容 agents / st_agents 两套表的 code 反查）
    const mounted = new Set<string>();
    if (agentCode) {
      try {
        const mRows = await stRows(
          sql`SELECT DISTINCT m.skill_key FROM st_agent_skills m
              WHERE m.enabled = 1 AND (
                m.agent_id IN (SELECT id FROM agents WHERE code = ${agentCode})
                OR m.agent_id IN (SELECT id FROM st_agents WHERE code = ${agentCode})
              )`,
        );
        for (const r of mRows) mounted.add(String(r.skill_key));
      } catch {
        // 挂载表/列缺失：静默不加权
      }
    }
    // iter97：标配四件套并入匹配池（全员保底自带）
    const rowByKey = new Map(rows.map((r) => [String(r.skill_key), r]));
    for (const b of BASE_KIT) {
      const ex = rowByKey.get(b.skillKey);
      if (ex) {
        const merged = new Set([...parseStrArray(ex.trigger_hints), ...b.hints]);
        ex.trigger_hints = JSON.stringify([...merged]);
      } else {
        rows.push({ skill_key: b.skillKey, name: b.name, category: "base", slot: "chat",
          trigger_hints: JSON.stringify(b.hints), flow_steps: "[]", output_template: "", quality_checklist: "[]" });
      }
    }
    const text = content.toLowerCase();
    const scored: MatchedSkill[] = [];
    for (const r of rows) {
      const hints = parseStrArray(r.trigger_hints);
      let score = 0;
      for (const h of hints) {
        const k = h.toLowerCase();
        if (k && text.includes(k)) score += k.length >= 3 ? 2 : 1;
      }
      if (score > 0 && mounted.has(String(r.skill_key))) score += 3;
      if (score > 0) {
        scored.push({
          skillKey: String(r.skill_key),
          name: String(r.name),
          category: String(r.category),
          slot: String(r.slot ?? "chat"),
          triggerHints: hints,
          flowSteps: parseStrArray(r.flow_steps),
          outputTemplate: r.output_template == null ? "" : String(r.output_template),
          qualityChecklist: parseStrArray(r.quality_checklist),
          score,
          boost: 0,
        });
      }
    }
    // 迭代57：效果加权排序——真实采纳反馈参与排名（字面分不变，仅决定次序）
    const eff = await getSkillEffectiveness();
    for (const s of scored) s.boost = effectivenessBoost(eff.get(s.skillKey));
    return scored.sort((a, b) => b.score + b.boost - (a.score + a.boost)).slice(0, 2);
  } catch {
    return [];
  }
}

/** 把命中技能的五件套注入 system prompt（T1 核心：让技能真正生效） */
export function buildSkillPromptBlock(skills: MatchedSkill[]): string {
  if (skills.length === 0) return "";
  const blocks = skills.map((s) => {
    const lines = [`【命中技能：${s.name}（${s.skillKey}）】`];
    if (s.flowSteps.length > 0) lines.push(`执行流程：${s.flowSteps.join(" → ")}`);
    if (s.outputTemplate) lines.push(`输出模板：\n${s.outputTemplate}`);
    if (s.qualityChecklist.length > 0) lines.push(`质量清单：${s.qualityChecklist.join("；")}`);
    return lines.join("\n");
  });
  return `\n\n【技能执行要求】本次回复必须严格遵循以下命中技能的流程与输出模板：\n${blocks.join("\n\n")}`;
}

// ─── 技能 → 执行工具映射 ────────────────────────────────────────────────────

export type SkillToolKind = "docx" | "xlsx" | "pptx" | "data" | "research" | "claw";
export const SKILL_TOOL_MAP: Record<string, SkillToolKind> = {
  doc_write: "docx",
  sheet_stats: "xlsx",
  ppt_draft: "pptx",
  data_query: "data",
  web_research: "research",
  claw_browser_task: "claw",
};

// ─── 迭代84 通用技能执行器解析（全 17 技能）─────────────────────────────────
// SKILL_EXECUTOR_MAP 定义在 skillExecutor.ts（其静态依赖本文件）；为避免循环 import，
// 此处动态 import 预热缓存。预热完成前通用技能暂返回 null（退化为普通文本回复）。
import type { ExecutorKind } from "./skillExecutor";
let genericExecutorMapCache: Record<string, ExecutorKind> | null = null;
void import("./skillExecutor")
  .then((m) => { genericExecutorMapCache = m.SKILL_EXECUTOR_MAP; })
  .catch(() => { /* 预热失败静默：通用技能暂不可执行 */ });

/** 技能 → 执行器类别：先查 6 个专用工具映射，再查 skillExecutor 的全量映射 */
export function resolveSkillExecutor(skillKey: string): ExecutorKind | null {
  const dedicated = SKILL_TOOL_MAP[skillKey];
  if (dedicated) return dedicated;
  return genericExecutorMapCache?.[skillKey] ?? null;
}

// ─── 产出物落盘与台账 ───────────────────────────────────────────────────────

export interface ArtifactInfo {
  id: number;
  kind: string;
  title: string;
  filename: string;
  sizeBytes: number;
}

export interface ArtifactCtx {
  agentCode: string;
  threadId: number | null;
  actor: string;
  /** M28 起新增 voice：灵枢数字人语音派单通道（产出物台账与文本通道同表同口径） */
  channel: "admin" | "staff" | "meeting" | "voice";
}

export async function saveArtifact(
  ctx: ArtifactCtx,
  skillKey: string,
  kind: string,
  title: string,
  ext: string,
  buf: Buffer,
  meta: Record<string, unknown>,
): Promise<ArtifactInfo> {
  const dir = process.env.ST_ARTIFACT_DIR || path.resolve(process.cwd(), "data", "artifacts");
  await fs.mkdir(dir, { recursive: true });
  const filename = `${Date.now()}-${kind}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, buf);
  const res = (await getDb().execute(
    sql`INSERT INTO st_agent_artifacts (agentCode, threadId, actor, channel, kind, skillKey, title, filename, filePath, sizeBytes, meta)
        VALUES (${ctx.agentCode}, ${ctx.threadId}, ${ctx.actor}, ${ctx.channel}, ${kind}, ${skillKey},
                ${clipT(title, 120)}, ${filename}, ${filePath}, ${buf.length}, ${JSON.stringify(meta)})`,
  )) as unknown;
  const header = Array.isArray(res) ? (res[0] as { insertId?: number }) : {};
  return { id: Number(header?.insertId ?? 0), kind, title: clipT(title, 120), filename, sizeBytes: buf.length };
}

// ─── T2 文档三件套渲染 ──────────────────────────────────────────────────────

function asStrArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

/** AI 生成内容标识（《人工智能生成合成内容标识办法》合规要求） */
const AI_GEN_DISCLAIMER = "🤖 本文档由 AI 数字员工生成，内容仅供参考，请人工复核后使用。";

async function renderDocx(title: string, sections: Array<{ heading: string; paragraphs: string[] }>, footer?: string): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: title, bold: true })] }),
  ];
  for (const sec of sections) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 240 }, children: [new TextRun({ text: sec.heading, bold: true })] }));
    for (const p of sec.paragraphs) {
      children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun(p)] }));
    }
  }
  if (footer) {
    children.push(new Paragraph({ spacing: { before: 360 }, children: [new TextRun({ text: footer, italics: true, size: 18 })] }));
  }
  children.push(new Paragraph({ spacing: { before: 120 }, children: [new TextRun({ text: AI_GEN_DISCLAIMER, size: 16, color: "888888" })] }));
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

function renderXlsx(title: string, columns: string[], rows: string[][], summary?: string): Buffer {
  const aoa: string[][] = [[title], [], columns, ...rows];
  if (summary) aoa.push([], [`结论：${summary}`]);
  aoa.push([], [AI_GEN_DISCLAIMER]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "数据");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function renderPptx(title: string, slides: Array<{ heading: string; bullets: string[]; note?: string }>): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.title = title;
  const cover = pptx.addSlide();
  cover.addText(title, { x: 0.6, y: 2.2, w: 8.8, h: 1.4, fontSize: 34, bold: true, color: "1F2A44", align: "center" });
  cover.addText(AI_GEN_DISCLAIMER, { x: 0.6, y: 6.9, w: 8.8, h: 0.4, fontSize: 10, color: "999999", align: "center" });
  for (const s of slides) {
    const slide = pptx.addSlide();
    slide.addText(s.heading, { x: 0.5, y: 0.4, w: 9, h: 0.9, fontSize: 24, bold: true, color: "1F2A44" });
    // 生成式 AI 标识合规（暂行办法）：每页页脚
    slide.addText(AI_GEN_DISCLAIMER, { x: 0.5, y: 7.0, w: 9, h: 0.35, fontSize: 9, color: "999999" });
    slide.addText(
      s.bullets.map((b) => ({ text: b, options: { bullet: true, fontSize: 16, color: "33415C", breakLine: true } })),
      { x: 0.7, y: 1.5, w: 8.6, h: 4.6 },
    );
    if (s.note) slide.addNotes(s.note);
  }
  const out = await pptx.write({ outputType: "nodebuffer" });
  return out as Buffer;
}

// ─── T2 执行：文档/表格/PPT ─────────────────────────────────────────────────

async function executeDocTool(
  kind: "docx" | "xlsx" | "pptx",
  skill: MatchedSkill,
  userContent: string,
  ctx: ArtifactCtx,
): Promise<{ artifact: ArtifactInfo; brief: string } | null> {
  const today = new Date().toISOString().slice(0, 10);
  const schemas: Record<string, string> = {
    docx: `{"title":"文档标题","sections":[{"heading":"一级标题","paragraphs":["段落1","段落2"]}],"footer":"落款"}`,
    xlsx: `{"title":"表格标题","columns":["列1","列2"],"rows":[["值1","值2"]],"summary":"一句话结论"}`,
    pptx: `{"title":"演示主题","slides":[{"heading":"页标题","bullets":["要点1","要点2"],"note":"演讲备注"}]}`,
  };
  const obj = await llmJson(
    [
      `请根据用户需求，严格按「${skill.name}」技能要求产出结构化内容（JSON）。`,
      skill.flowSteps.length > 0 ? `技能流程：${skill.flowSteps.join(" → ")}` : "",
      skill.outputTemplate ? `技能输出模板：${skill.outputTemplate}` : "",
      skill.qualityChecklist.length > 0 ? `质量要求：${skill.qualityChecklist.join("；")}` : "",
      `用户需求：${clipT(userContent, 800)}`,
      `输出 JSON 结构（字段名必须完全一致）：${schemas[kind]}`,
      kind === "docx" ? "要求：3~6 个 sections，每个 sections 2~5 个段落，内容务实完整。" : "",
      kind === "xlsx" ? "要求：columns 3~6 列，rows 5~15 行，数值合理自洽。" : "",
      kind === "pptx" ? "要求：5~8 页 slides，每页 3~5 条 bullets，每条不超过 30 字。" : "",
    ].filter(Boolean).join("\n"),
    (skill.slot as SlotId) || "brain",
    kind === "docx" ? 4200 : 2200,
  );
  // docx 兜底：长文 JSON 易被截断 → 退而求其次，取纯文本散文做启发式分段渲染（主槽失败再换 flash 槽）
  if (!obj && kind === "docx") {
    const slotsToTry: SlotId[] = [((skill.slot as SlotId) || "brain"), "flash"];
    for (const slot of slotsToTry) {
      try {
        const prose = await callSlotChat(slot, {
          messages: [
            { role: "system", content: `你是「${skill.name}」技能撰稿助手。按技能流程与模板直接输出成稿纯文本，章节用「一、」「二、」等中文序号起头，不要 JSON、不要 markdown 标记。${skill.outputTemplate ? `\n输出模板：${skill.outputTemplate}` : ""}` },
            { role: "user", content: clipT(userContent, 800) },
          ],
          maxTokens: 4200,
          timeoutMs: 120_000,
        });
        if (!prose.ok || !prose.content) continue;
        const lines = String(prose.content).split("\n").map((l) => l.trim()).filter(Boolean);
        const titleLine = lines[0]?.replace(/^#+\s*/, "") ?? skill.name;
        const sections: Array<{ heading: string; paragraphs: string[] }> = [];
        let cur: { heading: string; paragraphs: string[] } | null = null;
        for (const line of lines.slice(1)) {
          const h = line.match(/^(?:#+\s*)?(?:第?[一二三四五六七八九十]+[、.．]|[0-9]+[、.．])\s*(.{2,40})$/);
          if (h) {
            cur = { heading: line.replace(/^#+\s*/, ""), paragraphs: [] };
            sections.push(cur);
          } else if (cur) {
            cur.paragraphs.push(line);
          } else {
            sections.push({ heading: "正文", paragraphs: [line] });
            cur = sections[sections.length - 1];
          }
        }
        const valid = sections.filter((s) => s.paragraphs.length > 0);
        if (valid.length === 0) continue;
        const buf = await renderDocx(titleLine, valid, `（拟稿：${ctx.agentCode} 驻部智能体，${today}）`);
        const artifact = await saveArtifact(ctx, skill.skillKey, "docx", titleLine, "docx", buf, { userNeed: clipT(userContent, 200), fallback: "prose", slot });
        return { artifact, brief: `已按「${skill.name}」技能为您生成 Word 文档《${titleLine}》（${valid.length} 个章节），点击下方附件即可下载。` };
      } catch {
        // 换下一个槽位
      }
    }
    return null;
  }
  if (!obj) return null;
  const title = String(obj.title ?? skill.name);
  try {
    if (kind === "docx") {
      const sections = (Array.isArray(obj.sections) ? obj.sections : []).map((s) => {
        const sec = s as Record<string, unknown>;
        return { heading: String(sec.heading ?? ""), paragraphs: asStrArray(sec.paragraphs) };
      }).filter((s) => s.heading && s.paragraphs.length > 0);
      if (sections.length === 0) return null;
      const footer = obj.footer ? String(obj.footer) : `（拟稿：${ctx.agentCode} 驻部智能体，${today}）`;
      const buf = await renderDocx(title, sections, footer);
      const artifact = await saveArtifact(ctx, skill.skillKey, "docx", title, "docx", buf, { userNeed: clipT(userContent, 200) });
      return { artifact, brief: `已按「${skill.name}」技能为您生成 Word 文档《${title}》（${sections.length} 个章节），点击下方附件即可下载。` };
    }
    if (kind === "xlsx") {
      const columns = asStrArray(obj.columns);
      const rows = (Array.isArray(obj.rows) ? obj.rows : []).map((r) => asStrArray(r)).filter((r) => r.length > 0);
      if (columns.length === 0 || rows.length === 0) return null;
      const buf = renderXlsx(title, columns, rows, obj.summary ? String(obj.summary) : undefined);
      const artifact = await saveArtifact(ctx, skill.skillKey, "xlsx", title, "xlsx", buf, { userNeed: clipT(userContent, 200) });
      const preview = [columns.join(" | "), ...rows.slice(0, 5).map((r) => r.join(" | "))].join("\n");
      return { artifact, brief: `已按「${skill.name}」技能整理成 Excel 表格《${title}》（${rows.length} 行 × ${columns.length} 列），预览：\n${preview}\n完整文件请点击下方附件下载。${obj.summary ? `\n结论：${String(obj.summary)}` : ""}` };
    }
    const slides = (Array.isArray(obj.slides) ? obj.slides : []).map((s) => {
      const sl = s as Record<string, unknown>;
      return { heading: String(sl.heading ?? ""), bullets: asStrArray(sl.bullets), note: sl.note ? String(sl.note) : undefined };
    }).filter((s) => s.heading && s.bullets.length > 0);
    if (slides.length === 0) return null;
    const buf = await renderPptx(title, slides);
    const artifact = await saveArtifact(ctx, skill.skillKey, "pptx", title, "pptx", buf, { userNeed: clipT(userContent, 200) });
    return { artifact, brief: `已按「${skill.name}」技能生成 PPT《${title}》（封面 + ${slides.length} 页：${slides.map((s) => s.heading).slice(0, 5).join("、")}${slides.length > 5 ? " 等" : ""}），点击下方附件即可下载。` };
  } catch {
    return null;
  }
}

// ─── T3 执行：数据速查（白名单口径真查库） ──────────────────────────────────

interface DataMetric {
  id: string;
  label: string;
  keywords: string[];
  query: string;
}

const DATA_METRICS: DataMetric[] = [
  { id: "users", label: "注册账号总数", keywords: ["账号", "用户", "注册"], query: "SELECT COUNT(*) AS v FROM wb_users" },
  { id: "factories", label: "入驻企业数", keywords: ["企业", "工厂", "入驻"], query: "SELECT COUNT(*) AS v FROM wb_factories" },
  { id: "agents", label: "数字员工总数", keywords: ["数字员工", "坐席"], query: "SELECT COUNT(*) AS v FROM agents" },
  { id: "hire_orders", label: "雇佣订单数", keywords: ["订单", "雇佣"], query: "SELECT COUNT(*) AS v FROM agent_hire_records" },
  { id: "token_flow", label: "Token 流水总额", keywords: ["token", "流水", "计量"], query: "SELECT COALESCE(SUM(amount),0) AS v FROM token_transactions" },
  { id: "swarm_tasks", label: "班组协同任务数", keywords: ["班组", "协同任务", "swarm"], query: "SELECT COUNT(*) AS v FROM st_swarm_tasks" },
  { id: "dept_docs", label: "部门资料份数", keywords: ["资料", "文档", "知识库"], query: "SELECT COUNT(*) AS v FROM st_kb_docs" },
  { id: "staff", label: "部门账号数", keywords: ["部门账号", "员工账号"], query: "SELECT COUNT(*) AS v FROM st_staff_accounts" },
  { id: "skills", label: "技能库技能数", keywords: ["技能"], query: "SELECT COUNT(*) AS v FROM st_skills WHERE status='active'" },
  {
    id: "overview", label: "经营总览", keywords: ["总览", "经营", "整体", "大盘"],
    query: "SELECT (SELECT COUNT(*) FROM wb_users) AS 注册账号, (SELECT COUNT(*) FROM wb_factories) AS 入驻企业, (SELECT COUNT(*) FROM agents) AS 数字员工, (SELECT COUNT(*) FROM agent_hire_records) AS 雇佣订单, (SELECT COUNT(*) FROM st_swarm_tasks) AS 班组任务",
  },
  {
    id: "dept_staff", label: "各部门账号分布", keywords: ["各部门", "部门分布", "各部门账号", "账号分布"],
    query: "SELECT deptKey AS 部门, COUNT(*) AS 账号数 FROM st_staff_accounts GROUP BY deptKey ORDER BY 账号数 DESC",
  },
  {
    id: "recent_orders", label: "近7天订单趋势", keywords: ["近7天", "最近订单", "趋势"],
    query: "SELECT DATE(created_at) AS 日期, COUNT(*) AS 订单数 FROM agent_hire_records WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) GROUP BY DATE(created_at) ORDER BY 日期",
  },
];

function pickMetric(content: string): DataMetric | null {
  const text = content.toLowerCase();
  let best: DataMetric | null = null;
  let bestScore = 0;
  for (const m of DATA_METRICS) {
    let score = 0;
    for (const k of m.keywords) if (text.includes(k.toLowerCase())) score += k.length;
    if (score > bestScore) { best = m; bestScore = score; }
  }
  return best ?? DATA_METRICS.find((m) => m.id === "overview") ?? null;
}

async function executeDataTool(
  skill: MatchedSkill,
  userContent: string,
  ctx: ArtifactCtx,
): Promise<{ artifact: ArtifactInfo | null; brief: string } | null> {
  try {
    const metric = pickMetric(userContent);
    if (!metric) return null;
    const rows = await stRows(sql.raw(metric.query));
    if (rows.length === 0) return { artifact: null, brief: `【数据速查】${metric.label}：暂无数据。` };
    const now = new Date().toLocaleString("zh-CN", { hour12: false });
    const cols = Object.keys(rows[0]);
    const tableLines = [cols.join(" | "), ...rows.slice(0, 20).map((r) => cols.map((c) => String(r[c])).join(" | "))];
    let artifact: ArtifactInfo | null = null;
    if (rows.length > 1) {
      const buf = renderXlsx(metric.label, cols, rows.map((r) => cols.map((c) => String(r[c] ?? ""))), undefined);
      artifact = await saveArtifact(ctx, skill.skillKey, "xlsx", metric.label, "xlsx", buf, { metric: metric.id });
    }
    return {
      artifact,
      brief: `【数据速查】${metric.label}（真实库查询，数据时点：${now}）\n${tableLines.join("\n")}${artifact ? "\n已同步生成 Excel 附件。" : ""}`,
    };
  } catch {
    return null;
  }
}

// ─── T4 执行：联网调研 ──────────────────────────────────────────────────────

interface SearchHit { title: string; url: string; snippet: string }

async function duckSearch(q: string): Promise<SearchHit[]> {
  const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  const html = await res.text();
  const hits: SearchHit[] = [];
  const linkRe = /<a[^>]*href="([^"]+)"[^>]*class='result-link'[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<td class='result-snippet'[^>]*>([\s\S]*?)<\/td>/g;
  const strip = (s: string) =>
    s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&nbsp;/g, " ").trim();
  const links: Array<{ url: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) && links.length < 6) {
    let url = m[1];
    const uddg = url.match(/uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith("http")) links.push({ url, title: strip(m[2]) });
  }
  const snippets: string[] = [];
  while ((m = snipRe.exec(html)) && snippets.length < 6) snippets.push(clipT(strip(m[1]), 400));
  for (let i = 0; i < links.length; i++) {
    hits.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] ?? "" });
  }
  return hits;
}

async function fetchPageText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return "";
    const html = await res.text();
    // iter81 闸门二：不可信网页内容消毒（剥活性元素 + 提示词注入行过滤）
    const { text, strippedLines } = sanitizeWebText(html, 1600);
    if (strippedLines > 0) noteSilent("agentTools.webSanitize.injection", new Error(`注入样本行剔除 ×${strippedLines} url=${url.slice(0, 120)}`));
    return text;
  } catch {
    return "";
  }
}

async function executeResearchTool(
  skill: MatchedSkill,
  userContent: string,
  ctx: ArtifactCtx,
): Promise<{ artifact: ArtifactInfo | null; brief: string } | null> {
  try {
    const hits = await duckSearch(userContent);
    if (hits.length === 0) return null;
    const pages = await Promise.all(hits.slice(0, 3).map((h) => fetchPageText(h.url)));
    const materials = hits.slice(0, 5).map((h, i) => `来源${i + 1}《${h.title}》${h.url}\n摘要：${h.snippet}\n正文节选：${pages[i] ?? "（抓取失败）"}`).join("\n\n");
    const obj = await llmJson(
      [
        "请基于以下联网检索材料，产出调研简报（JSON）。关键事实必须标注来源编号，如（来源1）。",
        `调研主题：${clipT(userContent, 400)}`,
        `检索材料：\n${clipT(materials, 6000)}`,
        `输出 JSON 结构：{"title":"简报标题","conclusions":["核心结论1","结论2"],"facts":["事实1（来源1）","事实2（来源2）"],"suggestions":["建议1","建议2"]}`,
        "要求：conclusions 2~4 条，facts 4~8 条且每条附来源编号，suggestions 2~4 条。",
      ].join("\n"),
      "brain",
      2600,
      120_000,
    );
    const sourceList = hits.slice(0, 5).map((h, i) => `来源${i + 1}：${h.title} — ${h.url}`);
    let artifact: ArtifactInfo | null = null;
    let briefBody: string;
    if (obj) {
      const title = String(obj.title ?? `调研简报：${clipT(userContent, 30)}`);
      const conclusions = asStrArray(obj.conclusions);
      const facts = asStrArray(obj.facts);
      const suggestions = asStrArray(obj.suggestions);
      const buf = await renderDocx(title, [
        { heading: "一、核心结论", paragraphs: conclusions },
        { heading: "二、关键事实（附来源）", paragraphs: facts },
        { heading: "三、建议", paragraphs: suggestions },
        { heading: "来源清单", paragraphs: sourceList },
      ], `（调研：${ctx.agentCode} 驻部智能体 · 联网检索 ${hits.length} 条来源）`);
      artifact = await saveArtifact(ctx, skill.skillKey, "docx", title, "docx", buf, { sources: hits.slice(0, 5).map((h) => h.url) });
      briefBody = `【调研简报】${title}\n一、核心结论\n${conclusions.map((c) => `· ${c}`).join("\n")}\n二、关键事实\n${facts.slice(0, 6).map((f) => `· ${f}`).join("\n")}\n三、建议\n${suggestions.map((s) => `· ${s}`).join("\n")}`;
    } else {
      briefBody = `【联网检索结果】围绕「${clipT(userContent, 40)}」检索到 ${hits.length} 条来源：\n${hits.slice(0, 5).map((h, i) => `${i + 1}. ${h.title}\n   ${h.snippet}\n   ${h.url}`).join("\n")}`;
    }
    return { artifact, brief: `${briefBody}\n\n${sourceList.join("\n")}${artifact ? "\n完整简报文档请点击下方附件下载。" : ""}` };
  } catch {
    return null;
  }
}

// ─── B4 可靠性记数（内存级，供 Ops 页告警；重启清零，按 24h 滑窗近似）───────
interface SkillToolStat { ok: number; fail: number; recentFails: { skillKey: string; at: number; channel: string }[] }
const skillToolStats: SkillToolStat = { ok: 0, fail: 0, recentFails: [] };
function recordSkillOutcome(ok: boolean, skillKey: string, channel: string): void {
  if (ok) { skillToolStats.ok += 1; return; }
  skillToolStats.fail += 1;
  skillToolStats.recentFails.push({ skillKey, at: Date.now(), channel });
  const dayAgo = Date.now() - 86_400_000;
  skillToolStats.recentFails = skillToolStats.recentFails.filter((f) => f.at > dayAgo).slice(-50);
}
export function getSkillToolStats(): { ok: number; fail: number; failRate: number; recentFails: SkillToolStat["recentFails"] } {
  const total = skillToolStats.ok + skillToolStats.fail;
  return { ...skillToolStats, failRate: total === 0 ? 0 : Math.round((skillToolStats.fail / total) * 1000) / 10 };
}

// ─── 统一入口 ───────────────────────────────────────────────────────────────

export interface ToolRunResult {
  artifacts: ArtifactInfo[];
  brief: string;
}

/** 命中可执行技能时运行工具管线；不可执行或失败返回 null（退化为普通文本回复） */
export async function executeSkillTool(
  skill: MatchedSkill,
  userContent: string,
  ctx: ArtifactCtx,
): Promise<ToolRunResult | null> {
  const kind = SKILL_TOOL_MAP[skill.skillKey];
  if (!kind) return null;
  let out: ToolRunResult | null = null;
  if (kind === "claw") {
    // 龙虾浏览器代办：动态引入避免循环依赖；开工即返回，证据异步回流本线程
    const { dispatchClawTask } = await import("./claw");
    const r = await dispatchClawTask({
      task: userContent.slice(0, 500),
      actor: ctx.actor,
      ctx: { agentCode: ctx.agentCode, threadId: ctx.threadId, actor: ctx.actor, channel: ctx.channel },
    });
    out = { artifacts: [], brief: r.message };
  } else if (kind === "data") {
    const r = await executeDataTool(skill, userContent, ctx);
    out = r ? { artifacts: r.artifact ? [r.artifact] : [], brief: r.brief } : null;
  } else if (kind === "research") {
    const r = await executeResearchTool(skill, userContent, ctx);
    out = r ? { artifacts: r.artifact ? [r.artifact] : [], brief: r.brief } : null;
  } else {
    const r = await executeDocTool(kind, skill, userContent, ctx);
    out = r ? { artifacts: [r.artifact], brief: r.brief } : null;
  }
  recordSkillOutcome(out !== null, skill.skillKey, ctx.channel);
  return out;
}

// ─── 员工个体记忆（iter55）：写路径异步沉淀 + 读路径注入 prompt ─────────────

/** getAgentMemories：读某员工对某用户的个体记忆（≤5 条，按新鲜度） */
export async function getAgentMemories(agentCode: string, actor: string): Promise<string[]> {
  try {
    const rows = await stRows(
      sql`SELECT content FROM st_agent_memories
          WHERE agent_code = ${agentCode} AND actor = ${actor}
          ORDER BY updated_at DESC LIMIT 5`,
    );
    return rows.map((r) => String(r.content)).filter((c) => c.trim() !== "");
  } catch {
    return [];
  }
}

/** 记忆注入块：无记忆返回空串 */
export function buildMemoryBlock(memories: string[]): string {
  if (memories.length === 0) return "";
  return `\n\n【你对此人的个体记忆】\n${memories.map((m) => `- ${m}`).join("\n")}\n（以上为你的长期记忆，自然运用，不要复述"我记得" unless 用户问起。）`;
}

/** extractAndSaveMemories（写路径，调用方 void 异步执行，绝不阻塞回复）：
 *  flash 槽从单轮对话提取 ≤3 条偏好/事实，INSERT IGNORE 去重；无产出即静默。 */
export async function extractAndSaveMemories(
  agentCode: string,
  actor: string,
  userContent: string,
  agentReply: string,
): Promise<void> {
  try {
    // 提取前取已有记忆：交给提取器做语义去重（措辞/数字格式差异也能识别）
    const prior = await getAgentMemories(agentCode, actor);
    const priorBlock = prior.length > 0
      ? `\n已有记忆：\n${prior.map((p) => `- ${p}`).join("\n")}\n若新信息与已有记忆语义重复（即使措辞不同），不要重复输出。`
      : "";
    const r = await callSlotChat("flash", {
      messages: [
        {
          role: "system",
          content:
            "你是记忆提取器。从对话中提取用户表露的【长期偏好】或【稳定事实】（如工作习惯、部门规则、明确告知的信息），" +
            "最多3条，每条≤40字，JSON 数组输出：[{\"kind\":\"preference|fact\",\"content\":\"...\"}]。没有值得记住的内容就输出 []。" +
            "只输出 JSON，不要解释。一次性的任务指令、寒暄、临时性问题不要记。" + priorBlock,
        },
        { role: "user", content: `用户说：${clipT(userContent, 300)}\n员工答：${clipT(agentReply, 300)}` },
      ],
      maxTokens: 300,
      temperature: 0.1,
      timeoutMs: 30_000,
    });
    if (!r.ok || !r.content) return;
    const m = r.content.match(/\[[\s\S]*\]/);
    if (!m) return;
    let arr: { kind?: string; content?: string }[];
    try {
      arr = JSON.parse(m[0]) as { kind?: string; content?: string }[];
    } catch (e) { /* LLM 返回非法 JSON：放弃本轮记忆沉淀，观测打点 */
      noteSilent("memory.extract.parse", e);
      return;
    }
    // 兜底语义去重：bigram Jaccard ≥0.35 视为同一事实不重复沉淀
    const existing = prior.slice();
    const bigrams = (s: string) => {
      const set = new Set<string>();
      for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
      return set;
    };
    const tooSimilar = (c: string) => {
      const a = bigrams(c);
      for (const e of existing) {
        const b = bigrams(e);
        let inter = 0;
        for (const g of a) if (b.has(g)) inter++;
        if (inter / (a.size + b.size - inter || 1) >= 0.35) return true;
      }
      return false;
    };
    for (const item of arr.slice(0, 3)) {
      const content = String(item.content ?? "").trim().slice(0, 255);
      if (content.length < 4) continue;
      if (tooSimilar(content)) continue;
      const kind = item.kind === "preference" ? "preference" : "fact";
      await stRows(
        sql`INSERT IGNORE INTO st_agent_memories (agent_code, actor, kind, content, source)
            VALUES (${agentCode}, ${actor}, ${kind}, ${content}, 'auto')`,
      );
      existing.push(content);
    }
    // 迭代71·容量治理：同一 (agent_code, actor) 记忆上限 50，超出按最旧（updated_at ASC）淘汰并审计
    await enforceMemoryCap(agentCode, actor);
  } catch {
    // 记忆沉淀失败静默，绝不影响主对话
  }
}

/** 单 actor 记忆上限（超出部分按最旧淘汰） */
export const MEMORY_CAP_PER_ACTOR = 50;

/** 迭代71：容量回收——超限删最旧至上限；回收写审计；异常静默 */
async function enforceMemoryCap(agentCode: string, actor: string): Promise<void> {
  try {
    const cnt = await stRows(
      sql`SELECT COUNT(*) AS c FROM st_agent_memories WHERE agent_code = ${agentCode} AND actor = ${actor}`,
    );
    const excess = Number(cnt[0]?.c ?? 0) - MEMORY_CAP_PER_ACTOR;
    if (excess <= 0) return;
    const over = await stRows(
      sql`SELECT id FROM st_agent_memories
          WHERE agent_code = ${agentCode} AND actor = ${actor}
          ORDER BY updated_at ASC, id ASC
          LIMIT ${excess}`,
    );
    if (over.length === 0) return;
    const ids = over.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
    if (ids.length === 0) return;
    await getDb().execute(
      sql`DELETE FROM st_agent_memories WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`,
    );
    writeAdminAudit(0, "system", "memory.evict", `${agentCode}/${actor}`, { evicted: ids.length, cap: MEMORY_CAP_PER_ACTOR });
  } catch (e) {
    // 回收失败打点观测（A3）：记忆超容量会持续累积，不可无声
    noteSilent("memory.cap.evict", e);
  }
}
