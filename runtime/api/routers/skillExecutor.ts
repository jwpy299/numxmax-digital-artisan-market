/**
 * skillExecutor —— 迭代 84「通用技能真执行器」。
 *
 * 让 st_skills 全部 17 个技能都能真执行：
 * - 6 个已有专用执行器（doc_write/sheet_stats/ppt_draft/data_query/web_research/claw_browser_task）
 *   保持 agentTools.SKILL_TOOL_MAP 原 kind；
 * - 其余 11 个技能走通用执行：技能五件套（flow_steps/output_template/quality_checklist）
 *   + Agent 人设 + 知识库片段组装 prompt，经 callModelChat 真调 LLM；
 * - 文档类技能（llm_doc）把 LLM 成稿解析为章节并渲染真 .docx 产出物落盘台账；
 * - M20 波 2：llm_ppt（PPT 制作，3 套品牌浅青模板版式锁死）/ llm_sheet（Excel 报表，
 *   2 套模板）——LLM 只出内容大纲/数据（数字须引用 briefText 同源企业实况，禁止编造），
 *   模板渲染真 .pptx/.xlsx 产出物落盘台账，由路由层 deliverArtifactFile 投递；
 * - LLM 未配置/失败一律降级：按 output_template 结构化预填草稿框架并标注 degraded，
 *   绝不向前端抛错；所有输入截断，不打印任何敏感信息。
 *
 * 依赖方向：skillExecutor → agentTools（类型/映射/落盘台账），agentTools 不静态依赖本文件
 * （resolveSkillExecutor 通过动态 import 预热缓存，避免循环 import）。
 */
import { sql } from "drizzle-orm";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import * as XLSX from "xlsx";
import PptxGenJSImport from "pptxgenjs";
// CJS/ESM 互操作防御：esbuild/vitest 下 default 即构造器；tsx 原生 ESM 下需回退命名空间。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PptxGenJS = ((PptxGenJSImport as any).default ?? PptxGenJSImport) as any as typeof PptxGenJSImport;
import { getDb } from "../queries/connection";
import { callModelChat } from "./modelGateway";
import {
  SKILL_TOOL_MAP,
  saveArtifact,
  type ArtifactCtx,
  type ArtifactInfo,
  type MatchedSkill,
  type SkillToolKind,
} from "./agentTools";

// ─── 执行器类型与全量映射 ────────────────────────────────────────────────────

/** 通用执行器类别：文档成稿（产 docx）/ 分析解答（纯文本）/ 知识库问答（KB 接地纯文本）
 *  / PPT 制作（产 pptx，M20 波 2）/ Excel 报表（产 xlsx，M20 波 2） */
export type GenericExecutorKind = "llm_doc" | "llm_analysis" | "llm_kb_qa" | "llm_ppt" | "llm_sheet";
export type ExecutorKind = SkillToolKind | GenericExecutorKind;

/** 通用类技能 → 执行器类别（6 个专用技能由 SKILL_TOOL_MAP 覆盖，此处不重复） */
export const GENERIC_SKILL_EXECUTOR_MAP: Record<string, GenericExecutorKind> = {
  email_compose: "llm_doc", // 商务函件 → 函件文档
  weekly_report: "llm_doc", // 周报生成 → 周报文档
  daily_report: "llm_doc", // 日报生成（iter97 基础教育包标配） → 日报文档
  meeting_notes: "llm_doc", // 会议纪要 → 纪要文档
  task_plan: "llm_doc", // 任务拆解 → 计划文档
  mkt_copy: "llm_doc", // 营销文案 → 文案文档
  data_report: "llm_doc", // 数据分析报告 → 报告文档
  hr_jd: "llm_doc", // 招聘JD与面试题 → 招聘文档
  ecom_listing: "llm_doc", // 跨境上品文案 → listing 文档
  kb_qa: "llm_kb_qa", // 知识库问答 → KB 接地作答
  cs_faq: "llm_kb_qa", // 客服FAQ应答 → KB 接地话术
  tax_notice: "llm_analysis", // 财税实务解答 → 政策分析解答
  ppt_make: "llm_ppt", // PPT 制作（M20 波 2：LLM 大纲 → 模板库渲染 pptx）
  excel_report: "llm_sheet", // Excel 报表（M20 波 2：LLM 数据 → 模板渲染 xlsx）
};

/** 全部 20 个 st_skills 的执行器映射（专用 6 + 通用 12 + M20 波 2 新增 2：ppt_make/excel_report） */
export const SKILL_EXECUTOR_MAP: Record<string, ExecutorKind> = {
  ...SKILL_TOOL_MAP,
  ...GENERIC_SKILL_EXECUTOR_MAP,
};

/** 判断某执行器类别是否为通用类（非 6 个专用工具） */
export function isGenericExecutorKind(kind: ExecutorKind | null | undefined): kind is GenericExecutorKind {
  return (
    kind === "llm_doc" ||
    kind === "llm_analysis" ||
    kind === "llm_kb_qa" ||
    kind === "llm_ppt" ||
    kind === "llm_sheet"
  );
}

// ─── 基础工具 ────────────────────────────────────────────────────────────────

function clipT(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function stRows(statement: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  const res = (await getDb().execute(statement)) as unknown;
  if (Array.isArray(res) && Array.isArray(res[0])) return res[0] as Array<Record<string, unknown>>;
  return (res ?? []) as Array<Record<string, unknown>>;
}

/** 从用户输入提取检索关键词：中文连续段（≥2字）与拉丁词（≥3字符），去重取前 6 */
function extractKeywords(content: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (w: string) => {
    const k = w.trim();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  };
  for (const m of content.match(/[一-鿿]{2,8}/g) ?? []) push(m);
  for (const m of content.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? []) push(m.toLowerCase());
  return out.slice(0, 6);
}

// ─── KB 接地：简单 LIKE 检索，限 3 段、每段截断 500 字 ───────────────────────

export interface KbSnippet {
  title: string;
  text: string;
}

export async function searchKbSnippets(content: string): Promise<KbSnippet[]> {
  try {
    const keywords = extractKeywords(content);
    if (keywords.length === 0) return [];
    const where = sql.join(
      keywords.map((k) => sql`(title LIKE ${`%${k}%`} OR textContent LIKE ${`%${k}%`})`),
      sql` OR `,
    );
    const rows = await stRows(
      sql`SELECT title, textContent FROM st_kb_docs
          WHERE status = 'ready' AND textContent IS NOT NULL AND (${where})
          ORDER BY id DESC LIMIT 3`,
    );
    return rows.map((r) => ({
      title: clipT(String(r.title ?? "知识库文档"), 60),
      text: clipT(String(r.textContent ?? "").replace(/\s+/g, " ").trim(), 500),
    }));
  } catch {
    return []; // 表缺失/查询失败：静默无 KB 接地
  }
}

// ─── prompt 组装 ─────────────────────────────────────────────────────────────

function buildSystemPrompt(
  skill: MatchedSkill,
  kind: GenericExecutorKind,
  agentName: string,
  kbBits: KbSnippet[],
): string {
  const lines: string[] = [
    `你是企业驻部智能体「${agentName}」，正在严格执行「${skill.name}」（${skill.skillKey}）技能。`,
    `技能说明：${skill.category}类技能，请按以下要求产出成稿，直接给结果，不要解释过程。`,
  ];
  if (skill.flowSteps.length > 0) lines.push(`执行流程：${skill.flowSteps.join(" → ")}`);
  if (skill.outputTemplate) lines.push(`输出模板（结构须严格对齐）：\n${skill.outputTemplate}`);
  if (skill.qualityChecklist.length > 0) lines.push(`质量清单：${skill.qualityChecklist.join("；")}`);
  if (kbBits.length > 0) {
    const nums = ["①", "②", "③"];
    lines.push(
      "企业知识库相关资料（优先引用，引用处标注资料编号）：\n" +
        kbBits.map((b, i) => `【资料${nums[i] ?? i + 1}】《${b.title}》${b.text}`).join("\n"),
    );
  }
  if (kind === "llm_doc") {
    lines.push('输出要求：第一行为文档标题；章节用「一、」「二、」等中文序号起头；正文务实完整，不要 markdown 标记、不要 JSON。');
  } else if (kind === "llm_kb_qa") {
    lines.push("输出要求：先给结论再列依据；知识库无依据时明确说明「知识库暂无相关规定」，绝不臆造。");
  } else {
    lines.push("输出要求：结论先行，给出依据与风险提示；不确定处明确标注，绝不臆造政策条文。");
  }
  return lines.join("\n");
}

// ─── 降级：LLM 未配置/失败时按 output_template 结构化预填 ────────────────────

function fillTemplateDegraded(skill: MatchedSkill, content: string, kbBits: KbSnippet[]): string {
  const summary = clipT(content.replace(/\s+/g, " ").trim(), 120) || "（未提供具体需求）";
  let body: string;
  if (skill.outputTemplate) {
    let first = true;
    body = skill.outputTemplate.replace(/\{[^{}]{1,40}\}/g, () => {
      if (first) {
        first = false;
        return summary;
      }
      return "（待补充）";
    });
  } else {
    body = `【${skill.name}】${summary}\n\n（该技能暂无输出模板，待人工补充细化。）`;
  }
  if (skill.flowSteps.length > 0) body += `\n\n参考流程：${skill.flowSteps.join(" → ")}`;
  if (kbBits.length > 0) {
    body += `\n\n知识库相关资料：\n${kbBits.map((b, i) => `${i + 1}. 《${b.title}》${clipT(b.text, 120)}`).join("\n")}`;
  }
  return `（降级模式：智能模型暂不可用，已按技能输出模板预填草稿框架，请人工补全。）\n\n${body}`;
}

// ─── 质量自检：对照 quality_checklist 逐条 ✅/⚠️（简单规则）─────────────────

function buildQualitySelfCheck(checklist: string[], body: string, degraded: boolean): string {
  if (checklist.length === 0) return "· 本技能未配置质量清单";
  return checklist
    .map((item) => {
      if (degraded) return `⚠️ ${item}（降级模式未执行完整校验，需人工复核）`;
      const kws = extractKeywords(item).filter((k) => k.length >= 2);
      const hit = kws.length > 0 && kws.some((k) => body.includes(k));
      const longEnough = body.length >= 200;
      return `${hit && longEnough ? "✅" : "⚠️"} ${item}${hit && longEnough ? "" : "（建议人工复核）"}`;
    })
    .join("\n");
}

// ─── 文档类：LLM 成稿解析为章节并渲染真 docx ────────────────────────────────

function parseSections(
  text: string,
  fallbackTitle: string,
): { title: string; sections: Array<{ heading: string; paragraphs: string[] }> } {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const title = (lines[0] ?? fallbackTitle).replace(/^#+\s*/, "").slice(0, 60) || fallbackTitle;
  const sections: Array<{ heading: string; paragraphs: string[] }> = [];
  let cur: { heading: string; paragraphs: string[] } | null = null;
  for (const line of lines.slice(1)) {
    const h = line.match(/^(?:#+\s*)?(?:第?[一二三四五六七八九十]+[、.．]|[0-9]+[、.．])\s*(.{2,40})$/);
    if (h) {
      cur = { heading: line.replace(/^#+\s*/, "").slice(0, 50), paragraphs: [] };
      sections.push(cur);
    } else if (cur) {
      cur.paragraphs.push(clipT(line, 500));
    } else {
      cur = { heading: "正文", paragraphs: [clipT(line, 500)] };
      sections.push(cur);
    }
  }
  const valid = sections.filter((s) => s.paragraphs.length > 0);
  return { title, sections: valid.length > 0 ? valid : [{ heading: "正文", paragraphs: [clipT(text, 1500)] }] };
}

/** AI 生成内容标识（《人工智能生成合成内容标识办法》合规要求） */
const AI_GEN_DISCLAIMER = "🤖 本文档由 AI 数字员工生成，内容仅供参考，请人工复核后使用。";

async function renderDocx(
  title: string,
  sections: Array<{ heading: string; paragraphs: string[] }>,
  footer?: string,
): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: title, bold: true })] }),
  ];
  for (const sec of sections) {
    children.push(
      new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 240 }, children: [new TextRun({ text: sec.heading, bold: true })] }),
    );
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

// ─── M20 波 2：PPT 模板库（3 套，品牌浅蓝青色系，版式锁死）────────────────────
// 版式只有四种：封面 / 目录 / 内容页（标题+要点 bullets）/ 结尾页。
// LLM 只出内容页大纲（3~5 页），封面/目录/结尾由模板自动生成——排版永不交给 LLM。

export type PptTemplateKey = "biz_report" | "roadshow" | "training";

/** 封面版式路由：fullbleed 主色满铺 / whitespace 大图留白 / light 清新浅色 */
export type PptCoverStyle = "fullbleed" | "whitespace" | "light";

export interface PptTemplate {
  key: PptTemplateKey;
  name: string;
  coverStyle: PptCoverStyle;
  primary: string; // 主色（hex 无 # 前缀）
  accent: string;
  bg: string; // 封面/目录底色
  contentBg: string; // 内容页底色（三模板刻意不同，一眼可辨）
  text: string;
  subText: string;
}

export const PPT_TEMPLATES: Record<PptTemplateKey, PptTemplate> = {
  biz_report: { key: "biz_report", name: "经营汇报（沉稳蓝青）", coverStyle: "fullbleed", primary: "0E7490", accent: "67E8F9", bg: "0E7490", contentBg: "FFFFFF", text: "164E63", subText: "475569" },
  roadshow: { key: "roadshow", name: "项目路演（大图留白）", coverStyle: "whitespace", primary: "155E75", accent: "22D3EE", bg: "FFFFFF", contentBg: "FFFFFF", text: "0F172A", subText: "64748B" },
  training: { key: "training", name: "培训课件（清新浅色）", coverStyle: "light", primary: "0891B2", accent: "A5F3FC", bg: "ECFEFF", contentBg: "F0FDFA", text: "155E75", subText: "0E7490" },
};

export interface PptOutlinePage {
  title: string;
  bullets: string[];
}

export interface PptOutline {
  title: string;
  pages: PptOutlinePage[]; // 仅内容页（封面/目录/结尾模板自动加）
}

/** 按用户需求选模板：路演/融资/发布 → 项目路演；培训/课件 → 培训课件；默认经营汇报 */
export function pickPptTemplate(content: string): PptTemplate {
  if (/路演|融资|发布|招商|\bBP\b/i.test(content)) return PPT_TEMPLATES.roadshow;
  if (/培训|课件|教学|授课|学习/.test(content)) return PPT_TEMPLATES.training;
  return PPT_TEMPLATES.biz_report;
}

function llmStrArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

/** LLM 大纲 JSON 容错解析（复用 voice.ts parseUtterance 思路：剥代码围栏 → 截取首个 {...} 块 → 逐字段校验） */
export function parsePptOutline(raw: string): PptOutline | null {
  try {
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
    let candidate = (fence ? fence[1]! : raw).trim();
    if (!candidate.startsWith("{")) {
      const s = candidate.indexOf("{");
      const e = candidate.lastIndexOf("}");
      if (s < 0 || e <= s) return null;
      candidate = candidate.slice(s, e + 1);
    }
    const obj = JSON.parse(candidate) as Record<string, unknown>;
    const title = clipT(String(obj.title ?? "").trim(), 40);
    const rawPages = Array.isArray(obj.pages) ? obj.pages : Array.isArray(obj.slides) ? obj.slides : [];
    const pages: PptOutlinePage[] = [];
    for (const p of rawPages) {
      const pg = p as Record<string, unknown>;
      const t = clipT(String(pg.title ?? pg.heading ?? "").trim(), 24);
      const bullets = llmStrArray(pg.bullets)
        .map((b) => clipT(b.trim(), 40))
        .filter(Boolean)
        .slice(0, 5);
      if (t && bullets.length > 0) pages.push({ title: t, bullets });
      if (pages.length >= 5) break;
    }
    if (!title || pages.length === 0) return null;
    return { title, pages };
  } catch {
    return null;
  }
}

/** 每页统一页脚：AI 生成合规标识（小字克制；深色页传浅色，浅色页传灰） */
const PPT_PAGE_FOOTER = "灵枢 AI 生成 · 请人工复核后使用";

type PptSlide = InstanceType<typeof PptxGenJSImport> extends { addSlide(): infer S } ? S : never;

function addPptPageFooter(slide: PptSlide, color: string, x = 0.4): void {
  slide.addText(PPT_PAGE_FOOTER, { x, y: 5.32, w: 4.5, h: 0.25, fontSize: 9, color, align: "left" });
}

// ── 三套版式分支：封面 / 目录 / 内容页 / 结尾页各自按 coverStyle 走不同排版 ──────

/** fullbleed 经营汇报：深青满铺封面 + 白色大标题 + 底部 accent 条 */
function renderFullbleedCover(slide: PptSlide, t: PptTemplate, outline: PptOutline, footer: string): void {
  slide.background = { color: t.primary };
  slide.addShape("rect", { x: 0, y: 4.9, w: 10, h: 0.12, fill: { color: t.accent } });
  slide.addText(outline.title, { x: 0.8, y: 1.7, w: 8.4, h: 1.5, fontSize: 36, bold: true, color: "FFFFFF", align: "center", valign: "middle" });
  slide.addText(footer, { x: 0.8, y: 3.5, w: 8.4, h: 0.6, fontSize: 14, color: t.accent, align: "center" });
  addPptPageFooter(slide, t.accent);
}

/** whitespace 项目路演：白底 + 左侧 60% 超大深灰标题 + 细 accent 竖线/色带点缀，绝不满铺 */
function renderWhitespaceCover(slide: PptSlide, t: PptTemplate, outline: PptOutline, footer: string): void {
  slide.background = { color: t.bg }; // FFFFFF
  slide.addShape("rect", { x: 0.55, y: 1.7, w: 0.06, h: 2.0, fill: { color: t.accent } }); // 标题左侧细竖线
  slide.addText(outline.title, { x: 0.85, y: 1.5, w: 6.0, h: 2.4, fontSize: 44, bold: true, color: t.text, align: "left", valign: "middle" });
  slide.addText(footer, { x: 0.85, y: 4.1, w: 6.0, h: 0.5, fontSize: 12, color: t.subText, align: "left" });
  slide.addShape("rect", { x: 8.4, y: 5.3, w: 1.6, h: 0.09, fill: { color: t.accent } }); // 右下角细色带
  addPptPageFooter(slide, t.subText, 0.85);
}

/** light 培训课件：浅青底色 + 深青标题 + 圆形/圆角色块装饰 */
function renderLightCover(slide: PptSlide, t: PptTemplate, outline: PptOutline, footer: string): void {
  slide.background = { color: t.bg }; // ECFEFF
  slide.addShape("ellipse", { x: 8.0, y: -0.7, w: 2.6, h: 2.6, fill: { color: t.accent } }); // 右上圆形装饰
  slide.addShape("roundRect", { x: -0.6, y: 4.2, w: 2.2, h: 1.8, rectRadius: 0.18, fill: { color: t.accent } }); // 左下圆角色块
  slide.addText(outline.title, { x: 1.0, y: 1.9, w: 8.0, h: 1.4, fontSize: 34, bold: true, color: t.text, align: "center", valign: "middle" });
  slide.addText(footer, { x: 1.0, y: 3.6, w: 8.0, h: 0.5, fontSize: 13, color: t.subText, align: "center" });
  addPptPageFooter(slide, t.subText);
}

function renderToc(slide: PptSlide, t: PptTemplate, outline: PptOutline): void {
  if (t.coverStyle === "whitespace") {
    // 路演目录：极简页码式（大号 accent 数字 + 标题，无底色无色带）
    slide.background = { color: t.bg };
    slide.addText("目录", { x: 0.85, y: 0.5, w: 3, h: 0.6, fontSize: 20, bold: true, color: t.subText, align: "left" });
    slide.addShape("rect", { x: 0.85, y: 1.15, w: 0.8, h: 0.05, fill: { color: t.accent } });
    slide.addText(
      outline.pages.flatMap((p, i) => [
        { text: `${String(i + 1).padStart(2, "0")}  `, options: { fontSize: 26, bold: true, color: t.accent } },
        { text: p.title, options: { fontSize: 20, color: t.text, breakLine: true, paraSpaceAfter: 18 } },
      ]),
      { x: 0.85, y: 1.5, w: 8.0, h: 3.6 },
    );
    addPptPageFooter(slide, t.subText, 0.85);
    return;
  }
  // 经营汇报/培训课件：顶部色带 + 编号罗列；培训课件标题左侧加小色块图标感
  slide.background = { color: t.coverStyle === "light" ? t.bg : t.contentBg };
  slide.addShape("rect", { x: 0, y: 0, w: 10, h: 0.14, fill: { color: t.accent } });
  const titleX = t.coverStyle === "light" ? 1.05 : 0.7;
  if (t.coverStyle === "light") {
    slide.addShape("roundRect", { x: 0.62, y: 0.58, w: 0.3, h: 0.3, rectRadius: 0.06, fill: { color: t.primary } });
  }
  slide.addText("目录", { x: titleX, y: 0.5, w: 8.6, h: 0.8, fontSize: 28, bold: true, color: t.primary });
  slide.addText(
    outline.pages.map((p, i) => ({ text: `${i + 1}. ${p.title}`, options: { fontSize: 18, color: t.text, breakLine: true, paraSpaceAfter: 14 } })),
    { x: 1.0, y: 1.6, w: 8.0, h: 3.6 },
  );
  addPptPageFooter(slide, t.subText);
}

function renderContentSlide(slide: PptSlide, t: PptTemplate, p: PptOutlinePage, pageNo: number): void {
  if (t.coverStyle === "whitespace") {
    // 路演内容页：白底 + 32pt 大标题 + 要点 1.5 倍行距 + 页脚细线页码
    slide.background = { color: t.contentBg };
    slide.addText(p.title, { x: 0.85, y: 0.45, w: 8.3, h: 0.9, fontSize: 32, bold: true, color: t.text, align: "left" });
    slide.addShape("rect", { x: 0.85, y: 1.42, w: 1.2, h: 0.05, fill: { color: t.accent } });
    slide.addText(
      p.bullets.map((b) => ({ text: b, options: { bullet: { code: "2022" }, fontSize: 16, color: t.text, breakLine: true, lineSpacing: 24, paraSpaceAfter: 8 } })),
      { x: 0.95, y: 1.75, w: 8.1, h: 3.1 },
    );
    slide.addShape("rect", { x: 0.85, y: 5.08, w: 8.3, h: 0.014, fill: { color: "CBD5E1" } }); // 页脚细线
    slide.addText(String(pageNo), { x: 8.85, y: 5.14, w: 0.3, h: 0.28, fontSize: 10, color: t.subText, align: "right" });
    addPptPageFooter(slide, t.subText, 0.85);
    return;
  }
  // 经营汇报：白底 + 深青标题 + 顶部色带；培训课件：浅灰青底 + 标题左侧小色块图标感
  slide.background = { color: t.contentBg };
  slide.addShape("rect", { x: 0, y: 0, w: 10, h: 0.14, fill: { color: t.accent } });
  const titleX = t.coverStyle === "light" ? 1.05 : 0.7;
  if (t.coverStyle === "light") {
    slide.addShape("roundRect", { x: 0.62, y: 0.5, w: 0.3, h: 0.3, rectRadius: 0.06, fill: { color: t.primary } });
  }
  slide.addText(p.title, { x: titleX, y: 0.42, w: 8.6, h: 0.8, fontSize: 24, bold: true, color: t.coverStyle === "light" ? t.text : t.primary });
  slide.addText(
    p.bullets.map((b) => ({ text: b, options: { bullet: { code: "2022" }, fontSize: 16, color: t.text, breakLine: true, paraSpaceAfter: 10 } })),
    { x: 0.9, y: 1.5, w: 8.2, h: 3.6 },
  );
  addPptPageFooter(slide, t.subText);
}

function renderEndSlide(slide: PptSlide, t: PptTemplate, footer: string): void {
  if (t.coverStyle === "whitespace") {
    // 路演结尾：白底居中大标题「谢谢」+ 一行小字联系行
    slide.background = { color: t.bg };
    slide.addShape("rect", { x: 4.4, y: 3.45, w: 1.2, h: 0.06, fill: { color: t.accent } });
    slide.addText("谢谢", { x: 0.8, y: 2.1, w: 8.4, h: 1.2, fontSize: 44, bold: true, color: t.text, align: "center" });
    slide.addText(`期待与您进一步交流 · ${footer}`, { x: 0.8, y: 3.7, w: 8.4, h: 0.4, fontSize: 12, color: t.subText, align: "center" });
    addPptPageFooter(slide, t.subText, 0.85);
    return;
  }
  if (t.coverStyle === "light") {
    // 培训结尾：浅底 + 鼓励语
    slide.background = { color: t.bg };
    slide.addShape("ellipse", { x: 8.4, y: 4.0, w: 2.2, h: 2.2, fill: { color: t.accent } });
    slide.addText("学以致用，天天进步", { x: 0.8, y: 2.1, w: 8.4, h: 1.0, fontSize: 32, bold: true, color: t.primary, align: "center" });
    slide.addText("谢谢观看", { x: 0.8, y: 3.3, w: 8.4, h: 0.5, fontSize: 16, color: t.subText, align: "center" });
    addPptPageFooter(slide, t.subText);
    return;
  }
  // 经营汇报结尾：主色满铺致谢
  slide.background = { color: t.primary };
  slide.addText("谢谢观看", { x: 0.8, y: 2.0, w: 8.4, h: 1.0, fontSize: 32, bold: true, color: "FFFFFF", align: "center" });
  addPptPageFooter(slide, t.accent);
}

/** 模板渲染：封面 + 目录 + 内容页（标题+要点）+ 结尾页，版式按 coverStyle 分支锁死在模板内 */
export async function renderPptxFromOutline(
  template: PptTemplate,
  outline: PptOutline,
  footer: string,
): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 10 x 5.625 in
  pptx.title = outline.title;
  const t = template;

  // 封面（pptxgenjs 内部负责 XML 转义）
  const cover = pptx.addSlide();
  if (t.coverStyle === "whitespace") renderWhitespaceCover(cover, t, outline, footer);
  else if (t.coverStyle === "light") renderLightCover(cover, t, outline, footer);
  else renderFullbleedCover(cover, t, outline, footer);

  // 目录：内容页标题编号罗列（≥2 页时才给目录，单页不凑版式）
  const hasToc = outline.pages.length >= 2;
  if (hasToc) renderToc(pptx.addSlide(), t, outline);

  // 内容页
  outline.pages.forEach((p, i) => {
    renderContentSlide(pptx.addSlide(), t, p, 1 + (hasToc ? 1 : 0) + i + 1);
  });

  // 结尾页
  renderEndSlide(pptx.addSlide(), t, footer);

  const out = await pptx.write({ outputType: "nodebuffer" });
  return out as Buffer;
}

// ─── M20 波 2：Excel 报表模板（2 套，数据源接 briefText 同源企业实况）──────────

export type SheetTemplateKey = "biz_three_col" | "ledger_detail";

export interface SheetTemplate {
  key: SheetTemplateKey;
  name: string;
}

export const SHEET_TEMPLATES: Record<SheetTemplateKey, SheetTemplate> = {
  biz_three_col: { key: "biz_three_col", name: "经营数据三栏表（指标/数值/环比说明）" },
  ledger_detail: { key: "ledger_detail", name: "台账明细表（表头+行数据）" },
};

/** 台账/明细/清单/记录 → 台账明细表；默认经营数据三栏表 */
export function pickSheetTemplate(content: string): SheetTemplate {
  if (/台账|明细|清单|记录|流水/.test(content)) return SHEET_TEMPLATES.ledger_detail;
  return SHEET_TEMPLATES.biz_three_col;
}

export interface SheetData {
  title: string;
  columns: string[];
  rows: string[][];
  summary?: string;
}

/** LLM 报表 JSON 容错解析（同 parsePptOutline 哲学）；三栏表把 {metric,value,note} 对象行拍平 */
export function parseSheetData(raw: string, templateKey: SheetTemplateKey): SheetData | null {
  try {
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
    let candidate = (fence ? fence[1]! : raw).trim();
    if (!candidate.startsWith("{")) {
      const s = candidate.indexOf("{");
      const e = candidate.lastIndexOf("}");
      if (s < 0 || e <= s) return null;
      candidate = candidate.slice(s, e + 1);
    }
    const obj = JSON.parse(candidate) as Record<string, unknown>;
    const title = clipT(String(obj.title ?? "").trim(), 60);
    const summary = obj.summary ? clipT(String(obj.summary).trim(), 200) : undefined;
    let columns: string[];
    let rows: string[][];
    if (templateKey === "biz_three_col") {
      columns = ["指标", "数值", "环比说明"];
      rows = (Array.isArray(obj.rows) ? obj.rows : [])
        .map((r) => {
          if (Array.isArray(r)) return r.map((x) => clipT(String(x).trim(), 60)).slice(0, 3);
          const o = r as Record<string, unknown>;
          return [o.metric, o.value, o.note].map((x) => clipT(String(x ?? "").trim(), 60));
        })
        .filter((r) => r.length === 3 && r[0] && r[1])
        .slice(0, 20);
    } else {
      columns = llmStrArray(obj.columns).map((c) => clipT(c.trim(), 24)).filter(Boolean).slice(0, 8);
      rows = (Array.isArray(obj.rows) ? obj.rows : [])
        .map((r) => llmStrArray(r).map((x) => clipT(x.trim(), 60)))
        .filter((r) => r.length >= Math.min(columns.length, 2))
        .slice(0, 50);
    }
    if (!title || columns.length === 0 || rows.length === 0) return null;
    return { title, columns, rows, summary };
  } catch {
    return null;
  }
}

export function renderXlsxFromData(data: SheetData): Buffer {
  const aoa: string[][] = [[data.title], [], data.columns, ...data.rows];
  if (data.summary) aoa.push([], [`结论：${data.summary}`]);
  aoa.push([], [AI_GEN_DISCLAIMER]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = data.columns.map(() => ({ wch: 22 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "报表");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

// ─── M20 波 2：llm_ppt / llm_sheet 执行（LLM 出内容 → 模板渲染 → 落盘台账）────

/** 降级大纲：LLM 失败时用企业实况 + 用户需求预填框架，数字只取实况原文 */
function fallbackPptOutline(content: string, brief: string, skillName: string): PptOutline {
  const summary = clipT(content.replace(/\s+/g, " ").trim(), 40) || "（未提供具体需求）";
  const facts = brief
    .replace(/^【本厂实时实况】/, "")
    .replace(/。回答数字以此为准，禁止编造。?$/, "")
    .split(/[，。；]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
  return {
    title: clipT(summary, 20) || skillName,
    pages: [
      { title: "需求与目标", bullets: [summary, "（降级模式：智能模型暂不可用，以下为预填框架，请人工补全）"] },
      ...(facts.length > 0 ? [{ title: "企业实况（实时数据）", bullets: facts }] : []),
      { title: "后续建议", bullets: ["（待人工补充）"] },
    ].slice(0, 5),
  };
}

/** 降级报表：三栏表从实况正则抽取「名称+数字」行；台账表给单行预填 */
function fallbackSheetData(templateKey: SheetTemplateKey, content: string, brief: string, skillName: string): SheetData {
  const summary = clipT(content.replace(/\s+/g, " ").trim(), 60) || "（未提供具体需求）";
  if (templateKey === "biz_three_col") {
    const rows: string[][] = [];
    for (const m of brief.matchAll(/([\u4e00-\u9fa5A-Za-z ]{2,12}?)\s*(\d+)\s*条?员?/g)) {
      rows.push([m[1]!.trim(), m[2]!, "实况口径，环比待人工补充"]);
      if (rows.length >= 6) break;
    }
    if (rows.length === 0) rows.push(["（降级模式：暂无实况数据可抽取）", "-", "请人工补充"]);
    return { title: clipT(summary, 30) || skillName, columns: ["指标", "数值", "环比说明"], rows, summary: "降级模式：智能模型暂不可用，数值取自本厂实时实况。" };
  }
  return {
    title: clipT(summary, 30) || skillName,
    columns: ["序号", "事项", "说明"],
    rows: [["1", summary, "（降级模式：智能模型暂不可用，请人工补全明细行）"]],
  };
}

async function executeOfficeSkill(
  kind: "llm_ppt" | "llm_sheet",
  opts: {
    skill: MatchedSkill;
    content: string;
    agentName: string;
    contextBrief?: string;
    factoryId?: number | null;
    ctx?: ArtifactCtx;
  },
): Promise<GenericSkillResult> {
  const { skill } = opts;
  const content = clipT(opts.content ?? "", 2000);
  const brief = clipT(opts.contextBrief ?? "", 800);
  const today = new Date().toISOString().slice(0, 10);
  const discipline = "数据纪律：所有数字必须来自用户需求或给定企业实况，禁止编造；无数据支撑时用定性表述。";

  const instruction =
    kind === "llm_ppt"
      ? [
          `你是「${skill.name}」技能的 PPT 大纲助手。只输出一个 JSON 对象，不要输出任何其他文字、不要 markdown 代码围栏。`,
          "结构约束（模板版式锁死，你只填内容）：只输出 3~5 个内容页；封面、目录、结尾页由模板自动生成，不要输出。",
          'JSON 结构（字段名必须完全一致）：{"title":"演示主题（≤20字）","pages":[{"title":"页标题（≤16字）","bullets":["要点，每条≤30字，每页3~5条"]}]}',
          discipline,
          skill.flowSteps.length > 0 ? `技能流程：${skill.flowSteps.join(" → ")}` : "",
          skill.qualityChecklist.length > 0 ? `质量要求：${skill.qualityChecklist.join("；")}` : "",
          brief ? `企业实况（回答数字以此为准）：\n${brief}` : "",
          `用户需求：${content || "（未提供具体需求，按技能模板给通用大纲）"}`,
        ]
      : (() => {
          const tpl = pickSheetTemplate(content);
          const schema =
            tpl.key === "biz_three_col"
              ? '{"title":"报表标题","rows":[{"metric":"指标","value":"数值","note":"环比说明"}],"summary":"一句话结论"}'
              : '{"title":"报表标题","columns":["列1","列2","列3"],"rows":[["值1","值2","值3"]],"summary":"一句话结论"}';
          return [
            `你是「${skill.name}」技能的报表数据助手（模板：${tpl.name}）。只输出一个 JSON 对象，不要输出任何其他文字、不要 markdown 代码围栏。`,
            `JSON 结构（字段名必须完全一致）：${schema}`,
            tpl.key === "biz_three_col" ? "要求：3~8 行指标；数值必须取自企业实况或用户需求。" : "要求：columns 3~6 列，rows 3~15 行。",
            discipline,
            skill.flowSteps.length > 0 ? `技能流程：${skill.flowSteps.join(" → ")}` : "",
            brief ? `企业实况（回答数字以此为准）：\n${brief}` : "",
            `用户需求：${content || "（未提供具体需求，按技能模板给通用报表）"}`,
          ];
        })();

  const res = await callModelChat({
    messages: [{ role: "user", content: instruction.filter(Boolean).join("\n") }],
    maxTokens: 1800,
    timeoutMs: 45_000,
  });
  const raw = res.ok && res.content ? String(res.content) : "";

  let artifact: ArtifactInfo | undefined;
  let body: string;
  let degraded: boolean;

  if (kind === "llm_ppt") {
    const template = pickPptTemplate(content);
    const parsed = raw ? parsePptOutline(raw) : null;
    const outline = parsed ?? fallbackPptOutline(content, brief, skill.name);
    degraded = !parsed;
    if (opts.ctx) {
      try {
        const buf = await renderPptxFromOutline(template, outline, `（制作：${opts.ctx.agentCode} 驻部智能体，${today}${degraded ? " · 降级草稿" : ""}）`);
        artifact = await saveArtifact(opts.ctx, skill.skillKey, "pptx", outline.title, "pptx", buf, {
          executor: "generic",
          template: template.key,
          degraded,
          factoryId: opts.factoryId ?? null,
          userNeed: clipT(content, 200),
        });
      } catch {
        artifact = undefined; // 渲染/落盘失败不影响文本回复
      }
    }
    body =
      `已按「${template.name}」模板生成 PPT《${outline.title}》：` +
      `封面 + ${outline.pages.length >= 2 ? "目录 + " : ""}${outline.pages.length} 页内容（${outline.pages.map((p) => p.title).join("、")}）+ 结尾页。` +
      (degraded ? "\n（降级模式：智能模型暂不可用，大纲为预填框架，请人工补全。）" : "");
  } else {
    const template = pickSheetTemplate(content);
    const parsed = raw ? parseSheetData(raw, template.key) : null;
    const data = parsed ?? fallbackSheetData(template.key, content, brief, skill.name);
    degraded = !parsed;
    if (opts.ctx) {
      try {
        const buf = renderXlsxFromData(data);
        artifact = await saveArtifact(opts.ctx, skill.skillKey, "xlsx", data.title, "xlsx", buf, {
          executor: "generic",
          template: template.key,
          degraded,
          factoryId: opts.factoryId ?? null,
          userNeed: clipT(content, 200),
        });
      } catch {
        artifact = undefined;
      }
    }
    const preview = [data.columns.join(" | "), ...data.rows.slice(0, 5).map((r) => r.join(" | "))].join("\n");
    body =
      `已按「${template.name}」模板整理 Excel《${data.title}》（${data.rows.length} 行 × ${data.columns.length} 列），预览：\n${preview}` +
      (data.summary ? `\n结论：${data.summary}` : "") +
      (degraded ? "\n（降级模式：智能模型暂不可用，数据取自企业实况/预填框架，请人工复核。）" : "");
  }

  const check = buildQualitySelfCheck(skill.qualityChecklist, body, degraded);
  const tail = ["【质量自检】", check];
  if (artifact) tail.push(`已生成${kind === "llm_ppt" ? " PPT" : " Excel"}文件《${artifact.title}》，点击下方附件即可下载。`);
  return { text: `${body}\n\n${tail.join("\n")}`, artifact, degraded };
}

// ─── 统一入口：通用技能真执行 ────────────────────────────────────────────────

export interface GenericSkillResult {
  text: string;
  artifact?: ArtifactInfo;
  degraded?: boolean;
}

export async function executeGenericSkill(opts: {
  skill: MatchedSkill;
  content: string;
  agentName: string;
  agentCode?: string;
  factoryId?: number | null;
  ctx?: ArtifactCtx;
  /** M20 波 2：briefText 同源企业实况（llm_ppt/llm_sheet 数据源，由路由层传入，禁止编造） */
  contextBrief?: string;
}): Promise<GenericSkillResult> {
  const { skill } = opts;
  const agentName = clipT(opts.agentName || "驻部智能体", 40);
  try {
    const content = clipT(opts.content ?? "", 4000);
    const mapped = SKILL_EXECUTOR_MAP[skill.skillKey];
    const kind: GenericExecutorKind = isGenericExecutorKind(mapped) ? mapped : "llm_analysis";

    // M20 波 2：PPT / Excel 走模板渲染专线（LLM 出内容、模板管排版、产 pptx/xlsx）
    if (kind === "llm_ppt" || kind === "llm_sheet") {
      return await executeOfficeSkill(kind, {
        skill,
        content,
        agentName,
        contextBrief: opts.contextBrief,
        factoryId: opts.factoryId,
        ctx: opts.ctx,
      });
    }

    const kbBits = await searchKbSnippets(content);

    // 真 LLM 通道：多 provider 故障转移；未配置/失败 → 模板降级
    const res = await callModelChat({
      messages: [
        { role: "system", content: buildSystemPrompt(skill, kind, agentName, kbBits) },
        { role: "user", content: content || "（未提供具体需求，请按技能模板给出通用成稿框架）" },
      ],
      maxTokens: 1500,
      timeoutMs: 30_000,
    });
    const llmText = res.ok && res.content ? String(res.content).trim() : "";
    const degraded = llmText.length === 0;
    const body = degraded ? fillTemplateDegraded(skill, content, kbBits) : clipT(llmText, 6000);

    // 文档类技能：解析章节 → 渲染真 docx → 落盘台账（需调用方提供产出物上下文）
    let artifact: ArtifactInfo | undefined;
    if (kind === "llm_doc" && opts.ctx) {
      try {
        const { title, sections } = parseSections(body, `${skill.name}成稿`);
        const today = new Date().toISOString().slice(0, 10);
        // AI 标识已由 renderDocx 内置（AI_GEN_DISCLAIMER 页脚，M44 合规）
        const buf = await renderDocx(title, sections, `（拟稿：${opts.ctx.agentCode} 驻部智能体，${today}${degraded ? " · 降级草稿" : ""}）`);
        artifact = await saveArtifact(opts.ctx, skill.skillKey, "docx", title, "docx", buf, {
          executor: "generic",
          degraded,
          factoryId: opts.factoryId ?? null,
          userNeed: clipT(content, 200),
        });
      } catch {
        artifact = undefined; // 渲染/落盘失败不影响文本回复
      }
    }

    const check = buildQualitySelfCheck(skill.qualityChecklist, body, degraded);
    const tail = [`【质量自检】`, check];
    if (artifact) tail.push(`已生成 Word 文档《${artifact.title}》，点击下方附件即可下载。`);
    return { text: `${body}\n\n${tail.join("\n")}`, artifact, degraded };
  } catch {
    // 兜底：任何异常都退化为模板降级文本，绝不抛错
    try {
      const body = fillTemplateDegraded(skill, clipT(opts.content ?? "", 4000), []);
      return {
        text: `${body}\n\n【质量自检】\n${buildQualitySelfCheck(skill.qualityChecklist, body, true)}`,
        degraded: true,
      };
    } catch {
      return { text: `【${clipT(skill.name, 40)}】技能执行暂不可用，请稍后重试。`, degraded: true };
    }
  }
}
