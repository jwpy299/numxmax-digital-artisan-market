/**
 * M20 波 2「PPT 制作 + Excel 报表执行器」验收单测：
 * 1. 执行器映射：ppt_make→llm_ppt、excel_report→llm_sheet（SKILL_EXECUTOR_MAP 全量 19）。
 * 2. 大纲 JSON 容错解析：代码围栏/散文包裹/非法 JSON/超页超限截断。
 * 3. 3 套模板渲染合法 zip：[Content_Types].xml 存在、slide 数 = 封面+目录+内容页+结尾页。
 * 4. 要点 XML 转义：含 &<>" 的文本渲染后 slide XML 无未转义字符。
 * 5. xlsx 两模板合法：三栏表/台账明细表均为合法 zip 且可被 XLSX 读回行数据。
 * 6. 执行器接波 1 投递：runVoiceSkill(ppt_make) 真链路 → attachment kind=file + /files/ 48hex 链接落盘。
 * 7. LLM 失败兜底：callModelChat 失败 → 降级大纲仍产 pptx + degraded 标记，绝不抛错。
 */
import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

const chatMock = vi.fn();

vi.mock("./routers/modelGateway", () => ({
  callSlotChat: (...args: unknown[]) => chatMock(...args),
  callSlotChatFast: vi.fn(async () => {
    throw new Error("fast lane disabled in tests");
  }),
  callModelChat: (...args: unknown[]) => chatMock(...args),
}));

vi.mock("./routers/voiceBuddy", () => ({
  buildOrgBrief: async () => ({
    todayIntents: 12,
    pendingConfirms: 3,
    executedTotal: 88,
    deptCount: 2,
    roleCount: 36,
    frozen: false,
  }),
}));

// ─── 状态ful 假 DB ───────────────────────────────────────────────────────────

const ST_SKILL_ROWS = [
  {
    skill_key: "ppt_make",
    name: "PPT制作",
    description: "按主题生成品牌模板 PPT",
    category: "办公",
    slot: "chat",
    trigger_hints: '["做个PPT","幻灯片","汇报演示"]',
    flow_steps: '["理解主题","出大纲","模板渲染"]',
    output_template: "【PPT大纲】封面→目录→内容→结尾",
    quality_checklist: '["大纲结构完整","每页要点不超过 5 条"]',
  },
  {
    skill_key: "excel_report",
    name: "Excel报表",
    description: "拉企业实况数据成 Excel 报表",
    category: "办公",
    slot: "chat",
    trigger_hints: '["拉个表","Excel","报表"]',
    flow_steps: '["确认类型","取实况数据","模板渲染"]',
    output_template: "【报表】三栏表/台账明细表",
    quality_checklist: '["数值取自企业实况"]',
  },
];

let skillCallInserts: Array<Record<string, unknown>>;

function route(text: string): unknown {
  if (text.includes("FROM st_skills")) return [ST_SKILL_ROWS.map((r) => ({ ...r }))];
  if (text.includes("INSERT INTO st_skill_calls")) {
    return [[]];
  }
  if (text.includes("FROM st_skill_calls")) return [[{ c: 0 }]];
  if (text.includes("INSERT INTO st_agent_artifacts")) return [[{ insertId: 42 }]];
  if (text.includes("FROM st_kb_docs")) return [[]];
  if (text.includes("FROM skills s")) return [[]];
  return [[]];
}

vi.mock("./queries/connection", async () => {
  const { MySqlDialect } = await import("drizzle-orm/mysql-core");
  const dialect = new MySqlDialect();
  return {
    getDb: () => ({
      execute: async (stmt: unknown) => {
        const q = dialect.sqlToQuery(stmt as never);
        return route(q.sql);
      },
    }),
  };
});

import {
  GENERIC_SKILL_EXECUTOR_MAP,
  isGenericExecutorKind,
  parsePptOutline,
  parseSheetData,
  pickPptTemplate,
  PPT_TEMPLATES,
  renderPptxFromOutline,
  renderXlsxFromData,
  SKILL_EXECUTOR_MAP,
  type PptOutline,
  type SheetData,
} from "./routers/skillExecutor";
import { runVoiceSkill, deliverArtifactFile, type VisibleSkill } from "./routers/voiceSkills";

let artifactDir: string;
let filesDir: string;

beforeAll(async () => {
  artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "m20w2-artifacts-"));
  filesDir = await fs.mkdtemp(path.join(os.tmpdir(), "m20w2-files-"));
  process.env.ST_ARTIFACT_DIR = artifactDir;
  process.env.VOICE_FILES_DIR = filesDir;
});

afterAll(async () => {
  delete process.env.ST_ARTIFACT_DIR;
  delete process.env.VOICE_FILES_DIR;
  await fs.rm(artifactDir, { recursive: true, force: true });
  await fs.rm(filesDir, { recursive: true, force: true });
});

beforeEach(() => {
  chatMock.mockReset();
  skillCallInserts = [];
  void skillCallInserts;
});

const DEMO_OUTLINE: PptOutline = {
  title: "三季度经营汇报",
  pages: [
    { title: "业绩总览", bullets: ["今日意图 12 条", "待确认 3 条", "累计执行 88 条"] },
    { title: "军团编制", bullets: ["2 部门 36 员", "冻结状态：正常"] },
    { title: "后续计划", bullets: ["推进培训", "复盘周报"] },
  ],
};

async function slideNames(buf: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buf);
  return Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort();
}

// ─── ① 执行器映射 ────────────────────────────────────────────────────────────

describe("执行器映射", () => {
  it("ppt_make→llm_ppt、excel_report→llm_sheet，全量映射 19 个且均为通用类", () => {
    expect(GENERIC_SKILL_EXECUTOR_MAP.ppt_make).toBe("llm_ppt");
    expect(GENERIC_SKILL_EXECUTOR_MAP.excel_report).toBe("llm_sheet");
    expect(SKILL_EXECUTOR_MAP.ppt_make).toBe("llm_ppt");
    expect(SKILL_EXECUTOR_MAP.excel_report).toBe("llm_sheet");
    expect(Object.keys(SKILL_EXECUTOR_MAP)).toHaveLength(20); // 专用 6 + 通用 12 + 波 2 新增 2
    expect(isGenericExecutorKind("llm_ppt")).toBe(true);
    expect(isGenericExecutorKind("llm_sheet")).toBe(true);
  });

  it("模板选择：路演关键词→roadshow、培训关键词→training、默认经营汇报", () => {
    expect(pickPptTemplate("帮我做个项目路演融资 PPT").key).toBe("roadshow");
    expect(pickPptTemplate("给新员工做培训课件").key).toBe("training");
    expect(pickPptTemplate("三季度经营汇报").key).toBe("biz_report");
  });
});

// ─── ② 大纲 JSON 容错解析 ────────────────────────────────────────────────────

describe("parsePptOutline 容错", () => {
  it("代码围栏 / 散文包裹 / slides 别名都能解析；非法 JSON 返回 null", () => {
    const fenced = parsePptOutline('```json\n{"title":"T","pages":[{"title":"P1","bullets":["a"]}]}\n```');
    expect(fenced?.title).toBe("T");
    expect(fenced?.pages).toHaveLength(1);

    const prosey = parsePptOutline('好的，大纲如下：{"title":"T2","slides":[{"heading":"P","bullets":["x","y"]}]} 以上。');
    expect(prosey?.title).toBe("T2");
    expect(prosey?.pages[0]?.title).toBe("P");

    expect(parsePptOutline("完全不是 JSON")).toBeNull();
    expect(parsePptOutline('{"title":"只有标题"}')).toBeNull();
    expect(parsePptOutline('{"pages":[{"title":"P","bullets":["a"]}]}')).toBeNull();
  });

  it("超限截断：内容页最多 5 页、每页最多 5 条要点、字段长度截断", () => {
    const raw = JSON.stringify({
      title: "超长标题".repeat(20),
      pages: Array.from({ length: 8 }, (_, i) => ({
        title: `页${i}`,
        bullets: Array.from({ length: 7 }, (_, j) => `要点${j}`),
      })),
    });
    const o = parsePptOutline(raw)!;
    expect(o.pages).toHaveLength(5);
    for (const p of o.pages) expect(p.bullets.length).toBeLessThanOrEqual(5);
    expect(o.title.length).toBeLessThanOrEqual(41); // 40 + 可能的省略号
  });
});

// ─── ③ 3 套模板渲染合法 zip ─────────────────────────────────────────────────

describe("PPT 模板渲染", () => {
  it.each(Object.values(PPT_TEMPLATES))("$name：合法 zip，slide 数 = 封面+目录+内容页+结尾页", async (tpl) => {
    const buf = await renderPptxFromOutline(tpl, DEMO_OUTLINE, "（测试落款）");
    expect(buf.length).toBeGreaterThan(1000);
    const zip = await JSZip.loadAsync(buf);
    expect(zip.file("[Content_Types].xml")).not.toBeNull();
    // 3 页内容 → 封面 1 + 目录 1 + 内容 3 + 结尾 1 = 6
    const slides = await slideNames(buf);
    expect(slides).toHaveLength(1 + 1 + DEMO_OUTLINE.pages.length + 1);
    // 内容页标题真实出现在 slide3（封面、目录之后第一页内容）
    const slide3 = await zip.file("ppt/slides/slide3.xml")!.async("string");
    expect(slide3).toContain("业绩总览");
  });

  it("单页内容不给目录页（slide 数 = 封面+内容+结尾 = 3）", async () => {
    const buf = await renderPptxFromOutline(PPT_TEMPLATES.biz_report, { title: "T", pages: [DEMO_OUTLINE.pages[0]!] }, "f");
    expect(await slideNames(buf)).toHaveLength(3);
  });

  it("三模板版式参数刻意不同：coverStyle 枚举路由 + 封面/内容页底色一眼可辨", () => {
    // coverStyle 枚举正确路由
    expect(PPT_TEMPLATES.biz_report.coverStyle).toBe("fullbleed");
    expect(PPT_TEMPLATES.roadshow.coverStyle).toBe("whitespace");
    expect(PPT_TEMPLATES.training.coverStyle).toBe("light");
    // 封面背景色三模板互不相同（深青满铺 / 白底留白 / 浅青清新）
    const coverBgs = Object.values(PPT_TEMPLATES).map((t) => t.bg);
    expect(new Set(coverBgs).size).toBe(3);
    // 内容页底色至少两种（培训浅灰青 #F0FDFA 须区别于白底）
    expect(PPT_TEMPLATES.training.contentBg).toBe("F0FDFA");
    expect(PPT_TEMPLATES.training.contentBg).not.toBe(PPT_TEMPLATES.biz_report.contentBg);
    expect(new Set(Object.values(PPT_TEMPLATES).map((t) => t.contentBg)).size).toBeGreaterThanOrEqual(2);
  });

  it("三模板渲染产物互不相同（版式差异 → XML 不同 → 字节数不同），且封面/内容页底色落在 slide XML", async () => {
    const bufs = await Promise.all(
      Object.values(PPT_TEMPLATES).map((tpl) => renderPptxFromOutline(tpl, DEMO_OUTLINE, "（测试落款）")),
    );
    // 返工验收锚点：三个文件字节数必须不同（此前 bug：仅换色导致字节数相同）
    expect(new Set(bufs.map((b) => b.length)).size).toBe(3);
    // 封面底色抽查：slide1 背景色 = 各模板 bg
    for (const [i, tpl] of Object.values(PPT_TEMPLATES).entries()) {
      const zip = await JSZip.loadAsync(bufs[i]!);
      const slide1 = await zip.file("ppt/slides/slide1.xml")!.async("string");
      expect(slide1).toContain(`srgbClr val="${tpl.bg}"`);
      // 内容页底色抽查：slide3 = 各模板 contentBg
      const slide3 = await zip.file("ppt/slides/slide3.xml")!.async("string");
      expect(slide3).toContain(`srgbClr val="${tpl.contentBg}"`);
    }
  });
});

// ─── ④ 要点 XML 转义 ────────────────────────────────────────────────────────

describe("XML 转义", () => {
  it("含 &<>\" 的要点渲染后 slide XML 全部转义，无裸特殊字符", async () => {
    const nasty: PptOutline = {
      title: 'A&B <"测试">',
      pages: [{ title: 'T<&>', bullets: ['对比 A&B 与 <C> "D"', "正常要点"] }],
    };
    const buf = await renderPptxFromOutline(PPT_TEMPLATES.training, nasty, "f");
    const zip = await JSZip.loadAsync(buf);
    const slide = await zip.file("ppt/slides/slide2.xml")!.async("string");
    expect(slide).toContain("&amp;");
    expect(slide).toContain("&lt;");
    expect(slide).toContain("&gt;");
    expect(slide).not.toContain("A&B 与 <C>");
    // 整份 XML 仍可被解析器接受（合法 zip 已由 JSZip 验证，这里抽查无未转义裸 &）
    expect(slide).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#)/); // # = 数字字符引用（如 &#x2022;）
  });
});

// ─── ⑤ xlsx 两模板合法 ──────────────────────────────────────────────────────

describe("Excel 模板渲染", () => {
  it("经营数据三栏表：{metric,value,note} 对象行解析 + 合法 zip + 可读回", async () => {
    const parsed = parseSheetData(
      '```json\n{"title":"经营实况","rows":[{"metric":"今日意图","value":"12","note":"环比 +2"},{"metric":"累计执行","value":"88","note":"-"}],"summary":"执行正常"}\n```',
      "biz_three_col",
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.columns).toEqual(["指标", "数值", "环比说明"]);
    expect(parsed!.rows[0]).toEqual(["今日意图", "12", "环比 +2"]);

    const buf = renderXlsxFromData(parsed!);
    const zip = await JSZip.loadAsync(buf);
    expect(zip.file("[Content_Types].xml")).not.toBeNull();
    expect(zip.file("xl/workbook.xml")).not.toBeNull();
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buf, { type: "buffer" });
    const aoa = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1 });
    expect(aoa[0]).toEqual(["经营实况"]);
    expect(aoa[2]).toEqual(["指标", "数值", "环比说明"]);
    expect(aoa[3]).toEqual(["今日意图", "12", "环比 +2"]);
  });

  it("台账明细表：columns+rows 解析渲染合法；缺行/缺列返回 null", async () => {
    const parsed = parseSheetData(
      '{"title":"设备台账","columns":["序号","设备","状态"],"rows":[["1","冲压机","正常"],["2","空压机","点检中"]]}',
      "ledger_detail",
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.rows).toHaveLength(2);
    const buf = renderXlsxFromData(parsed!);
    const zip = await JSZip.loadAsync(buf);
    expect(zip.file("[Content_Types].xml")).not.toBeNull();

    expect(parseSheetData('{"title":"x","columns":[],"rows":[]}', "ledger_detail")).toBeNull();
    expect(parseSheetData("not json", "biz_three_col")).toBeNull();
  });
});

// ─── ⑥⑦ 执行器全链路（接波 1 投递）──────────────────────────────────────────

const stripSecrets = (t: string) => t;
const VISIBLE: VisibleSkill[] = [
  { skillKey: "ppt_make", name: "PPT制作", description: "按主题生成品牌模板 PPT", pricePerCall: 100 },
  { skillKey: "excel_report", name: "Excel报表", description: "拉实况数据成报表", pricePerCall: 100 },
];

function runOpts(skillKey: string, text: string) {
  return {
    factoryId: 10,
    sessionId: 1,
    username: "TEST_boss",
    persona: "lingshu" as const,
    skillKey,
    text,
    visible: VISIBLE,
    stripSecrets,
  };
}

describe("runVoiceSkill 全链路", () => {
  it("ppt_make：LLM 大纲 → 模板渲染 → deliverArtifactFile 产出 /files/ 48hex 链接（文件真实落盘）", async () => {
    chatMock.mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        title: "三季度经营汇报",
        pages: [
          { title: "业绩总览", bullets: ["今日意图 12 条", "待确认 3 条", "累计执行 88 条"] },
          { title: "军团编制", bullets: ["2 部门 36 员"] },
        ],
      }),
    });
    const r = await runVoiceSkill(runOpts("ppt_make", "帮我做个三季度经营汇报 PPT"));
    expect(r).toMatchObject({ kind: "skill", ok: true });
    if (r.kind !== "skill" || !r.ok) throw new Error("unreachable");
    expect(r.attachment?.kind).toBe("file");
    expect(r.attachment?.url).toMatch(/^\/files\/[0-9a-f]{48}\.pptx$/);
    // 文件真实落盘且为合法 pptx
    const delivered = await fs.readFile(path.join(filesDir, path.basename(r.attachment!.url!)));
    const zip = await JSZip.loadAsync(delivered);
    expect(zip.file("[Content_Types].xml")).not.toBeNull();
    expect(r.reply).toContain("已办好");
    expect(r.reply).toContain("24 小时内有效");
    // LLM 收到了企业实况（数据源同源 briefText，禁止编造纪律继承）
    const prompt = String(chatMock.mock.calls[0][0].messages[0].content);
    expect(prompt).toContain("今日意图 12 条");
    expect(prompt).toContain("禁止编造");
  });

  it("excel_report：LLM 数据 → 三栏表渲染 → /files/ xlsx 链接", async () => {
    chatMock.mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        title: "经营实况三栏表",
        rows: [
          { metric: "今日意图", value: "12", note: "实况" },
          { metric: "累计执行", value: "88", note: "实况" },
        ],
        summary: "运转正常",
      }),
    });
    const r = await runVoiceSkill(runOpts("excel_report", "拉个经营数据报表"));
    expect(r).toMatchObject({ kind: "skill", ok: true });
    if (r.kind !== "skill" || !r.ok) throw new Error("unreachable");
    expect(r.attachment?.kind).toBe("file");
    expect(r.attachment?.url).toMatch(/^\/files\/[0-9a-f]{48}\.xlsx$/);
    const delivered = await fs.readFile(path.join(filesDir, path.basename(r.attachment!.url!)));
    const zip = await JSZip.loadAsync(delivered);
    expect(zip.file("xl/workbook.xml")).not.toBeNull();
  });

  it("LLM 失败兜底：降级大纲仍产 pptx + 降级提示，绝不抛错", async () => {
    chatMock.mockResolvedValue({ ok: false, reason: "not_configured" });
    const r = await runVoiceSkill(runOpts("ppt_make", "做个经营汇报 PPT"));
    expect(r).toMatchObject({ kind: "skill", ok: true });
    if (r.kind !== "skill" || !r.ok) throw new Error("unreachable");
    expect(r.reply).toContain("降级");
    expect(r.attachment?.kind).toBe("file");
    expect(r.attachment?.url).toMatch(/\.pptx$/);
    const delivered = await fs.readFile(path.join(filesDir, path.basename(r.attachment!.url!)));
    const zip = await JSZip.loadAsync(delivered);
    expect(zip.file("[Content_Types].xml")).not.toBeNull();
    // 降级大纲数据取自实况（今日意图 12 条进入要点）
    const slideXml = await zip.file("ppt/slides/slide3.xml")!.async("string");
    expect(slideXml).toContain("12");
  });

  it("deliverArtifactFile 直连：48hex + 24h lazy 清理纪律不变（波 1 行为回归）", async () => {
    const artifact = { id: 9, kind: "pptx", title: "样例", filename: "sample.pptx", sizeBytes: 4 };
    await fs.writeFile(path.join(artifactDir, "sample.pptx"), Buffer.from("demo"));
    const url = await deliverArtifactFile(artifact);
    expect(url).toMatch(/^\/files\/[0-9a-f]{48}\.pptx$/);
    await expect(fs.access(path.join(filesDir, path.basename(url!)))).resolves.toBeUndefined();
  });
});

// ─── SheetData 类型引用（防未使用告警）────────────────────────────────────────
const _typeCheck: SheetData | null = null;
void _typeCheck;
