/**
 * skills —— 双用途路由：
 * ① 匠市技能上架（create，既有能力，drizzle skills 表）；
 * ② 迭代 30「数字员工技能体系」：技能库（st_skills）+ 挂载（st_agent_skills）+
 *    种子技能与自动挂载。st_ 表由 db/sync-ops.mts 幂等创建，一律 raw SQL 访问。
 * 鉴权：管理类操作 requireAdmin（token 只在请求体）；byAgentPublic 免登录（匠市展示）。
 */
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { agents, skills } from "@db/schema";
import { rawRows, requireAdmin } from "./terminal";
import { getSkillEffectiveness } from "./agentTools";

const tokenInput = z.object({ token: z.string().trim().min(1) });

/** st_ 表查询兜底：表缺失按空集降级（seed 前的部署窗口） */
async function stRows(statement: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  try {
    return rawRows(await getDb().execute(statement));
  } catch {
    return [];
  }
}

/** JSON 列安全解析（驱动可能返回 string 或已解析对象） */
function parseJsonArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ─── 迭代 30 种子技能（契约 §4：≥12 个，五件套齐全）─────────────────────────
interface SkillSeed {
  skillKey: string;
  name: string;
  layer: "general" | "professional" | "industry";
  category: string;
  description: string;
  triggerHints: string[];
  flowSteps: string[];
  slot: string;
  outputTemplate: string;
  qualityChecklist: string[];
  /** professional/industry 自动挂载匹配关键词（命中任一即挂载） */
  matchKeywords: string[];
}

export const SKILL_SEEDS: SkillSeed[] = [
  {
    skillKey: "doc_write",
    name: "文档撰写",
    layer: "general",
    category: "办公",
    description: "按主题与用途撰写结构完整、语气得体的中文办公文档（通知、方案、纪要、制度草案）。",
    triggerHints: ["写一份", "起草", "拟定", "帮我写个文档", "出个方案"],
    flowSteps: ["明确文档类型/读者/目的", "列提纲并确认关键论点", "分段撰写正文", "自查格式与措辞", "输出定稿并附修改建议"],
    slot: "brain",
    outputTemplate: "【{文档类型}】{标题}\n\n一、背景与目的\n{正文}\n\n二、主要内容\n{正文}\n\n三、执行与安排\n{正文}\n\n（拟稿：{员工名}，{日期}）",
    qualityChecklist: ["标题与文种匹配", "结构含背景/主体/安排三段", "无口语化表达", "关键信息（时间/责任人/数字）无缺失"],
    matchKeywords: [],
  },
  {
    skillKey: "sheet_stats",
    name: "表格整理",
    layer: "general",
    category: "办公",
    description: "把杂乱数据整理为规范表格口径，给出汇总统计与可读结论。",
    triggerHints: ["整理成表", "统计一下", "汇总数据", "做个表格"],
    flowSteps: ["识别字段与口径", "清洗并归类数据", "计算合计/占比/环比", "输出表格与结论"],
    slot: "flash",
    outputTemplate: "【数据整理结果】\n| 项目 | 数值 | 占比 | 备注 |\n|---|---|---|---|\n{数据行}\n\n结论：{一句话结论}",
    qualityChecklist: ["口径说明清晰", "合计与明细对得上", "结论有数据支撑"],
    matchKeywords: [],
  },
  {
    skillKey: "ppt_draft",
    name: "演示大纲",
    layer: "general",
    category: "办公",
    description: "为汇报/路演场景生成 PPT 大纲：页面结构、每页要点与演讲备注。",
    triggerHints: ["做个PPT", "演示大纲", "汇报提纲", "路演稿"],
    flowSteps: ["明确受众与时长", "设计叙事主线", "拆分页结构", "逐页写要点与备注"],
    slot: "orggen",
    outputTemplate: "【PPT大纲】{主题}\n第1页 封面：{标题+副标题}\n第2页 目录\n{分页要点}\n尾页 总结与行动项\n演讲备注：{每页一句}",
    qualityChecklist: ["主线清晰（问题→方案→收益→行动）", "页数与时长匹配", "每页要点≤5条"],
    matchKeywords: [],
  },
  {
    skillKey: "email_compose",
    name: "商务函件",
    layer: "general",
    category: "沟通",
    description: "撰写商务邮件/函件：称谓规范、目的明确、礼貌收尾，适配对内对外场景。",
    triggerHints: ["写封邮件", "发个函", "回复客户邮件", "商务函件"],
    flowSteps: ["确认对象/事项/语气", "写主题行", "正文三段（缘由/事项/请求）", "礼貌收尾与署名"],
    slot: "chat",
    outputTemplate: "主题：{事项}事宜\n\n尊敬的{称谓}：\n您好！{缘由}\n{事项正文}\n烦请{请求事项}，期待回复。\n\n此致\n敬礼\n{署名} {日期}",
    qualityChecklist: ["主题行具体", "称谓与语气匹配对象", "有明确请求与时限"],
    matchKeywords: [],
  },
  {
    skillKey: "kb_qa",
    name: "知识库问答",
    layer: "general",
    category: "知识",
    description: "基于企业知识库检索并作答：先引用后归纳，无依据时明确说不知道。",
    triggerHints: ["查一下", "知识库里有没有", "按制度规定", "资料怎么说"],
    flowSteps: ["解析问题关键词", "检索知识库片段", "基于引用归纳答案", "标注来源与不确定项"],
    slot: "chat",
    outputTemplate: "【回答】{结论}\n\n依据：\n1. {引用片段一}\n2. {引用片段二}\n\n备注：{不确定项或建议人工确认}",
    qualityChecklist: ["结论有引用支撑", "无引用不臆造", "标注来源条目"],
    matchKeywords: [],
  },
  {
    skillKey: "task_plan",
    name: "任务拆解",
    layer: "general",
    category: "协同",
    description: "把目标拆解为可执行任务清单：负责人、交付物、时间节点与依赖关系。",
    triggerHints: ["拆解一下", "列个计划", "分工安排", "怎么落地"],
    flowSteps: ["澄清目标与约束", "拆为3-8个任务", "标注负责人/交付物/截止", "梳理依赖与风险"],
    slot: "flash",
    outputTemplate: "【任务拆解】{目标}\n| # | 任务 | 负责人 | 交付物 | 截止 | 依赖 |\n|---|---|---|---|---|---|\n{任务行}\n风险与建议：{风险点}",
    qualityChecklist: ["任务可独立验收", "每项有负责人与截止", "依赖关系无环"],
    matchKeywords: [],
  },
  {
    skillKey: "weekly_report",
    name: "周报生成",
    layer: "general",
    category: "办公",
    description: "汇总一周工作为规范周报：本周完成、数据亮点、问题与下周计划。",
    triggerHints: ["写周报", "本周总结", "周报生成"],
    flowSteps: ["收集本周事项与数据", "归类完成/进行中/阻塞", "提炼亮点与问题", "输出下周计划"],
    slot: "orggen",
    outputTemplate: "【周报】{姓名} {周期}\n一、本周完成\n{事项}\n二、数据与亮点\n{亮点}\n三、问题与风险\n{问题}\n四、下周计划\n{计划}",
    qualityChecklist: ["四段齐全", "有量化数据", "问题附解决建议"],
    matchKeywords: [],
  },
  {
    skillKey: "meeting_notes",
    name: "会议纪要",
    layer: "general",
    category: "沟通",
    description: "把会议记录整理为纪要：议题、结论、行动项（负责人+截止）。",
    triggerHints: ["整理纪要", "会议纪要", "会议记录"],
    flowSteps: ["识别议题与参会人", "提炼每议题结论", "抽取行动项", "标注未决事项"],
    slot: "chat",
    outputTemplate: "【会议纪要】{主题} {日期}\n参会：{人员}\n一、议题与结论\n{结论}\n二、行动项\n| 事项 | 负责人 | 截止 |\n|---|---|---|\n{行动项}\n三、未决事项：{未决}",
    qualityChecklist: ["行动项含负责人与截止", "结论与讨论分离", "未决事项单独列出"],
    matchKeywords: [],
  },
  {
    skillKey: "mkt_copy",
    name: "营销文案",
    layer: "professional",
    category: "市场",
    description: "产出营销文案：卖点提炼、标题组、正文与行动号召，适配多渠道投放。",
    triggerHints: ["写文案", "推广语", "广告语", "朋友圈文案", "卖点提炼"],
    flowSteps: ["明确产品/受众/渠道", "提炼1个核心卖点+3个支撑点", "写3组标题", "写正文与CTA", "按渠道裁剪长度"],
    slot: "creative",
    outputTemplate: "【营销文案】{产品/活动}\n核心卖点：{卖点}\n标题组：\n1. {标题A}\n2. {标题B}\n3. {标题C}\n正文：{正文}\n行动号召：{CTA}",
    qualityChecklist: ["卖点单一聚焦", "标题含数字或利益点", "CTA 明确可执行"],
    matchKeywords: ["市场", "营销", "品牌", "CMO"],
  },
  {
    skillKey: "data_report",
    name: "数据分析报告",
    layer: "professional",
    category: "数据",
    description: "把业务数据转化为分析报告：指标口径、趋势解读、归因与建议。",
    triggerHints: ["数据分析", "经营分析", "数据报告", "分析一下数据"],
    flowSteps: ["确认指标口径", "计算趋势与结构占比", "归因分析（至少2个假设）", "输出结论与建议"],
    slot: "orggen",
    outputTemplate: "【数据分析报告】{主题} {周期}\n一、核心指标：{指标表}\n二、趋势解读：{解读}\n三、归因分析：{归因}\n四、结论与建议：{建议}",
    qualityChecklist: ["口径先行说明", "结论均有数据支撑", "建议可落地且量化"],
    matchKeywords: ["运营", "数据"],
  },
  {
    skillKey: "cs_faq",
    name: "客服FAQ应答",
    layer: "professional",
    category: "客服",
    description: "面向常见咨询的标准化应答：语气友好、答案准确、附转人工提示。",
    triggerHints: ["客户问", "FAQ", "怎么回复客户", "客服话术"],
    flowSteps: ["识别咨询意图", "匹配标准答案", "组织友好话术", "附转人工/升级提示"],
    slot: "flash",
    outputTemplate: "【应答建议】意图：{意图}\n话术：{标准话术}\n补充说明：{补充}\n如未解决：建议转人工并备注{工单要点}",
    qualityChecklist: ["答案与知识库一致", "语气友好无推诿", "含升级路径"],
    matchKeywords: ["客服", "服务"],
  },
  {
    skillKey: "hr_jd",
    name: "招聘JD与面试题",
    layer: "professional",
    category: "人事",
    description: "生成招聘岗位 JD（职责/要求/亮点）与结构化面试题（含评分要点）。",
    triggerHints: ["写个JD", "招聘启事", "面试题", "岗位要求"],
    flowSteps: ["明确岗位与级别", "写职责（5-7条）与要求（必备/加分）", "写雇主亮点", "出5道结构化面试题含评分点"],
    slot: "orggen",
    outputTemplate: "【招聘JD】{岗位}（{级别}）\n岗位职责：\n{职责}\n任职要求：\n必备：{必备}\n加分：{加分}\n我们能提供：{亮点}\n\n【面试题】\n{题目+评分要点}",
    qualityChecklist: ["职责可衡量", "要求分必备/加分", "面试题附评分要点"],
    matchKeywords: ["人事", "HR", "招聘"],
  },
  {
    skillKey: "ecom_listing",
    name: "跨境电商上品文案",
    layer: "industry",
    category: "跨境电商",
    description: "生成跨境平台上品文案：多语言标题、五点描述、关键词与合规检查。",
    triggerHints: ["上品", "listing", "亚马逊文案", "跨境标题"],
    flowSteps: ["提取产品参数与卖点", "写标题（含核心关键词）", "写五点描述", "整理搜索关键词", "合规自查（禁词/夸大）"],
    slot: "creative",
    outputTemplate: "【Listing】{产品}\n标题：{标题}\n五点描述：\n1. {要点}\n2. {要点}\n3. {要点}\n4. {要点}\n5. {要点}\n搜索关键词：{关键词}\n合规提示：{提示}",
    qualityChecklist: ["标题含核心关键词", "五点覆盖卖点/场景/保障", "无违禁夸大词"],
    matchKeywords: ["跨境", "电商"],
  },
  {
    skillKey: "tax_notice",
    name: "财税实务解答",
    layer: "industry",
    category: "财税",
    description: "解答中小企业常见财税实务问题：政策依据、计算示例与风险提示。",
    triggerHints: ["发票", "报税", "增值税", "个税", "财税咨询"],
    flowSteps: ["识别税种与场景", "检索现行政策依据", "给计算示例", "提示风险与申报时限", "建议重大事项咨询税务师"],
    slot: "brain",
    outputTemplate: "【财税解答】{问题}\n政策依据：{依据}\n计算示例：{示例}\n风险提示：{风险}\n申报时限：{时限}\n说明：重大涉税事项请以主管税务机关及执业税务师意见为准。",
    qualityChecklist: ["引用现行有效政策", "示例计算正确", "有风险与时限提示", "含免责与转介建议"],
    matchKeywords: ["财税", "财务", "会计"],
  },
];

/** professional/industry 自动挂载：匹配文本 = name+industry+industryGroup+capabilityTags */
function agentMatchText(agent: Record<string, unknown>): string {
  const tags = parseJsonArray(agent.capabilityTags).map(String).join(" ");
  return [agent.name, agent.industry, agent.industryGroup, tags]
    .filter(Boolean)
    .map(String)
    .join(" ");
}

/** 幂等写入种子技能（ON DUPLICATE KEY UPDATE）+ 自动挂载，返回统计 */
export async function seedSkillsAndMount(): Promise<{ skills: number; mounts: number }> {
  const db = getDb();
  for (const s of SKILL_SEEDS) {
    await db.execute(
      sql`INSERT INTO st_skills
            (skill_key, name, layer, category, description, trigger_hints, flow_steps, slot, output_template, quality_checklist, status)
          VALUES (${s.skillKey}, ${s.name}, ${s.layer}, ${s.category}, ${s.description},
            ${JSON.stringify(s.triggerHints)}, ${JSON.stringify(s.flowSteps)}, ${s.slot},
            ${s.outputTemplate}, ${JSON.stringify(s.qualityChecklist)}, 'active')
          ON DUPLICATE KEY UPDATE
            name = VALUES(name), layer = VALUES(layer), category = VALUES(category),
            description = VALUES(description), trigger_hints = VALUES(trigger_hints),
            flow_steps = VALUES(flow_steps), slot = VALUES(slot),
            output_template = VALUES(output_template), quality_checklist = VALUES(quality_checklist)`,
    );
  }
  // industryGroup/capabilityTags 在部分库尚缺列：逐个降级重试，保证挂载不中断
  const colSets = [
    "id, name, industry, industryGroup, capabilityTags",
    "id, name, industry, capabilityTags",
    "id, name, industry",
  ];
  let agentRows: Array<Record<string, unknown>> = [];
  for (const cols of colSets) {
    agentRows = await stRows(sql.raw(`SELECT ${cols} FROM agents WHERE status = 'active'`));
    if (agentRows.length > 0) break;
  }
  let mounts = 0;
  const generalKeys = SKILL_SEEDS.filter((s) => s.layer === "general").map((s) => s.skillKey);
  for (const agent of agentRows) {
    const agentId = Number(agent.id);
    const text = agentMatchText(agent);
    const keys = new Set<string>(generalKeys);
    for (const s of SKILL_SEEDS) {
      if (s.layer === "general") continue;
      if (s.matchKeywords.some((kw) => text.toLowerCase().includes(kw.toLowerCase()))) {
        keys.add(s.skillKey);
      }
    }
    for (const key of keys) {
      const res = (await db.execute(
        sql`INSERT IGNORE INTO st_agent_skills (agent_id, skill_key, enabled) VALUES (${agentId}, ${key}, 1)`,
      )) as unknown;
      const affected = Number(
        (Array.isArray(res) && (res[0] as { affectedRows?: number })?.affectedRows) || 0,
      );
      mounts += affected;
    }
  }
  return { skills: SKILL_SEEDS.length, mounts };
}

export const skillsRouter = createRouter({
  /** baseSkills（query，免登录）：基础教育包·标配办公技能（st_base_skills，全部数字员工出生自带） */
  baseSkills: publicQuery.query(async () => {
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT skill_key AS skillKey, title, executor, badge, intro FROM st_base_skills WHERE enabled = 1 ORDER BY id`,
      ),
    );
    return { items: rows };
  }),

  // ─── 迭代 30：技能库管理 ──────────────────────────────────────────────────
  /** list（query，admin）：全技能 + 挂载数统计 */
  list: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const rows = await stRows(
      sql`SELECT s.skill_key, s.name, s.layer, s.category, s.description, s.slot, s.status,
                 (SELECT COUNT(*) FROM st_agent_skills m WHERE m.skill_key = s.skill_key) AS mounts
          FROM st_skills s ORDER BY s.layer, s.skill_key`,
    );
    return rows.map((r) => ({
      skillKey: String(r.skill_key),
      name: String(r.name),
      layer: String(r.layer),
      category: String(r.category ?? ""),
      description: String(r.description ?? ""),
      slot: String(r.slot ?? ""),
      status: String(r.status ?? "active"),
      mounts: Number(r.mounts ?? 0),
    }));
  }),

  /** effectiveness（query，admin）：迭代57 技能效果统计——产出物采纳/驳回按 skill_key 聚合（与排序加权同源） */
  effectiveness: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const eff = await getSkillEffectiveness();
    return [...eff.entries()].map(([skillKey, e]) => ({
      skillKey,
      uses: e.uses,
      adopted: e.adopted,
      rejected: e.rejected,
      adoptRate: e.adopted + e.rejected > 0 ? Math.round((e.adopted / (e.adopted + e.rejected)) * 100) : null,
      boost: Math.max(-3, Math.min(3, e.adopted - e.rejected)) * 0.5,
    }));
  }),

  /** agentSkills（query，admin）：某员工的技能挂载 + proficiency/revisions */
  agentSkills: publicQuery
    .input(tokenInput.extend({ agentId: z.number().int().positive() }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const rows = await stRows(
        sql`SELECT m.skill_key, m.enabled, m.proficiency, m.revisions, m.created_at,
                   s.name, s.layer, s.category, s.description, s.slot
            FROM st_agent_skills m
            LEFT JOIN st_skills s ON s.skill_key = m.skill_key
            WHERE m.agent_id = ${input.agentId}
            ORDER BY s.layer, m.skill_key`,
      );
      return rows.map((r) => ({
        skillKey: String(r.skill_key),
        enabled: Number(r.enabled) === 1,
        proficiency: Number(r.proficiency ?? 0),
        revisions: Number(r.revisions ?? 0),
        createdAt: r.created_at ? new Date(String(r.created_at)) : null,
        name: r.name == null ? String(r.skill_key) : String(r.name),
        layer: r.layer == null ? null : String(r.layer),
        category: r.category == null ? "" : String(r.category),
        description: r.description == null ? "" : String(r.description),
        slot: r.slot == null ? "" : String(r.slot),
      }));
    }),

  /** seed（mutation，admin）：幂等种子 + 自动挂载 */
  seed: publicQuery.input(tokenInput).mutation(async ({ input }) => {
    await requireAdmin(input.token);
    return seedSkillsAndMount();
  }),

  /** mount（mutation，admin）：挂载技能到员工（幂等） */
  mount: publicQuery
    .input(tokenInput.extend({ agentId: z.number().int().positive(), skillKey: z.string().trim().min(1).max(64) }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const skillRows = await stRows(
        sql`SELECT skill_key FROM st_skills WHERE skill_key = ${input.skillKey} LIMIT 1`,
      );
      if (skillRows.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "技能不存在" });
      }
      await getDb().execute(
        sql`INSERT INTO st_agent_skills (agent_id, skill_key, enabled)
            VALUES (${input.agentId}, ${input.skillKey}, 1)
            ON DUPLICATE KEY UPDATE enabled = 1`,
      );
      return { ok: true as const };
    }),

  /** unmount（mutation，admin）：卸载技能 */
  unmount: publicQuery
    .input(tokenInput.extend({ agentId: z.number().int().positive(), skillKey: z.string().trim().min(1).max(64) }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      await getDb().execute(
        sql`DELETE FROM st_agent_skills WHERE agent_id = ${input.agentId} AND skill_key = ${input.skillKey}`,
      );
      return { ok: true as const };
    }),

  /** setEnabled（mutation，admin）：启停挂载 */
  setEnabled: publicQuery
    .input(
      tokenInput.extend({
        agentId: z.number().int().positive(),
        skillKey: z.string().trim().min(1).max(64),
        enabled: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      await getDb().execute(
        sql`UPDATE st_agent_skills SET enabled = ${input.enabled ? 1 : 0}
            WHERE agent_id = ${input.agentId} AND skill_key = ${input.skillKey}`,
      );
      return { ok: true as const };
    }),

  // ─── 迭代 40：管理后台匠市技能展示面（只读，补全 154 条 V/U 技能可见性）───
  /** marketSkillOverview（query，admin）：匠市 V/U 技能全量总览 + 所属坐席 */
  marketSkillOverview: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const rows = await stRows(
      sql`SELECT s.id, s.agentId, s.name, s.type, s.complexity, s.pricePerCall, s.callCount, s.successRate, s.description,
                 a.name AS agentName, a.code AS agentCode, a.industryGroup
          FROM skills s LEFT JOIN agents a ON a.id = s.agentId
          ORDER BY s.agentId, s.callCount DESC, s.id`,
    );
    return rows.map((r) => ({
      id: Number(r.id),
      agentId: Number(r.agentId),
      agentName: r.agentName == null ? `#${r.agentId}` : String(r.agentName),
      agentCode: r.agentCode == null ? "" : String(r.agentCode),
      industryGroup: r.industryGroup == null ? "" : String(r.industryGroup),
      name: String(r.name),
      type: String(r.type),
      complexity: Number(r.complexity ?? 0),
      pricePerCall: Number(r.pricePerCall ?? 0),
      callCount: Number(r.callCount ?? 0),
      successRate: Number(r.successRate ?? 0),
      description: r.description == null ? "" : String(r.description),
    }));
  }),

  /** marketSkillsByAgent（query，admin）：单个坐席的匠市 V/U 技能（坐席管理页面板用） */
  marketSkillsByAgent: publicQuery
    .input(tokenInput.extend({ agentId: z.number().int().positive() }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const rows = await stRows(
        sql`SELECT id, name, type, complexity, pricePerCall, callCount, successRate, description
            FROM skills WHERE agentId = ${input.agentId}
            ORDER BY callCount DESC, id`,
      );
      return rows.map((r) => ({
        id: Number(r.id),
        name: String(r.name),
        type: String(r.type),
        complexity: Number(r.complexity ?? 0),
        pricePerCall: Number(r.pricePerCall ?? 0),
        callCount: Number(r.callCount ?? 0),
        successRate: Number(r.successRate ?? 0),
        description: r.description == null ? "" : String(r.description),
      }));
    }),

  /** byAgentPublic（query，免登录）：匠市展示用，仅 name/layer/description */
  byAgentPublic: publicQuery
    .input(z.object({ agentId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const rows = await stRows(
        sql`SELECT s.name, s.layer, s.description
            FROM st_agent_skills m JOIN st_skills s ON s.skill_key = m.skill_key
            WHERE m.agent_id = ${input.agentId} AND m.enabled = 1 AND s.status = 'active'
            ORDER BY s.layer, s.name`,
      );
      return rows.map((r) => ({
        name: String(r.name),
        layer: String(r.layer),
        description: String(r.description ?? ""),
      }));
    }),

  /** 上架技能（需登录）：写入 skills 并关联到所选 Agent，同步冗余 skillCount */
  create: authedQuery
    .input(
      z.object({
        agentId: z.number().int().positive(),
        name: z.string().trim().min(2).max(128),
        type: z.enum(["V", "U"]), // V=动作 U=判断逻辑
        complexity: z.number().int().min(1).max(5),
        pricePerCall: z.number().int().min(1).max(100_000),
        description: z.string().trim().max(255).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .limit(1);
      if (!agent) {
        throw new TRPCError({ code: "NOT_FOUND", message: "所属 Agent 不存在" });
      }
      const [{ id }] = await db
        .insert(skills)
        .values({
          agentId: input.agentId,
          name: input.name,
          type: input.type,
          complexity: input.complexity,
          pricePerCall: input.pricePerCall,
          description: input.description ?? null,
        })
        .$returningId();
      await db
        .update(agents)
        .set({ skillCount: sql`${agents.skillCount} + 1` })
        .where(eq(agents.id, input.agentId));
      const [skill] = await db
        .select()
        .from(skills)
        .where(eq(skills.id, id))
        .limit(1);
      return skill;
    }),
});
