/**
 * wbOrg —— 迭代 21「组织架构智能配置（公司大脑 + 部门 Agent 数字员工）」服务端路由。
 *
 * 约定（与 terminal.ts 一致）：
 * - 所有 procedure 输入都携带 { token, ... }（token 只在请求体）；
 * - 一律 sessionMe(token) 鉴权，factoryId 取本人企业，绝不接受传参；
 * - 新表（wb_brain_agent / wb_dept_agents / wb_org_chat_*）由 db/sync-wb-org.mts
 *   幂等创建，本文件一律 raw SQL 访问，不改 drizzle schema；
 * - LLM 只允许经 terminal.ts 的 llmReplyOrDegraded（callModelChat 故障转移 + 静默降级），
 *   失败一律回退确定性规则文案并 degraded 标注，错误原因/密钥绝不暴露给前端。
 */
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { wbDeptHeads, wbFactories, type WbFactory, type WbUser } from "@db/schema";
import { sessionMe } from "./wbSession";
import { buildContextDigest, clip, llmReplyOrDegraded, rawRows } from "./terminal";
import type { LlmMessage } from "./modelGateway";

const tokenInput = z.object({ token: z.string().trim().min(1) });

const ADMIN_ONLY = "仅企业负责人可执行该操作";
const BRAIN_ADMIN_ONLY = "仅企业负责人可与公司大脑对话";
const CROSS_DEPT_DENIED = "仅可与本部门数字员工对话";
const ORG_TABLES_HINT =
  "组织架构智能配置数据表未初始化，请先在服务器执行 db/sync-wb-org.mts 后再操作";

/** wb_org_* 表查询统一兜底：表缺失时给出友好提示 */
async function orgQuery(statement: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  try {
    return rawRows(await getDb().execute(statement));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (/doesn't exist|ER_NO_SUCH_TABLE/i.test(msg)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: ORG_TABLES_HINT });
    }
    throw err;
  }
}

/** 本企业 admin/owner 校验 */
function requireAdminRole(user: WbUser) {
  if (user.role !== "admin" && user.role !== "owner") {
    throw new TRPCError({ code: "FORBIDDEN", message: ADMIN_ONLY });
  }
}

/** 部门负责人判定：wb_dept_heads 命中 且 本人 departmentId=deptId */
async function isDeptHead(user: WbUser): Promise<boolean> {
  if (!user.departmentId) return false;
  const db = getDb();
  const [hit] = await db
    .select({ id: wbDeptHeads.id })
    .from(wbDeptHeads)
    .where(
      and(
        eq(wbDeptHeads.factoryId, user.factoryId),
        eq(wbDeptHeads.deptId, user.departmentId),
        eq(wbDeptHeads.userId, user.id),
      ),
    )
    .limit(1);
  return !!hit;
}

/** 企业画像摘要（注入 LLM 上下文） */
function factoryDigest(factory: WbFactory): string {
  return clip(
    [
      `企业名称：${factory.enterpriseName}`,
      `行业：${[factory.industry, factory.industryGroup, factory.industryText].filter(Boolean).join(" / ")}`,
      `人员规模：${factory.headcount}`,
      factory.painPoints ? `业务痛点：${factory.painPoints}` : "",
      factory.departments.length
        ? `现有部门：${factory.departments.map((d) => d.name).join("、")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    600,
  );
}

// ─── orgSmartSetup 确定性分类与模板 ──────────────────────────────────────────
const ECOM_KEYS = ["电商", "电子商务", "网店", "零售", "贸易", "跨境"];
/** 明显不属于制造/电商的关键词 → 走 LLM 生成部门清单 */
const NON_MFG_KEYS = ["咨询", "软件", "物流", "餐饮", "教育", "医疗", "法律", "文化传媒", "设计", "互联网", "信息服务", "财税", "财务", "会计", "税务", "代账", "审计"];

interface DeptSpec {
  deptId: string;
  deptName: string;
  duty: string;
  agentName: string;
  title: string;
}

const ECOM_DEPTS: DeptSpec[] = [
  { deptId: "finance", deptName: "财务部", duty: "资金管理、成本核算、平台对账与经营分析", agentName: "星算", title: "财务官" },
  { deptId: "supply-chain", deptName: "供应链管理部", duty: "选品备货、仓储物流与供应商协同", agentName: "链通", title: "供应链官" },
  { deptId: "sales", deptName: "销售部", duty: "店铺运营、营销推广与客户转化", agentName: "售赢", title: "销售官" },
];

const MFG_DEPTS: DeptSpec[] = [
  { deptId: "finance", deptName: "财务部", duty: "资金管理、成本核算与经营分析", agentName: "星算", title: "财务官" },
  { deptId: "procurement", deptName: "采购部", duty: "物料采购、供应商管理与成本压降", agentName: "采明", title: "采购官" },
  { deptId: "sales", deptName: "销售部", duty: "市场开拓、订单跟进与客户维护", agentName: "售赢", title: "销售官" },
  { deptId: "tech", deptName: "技术部", duty: "工艺研发、技术支持与持续改进", agentName: "技衡", title: "技术官" },
  { deptId: "production", deptName: "生产部", duty: "生产计划、现场管理与质量保障", agentName: "产稳", title: "生产官" },
];

/** 确定性分类：先判电商，再判明显非制造（LLM），默认制造模板 */
function classifyOrg(factory: WbFactory, businessNote?: string): "ecommerce" | "llm" | "manufacturing" {
  const text = [
    factory.industry,
    factory.industryText ?? "",
    factory.industryGroup ?? "",
    businessNote ?? "",
    factory.painPoints ?? "",
  ].join(" ");
  if (ECOM_KEYS.some((k) => text.includes(k))) return "ecommerce";
  if (NON_MFG_KEYS.some((k) => text.includes(k))) return "llm";
  return "manufacturing";
}

/** LLM 生成部门清单（3-8 个），解析失败返回 null */
async function llmDepartments(factory: WbFactory, businessNote?: string): Promise<DeptSpec[] | null> {
  const reply = await llmReplyOrDegraded(
    [
      {
        role: "system",
        content:
          "你是企业组织架构顾问。根据企业画像，按业务流程与组织架构设计 3-8 个部门。" +
          "若企业画像中已给出「现有部门」，必须原样沿用这些部门名（不得另造、新增或改名，部门数量与现有部门一致），仅为其补职责与数字员工设定。" +
          "agentName 风格参考「星算、链通、售赢」：2-3 字，专业大气，避免叠字。" +
          "严格只输出 JSON 数组，每个元素形如 {\"deptName\":\"...\",\"duty\":\"...\",\"agentName\":\"...\",\"title\":\"...\"}：" +
          "deptName 为 2-8 字中文部门名，duty 为一句话职责，agentName 为 2-4 字中文数字员工名，title 为该部门 Agent 头衔（如「财务官」）。不要输出任何其他文字。",
      },
      { role: "user", content: `企业画像：\n${factoryDigest(factory)}${businessNote ? `\n业务补充说明：${clip(businessNote, 300)}` : ""}` },
    ],
    "",
    900,
    45_000,
    "orggen",
  );
  if (reply.degraded) return null;
  const match = reply.content.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const arr = JSON.parse(match[0]) as Array<Record<string, unknown>>;
    const specs: DeptSpec[] = [];
    for (const item of arr) {
      const deptName = String(item.deptName ?? "").trim();
      const duty = String(item.duty ?? "").trim();
      const agentName = String(item.agentName ?? "").trim();
      const title = String(item.title ?? "").trim();
      if (!deptName || !agentName || !title) continue;
      specs.push({ deptId: `d${specs.length + 1}`, deptName: clip(deptName, 32), duty: clip(duty || `${deptName}相关工作`, 128), agentName: clip(agentName, 32), title: clip(title, 32) });
      if (specs.length >= 8) break;
    }
    return specs.length >= 3 ? specs : null;
  } catch {
    return null;
  }
}

/** LLM 失败且企业已有注册部门时的确定性回退：原样沿用注册部门，配备规则化数字员工名 */
const FALLBACK_AGENT_NAMES = ["星策", "云帆", "明玑", "睿衡", "启铭", "秉文", "知远", "行之"];
function specsFromExistingDepts(factory: WbFactory): DeptSpec[] {
  return factory.departments.slice(0, 8).map((d, i) => ({
    deptId: d.id || `d${i + 1}`,
    deptName: clip(d.name, 32),
    duty: clip(d.duty || `${d.name}相关工作`, 128),
    agentName: FALLBACK_AGENT_NAMES[i % FALLBACK_AGENT_NAMES.length],
    title: `${d.name.replace(/部$/, "")}官`,
  }));
}

/** LLM 生成 systemPrompt（失败回退规则模板）；generatedBy 记录 llm/rule */
async function genSystemPrompt(
  factory: WbFactory,
  roleDesc: string,
  rulePrompt: string,
): Promise<{ systemPrompt: string; generatedBy: "llm" | "rule" }> {
  const reply = await llmReplyOrDegraded(
    [
      {
        role: "system",
        content:
          "你是提示词工程师。请为企业数字员工撰写 system prompt：150-250 字中文，明确身份、职责边界、回答风格（务实、分点、可执行）。" +
          "要求 Token 只按「结算/兑换/计量」口径表述，不使用金融/炒作/投机类词汇。直接输出 prompt 正文，不要解释。",
      },
      { role: "user", content: `企业画像：\n${factoryDigest(factory)}\n\n数字员工角色：${roleDesc}` },
    ],
    "",
    500,
    45_000,
    "brain",
  );
  if (reply.degraded) return { systemPrompt: rulePrompt, generatedBy: "rule" };
  return { systemPrompt: clip(reply.content.trim(), 1500), generatedBy: "llm" };
}

/** 规则文案模板（LLM 不可用时的确定性兜底） */
function ruleBrainPrompt(factory: WbFactory): string {
  return `你是「${factory.enterpriseName}」的公司大脑，统筹全企业的经营分析与跨部门协同。` +
    `所属行业：${[factory.industry, factory.industryText].filter(Boolean).join(" / ")}。` +
    (factory.painPoints ? `重点关注业务痛点：${clip(factory.painPoints, 200)}。` : "") +
    `回答要求：务实中文、分点输出、给出可执行动作；Token 只按「结算/兑换/计量」口径表述。`;
}

function ruleDeptPrompt(factory: WbFactory, spec: DeptSpec): string {
  return `你是「${factory.enterpriseName}」${spec.deptName}的数字员工「${spec.agentName}」（${spec.title}）。` +
    `部门职责：${spec.duty}。` +
    `回答要求：立足本部门视角、务实中文、分点输出、给出可执行动作；Token 只按「结算/兑换/计量」口径表述。`;
}

// ─── 行读取 ──────────────────────────────────────────────────────────────────
interface BrainRow {
  name: string;
  persona: string | null;
  systemPrompt: string;
  status: string;
  generatedBy: string;
}

async function readBrain(factoryId: number): Promise<BrainRow | null> {
  const rows = await orgQuery(
    sql`SELECT name, persona, systemPrompt, status, generatedBy FROM wb_brain_agent WHERE factoryId = ${factoryId} LIMIT 1`,
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    name: String(r.name),
    persona: r.persona == null ? null : String(r.persona),
    systemPrompt: String(r.systemPrompt ?? ""),
    status: String(r.status),
    generatedBy: String(r.generatedBy),
  };
}

interface DeptAgentRow {
  deptId: string;
  deptName: string;
  agentName: string;
  title: string;
  systemPrompt: string;
  status: string;
  generatedBy: string;
}

async function readDeptAgents(factoryId: number): Promise<DeptAgentRow[]> {
  const rows = await orgQuery(
    sql`SELECT deptId, deptName, agentName, title, systemPrompt, status, generatedBy
        FROM wb_dept_agents WHERE factoryId = ${factoryId} ORDER BY id ASC`,
  );
  return rows.map((r) => ({
    deptId: String(r.deptId),
    deptName: String(r.deptName),
    agentName: String(r.agentName),
    title: String(r.title),
    systemPrompt: String(r.systemPrompt ?? ""),
    status: String(r.status),
    generatedBy: String(r.generatedBy),
  }));
}

/** 把配置生成的部门（id/name/duty）合并进 wb_factories.departments（同名不重复） */
async function mergeFactoryDepartments(factory: WbFactory, specs: DeptSpec[]) {
  const existing = factory.departments;
  const existingNames = new Set(existing.map((d) => d.name));
  const existingIds = new Set(existing.map((d) => d.id));
  const additions = specs
    .filter((s) => !existingNames.has(s.deptName))
    .map((s) => ({
      id: existingIds.has(s.deptId) ? `${s.deptId}_${s.deptName}` : s.deptId,
      name: s.deptName,
      duty: s.duty,
    }));
  if (additions.length === 0) return;
  const db = getDb();
  await db
    .update(wbFactories)
    .set({ departments: [...existing, ...additions] })
    .where(eq(wbFactories.id, factory.id));
}

export const wbOrgRouter = createRouter({
  /**
   * orgSmartSetup（mutation，仅 admin/owner）—— 组织架构智能配置。
   * 确定性分类（先电商、再明显非制造走 LLM、默认制造模板）生成公司大脑 + 部门 Agent
   * 数字员工阵容；persona/systemPrompt 用 LLM 生成，失败回退规则模板（generatedBy 标注）。
   * 幂等与刷新：已有配置时必须 confirmRefresh=true 才覆盖（否则返回现有配置 + needsConfirm）；
   * 同步合并 wb_factories.departments（同名不重复）。
   */
  orgSmartSetup: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        businessNote: z.string().trim().max(1000).optional(),
        confirmRefresh: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      requireAdminRole(user);
      const db = getDb();

      // ── 幂等：已有配置且未确认 → 返回现有配置 + needsConfirm ────────────────
      const existingBrain = await readBrain(factory.id);
      const existingDepts = await readDeptAgents(factory.id);
      if (existingBrain && !input.confirmRefresh) {
        return {
          needsConfirm: true as const,
          brain: { name: existingBrain.name, persona: existingBrain.persona, generatedBy: existingBrain.generatedBy },
          departments: existingDepts.map((d) => ({
            deptId: d.deptId,
            deptName: d.deptName,
            agentName: d.agentName,
            title: d.title,
          })),
          degraded: false,
          generatedBy: existingBrain.generatedBy === "llm" ? ("llm" as const) : ("rule" as const),
        };
      }

      // ── 分类：电商 / LLM（明显非制造）/ 制造模板 ────────────────────────────
      const kind = classifyOrg(factory, input.businessNote);
      let specs: DeptSpec[];
      let degraded = false;
      if (kind === "ecommerce") {
        specs = ECOM_DEPTS;
      } else if (kind === "manufacturing") {
        specs = MFG_DEPTS;
      } else {
        const llmSpecs = await llmDepartments(factory, input.businessNote);
        if (llmSpecs) {
          specs = llmSpecs;
        } else if (factory.departments.length > 0) {
          specs = specsFromExistingDepts(factory); // LLM 失败 → 确定性沿用注册部门（永不回退工业模板）
          degraded = true;
        } else {
          specs = MFG_DEPTS; // 无任何部门画像时才回退制造模板
          degraded = true;
        }
      }

      // ── 公司大脑 persona + systemPrompt（LLM，失败规则模板）─────────────────
      const brainName = "公司大脑";
      const personaReply = await llmReplyOrDegraded(
        [
          {
            role: "system",
            content:
              "你是企业数字化顾问。请为该企业的「公司大脑」数字员工写一段 persona（人设简介）：80-150 字中文，突出企业行业与经营重点。直接输出正文，不要解释。",
          },
          { role: "user", content: `企业画像：\n${factoryDigest(factory)}` },
        ],
        "",
        400,
        45_000,
        "brain",
      );
      const persona = personaReply.degraded
        ? `统筹「${factory.enterpriseName}」经营分析与跨部门协同的公司大脑，立足${factory.industry}行业，关注${clip(factory.painPoints ?? "降本增效", 80)}。`
        : clip(personaReply.content.trim(), 400);
      const brain = await genSystemPrompt(factory, `公司大脑「${brainName}」：统筹经营分析与跨部门协同`, ruleBrainPrompt(factory));
      if (brain.generatedBy === "rule") degraded = true;

      // ── 部门 Agent systemPrompt（LLM，失败规则模板）─────────────────────────
      const deptRows: Array<DeptSpec & { systemPrompt: string; generatedBy: "llm" | "rule" }> = [];
      for (const spec of specs) {
        const gen = await genSystemPrompt(
          factory,
          `${spec.deptName}数字员工「${spec.agentName}」（${spec.title}）：${spec.duty}`,
          ruleDeptPrompt(factory, spec),
        );
        if (gen.generatedBy === "rule") degraded = true;
        deptRows.push({ ...spec, ...gen });
      }

      // ── 写入（覆盖式刷新）：brain upsert + dept_agents 全量替换 ─────────────
      await db.execute(sql`DELETE FROM wb_brain_agent WHERE factoryId = ${factory.id}`);
      await db.execute(
        sql`INSERT INTO wb_brain_agent (factoryId, name, persona, systemPrompt, status, generatedBy)
            VALUES (${factory.id}, ${brainName}, ${persona}, ${brain.systemPrompt}, 'active', ${brain.generatedBy})`,
      );
      await db.execute(sql`DELETE FROM wb_dept_agents WHERE factoryId = ${factory.id}`);
      for (const d of deptRows) {
        await db.execute(
          sql`INSERT INTO wb_dept_agents (factoryId, deptId, deptName, agentName, title, systemPrompt, status, generatedBy)
              VALUES (${factory.id}, ${d.deptId}, ${d.deptName}, ${d.agentName}, ${d.title}, ${d.systemPrompt}, 'active', ${d.generatedBy})`,
        );
      }

      // ── 同步合并 wb_factories.departments（同名不重复）───────────────────────
      await mergeFactoryDepartments(factory, deptRows);

      return {
        needsConfirm: false as const,
        brain: { name: brainName, persona, generatedBy: brain.generatedBy },
        departments: deptRows.map((d) => ({
          deptId: d.deptId,
          deptName: d.deptName,
          agentName: d.agentName,
          title: d.title,
        })),
        degraded,
        generatedBy: degraded ? ("rule" as const) : ("llm" as const),
      };
    }),

  /**
   * orgConfig（query）—— 查看本企业当前大脑 + 部门 Agent 配置。
   * admin/owner 看全部；成员仅看本部门 Agent + 大脑名称。
   */
  /**
   * evoOptOutRead / evoOptOutSet：M43 进化技能按厂开关。
   * 读：全员可读（本厂状态）；写：仅 owner/admin。关 = 本厂不接收进化落生技能
   * （loadVisibleSkills 进化段跳过；基础包/雇佣技能不受影响），随时可再开。
   */
  evoOptOutRead: publicQuery.input(tokenInput).query(async ({ input }) => {
    const { factory } = await sessionMe(input.token);
    const r = await rawRows(await getDb().execute(sql`SELECT evo_opt_out AS v FROM wb_factories WHERE id = ${factory.id} LIMIT 1`));
    return { factoryId: factory.id, evoOptOut: Number(r[0]?.v ?? 0) === 1 };
  }),

  evoOptOutSet: publicQuery
    .input(tokenInput.extend({ off: z.boolean() }))
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      if (user.role !== "admin" && user.role !== "owner") {
        throw new TRPCError({ code: "FORBIDDEN", message: "进化开关仅本厂负责人/管理员可设置" });
      }
      await getDb().execute(sql`UPDATE wb_factories SET evo_opt_out = ${input.off ? 1 : 0} WHERE id = ${factory.id}`);
      return { ok: true as const, factoryId: factory.id, evoOptOut: input.off };
    }),

  orgConfig: publicQuery.input(tokenInput).query(async ({ input }) => {
    const { user, factory } = await sessionMe(input.token);
    const isAdmin = user.role === "admin" || user.role === "owner";
    const brain = await readBrain(factory.id);
    let depts = await readDeptAgents(factory.id);
    if (!isAdmin) {
      const head = await isDeptHead(user);
      const myDept = user.departmentId;
      depts = depts.filter((d) => d.deptId === myDept);
      return {
        brain: brain ? { name: brain.name, status: brain.status } : null,
        departments: depts.map((d) => ({
          deptId: d.deptId,
          deptName: d.deptName,
          agentName: d.agentName,
          title: d.title,
          status: d.status,
        })),
        scope: head ? ("dept_head" as const) : ("member" as const),
      };
    }
    return {
      brain: brain
        ? {
            name: brain.name,
            persona: brain.persona,
            status: brain.status,
            generatedBy: brain.generatedBy,
          }
        : null,
      departments: depts.map((d) => ({
        deptId: d.deptId,
        deptName: d.deptName,
        agentName: d.agentName,
        title: d.title,
        status: d.status,
        generatedBy: d.generatedBy,
      })),
      scope: "admin" as const,
    };
  }),

  /**
   * orgChatStart（mutation）—— 开/复用与公司大脑或本部门 Agent 的对话线程。
   * 权限：admin/owner 可与大脑和任意部门 Agent 对话；head/员工仅本部门 Agent。
   */
  orgChatStart: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        targetType: z.enum(["brain", "deptAgent"]),
        deptId: z.string().trim().min(1).max(64).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const isAdmin = user.role === "admin" || user.role === "owner";
      const db = getDb();

      let targetId: string;
      let agentName: string;
      let title: string;
      let deptName: string | null = null;

      if (input.targetType === "brain") {
        if (!isAdmin) {
          throw new TRPCError({ code: "FORBIDDEN", message: BRAIN_ADMIN_ONLY });
        }
        const brain = await readBrain(factory.id);
        if (!brain || brain.status !== "active") {
          throw new TRPCError({ code: "NOT_FOUND", message: "公司大脑尚未配置或未启用" });
        }
        targetId = "brain";
        agentName = brain.name;
        title = "公司大脑";
      } else {
        if (!input.deptId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "deptAgent 对话必须指定 deptId" });
        }
        if (!isAdmin && input.deptId !== user.departmentId) {
          throw new TRPCError({ code: "FORBIDDEN", message: CROSS_DEPT_DENIED });
        }
        const rows = await orgQuery(
          sql`SELECT deptId, deptName, agentName, title, systemPrompt, status FROM wb_dept_agents
              WHERE factoryId = ${factory.id} AND deptId = ${input.deptId} LIMIT 1`,
        );
        const agent = rows[0];
        if (!agent || String(agent.status) !== "active") {
          throw new TRPCError({ code: "NOT_FOUND", message: "该部门数字员工尚未配置或未启用" });
        }
        targetId = String(agent.deptId);
        deptName = String(agent.deptName);
        agentName = String(agent.agentName);
        title = String(agent.title);
      }

      const existing = await orgQuery(
        sql`SELECT id FROM wb_org_chat_threads
            WHERE factoryId = ${factory.id} AND userId = ${user.id}
              AND targetType = ${input.targetType} AND targetId = ${targetId}
            ORDER BY updatedAt DESC LIMIT 1`,
      );
      let threadId: number;
      if (existing[0]) {
        threadId = Number(existing[0].id);
      } else {
        const threadTitle = deptName ? `${deptName}·${agentName} 对话` : `${agentName} 对话`;
        const res = (await db.execute(
          sql`INSERT INTO wb_org_chat_threads (factoryId, userId, targetType, targetId, title)
              VALUES (${factory.id}, ${user.id}, ${input.targetType}, ${targetId}, ${threadTitle})`,
        )) as unknown;
        const header = Array.isArray(res) ? (res[0] as { insertId?: number }) : {};
        threadId = Number(header?.insertId ?? 0);
      }
      const history = await orgQuery(
        sql`SELECT id, role, content, provider, degraded, createdAt FROM wb_org_chat_messages
            WHERE threadId = ${threadId} ORDER BY id ASC LIMIT 100`,
      );
      return {
        threadId,
        agent: { targetType: input.targetType, targetId, name: agentName, title, deptName },
        history: history.map((m) => ({
          id: Number(m.id),
          role: String(m.role),
          content: String(m.content),
          provider: m.provider == null ? null : String(m.provider),
          degraded: Number(m.degraded) === 1,
          createdAt: m.createdAt,
        })),
      };
    }),

  /**
   * orgChatSend（mutation）—— 发送消息。
   * system = Agent systemPrompt + 企业画像摘要 + buildContextDigest（裁剪），历史 10 条；
   * llmReplyOrDegraded 静默降级，provider/degraded 落库。
   */
  orgChatSend: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        threadId: z.number().int().positive(),
        content: z.string().trim().min(1, "消息不能为空").max(2000),
      }),
    )
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const isAdmin = user.role === "admin" || user.role === "owner";
      const db = getDb();

      const threads = await orgQuery(
        sql`SELECT id, factoryId, userId, targetType, targetId FROM wb_org_chat_threads
            WHERE id = ${input.threadId} LIMIT 1`,
      );
      const thread = threads[0];
      if (!thread || Number(thread.factoryId) !== factory.id || Number(thread.userId) !== user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "对话线程不存在" });
      }
      const targetType = String(thread.targetType);
      const targetId = String(thread.targetId);

      let agentName: string;
      let agentTitle: string;
      let systemPrompt: string;
      let deptName: string | null = null;

      if (targetType === "brain") {
        if (!isAdmin) {
          throw new TRPCError({ code: "FORBIDDEN", message: BRAIN_ADMIN_ONLY });
        }
        const brain = await readBrain(factory.id);
        if (!brain || brain.status !== "active") {
          throw new TRPCError({ code: "NOT_FOUND", message: "公司大脑尚未配置或未启用" });
        }
        agentName = brain.name;
        agentTitle = "公司大脑";
        systemPrompt = brain.systemPrompt;
      } else {
        if (!isAdmin && targetId !== user.departmentId) {
          throw new TRPCError({ code: "FORBIDDEN", message: CROSS_DEPT_DENIED });
        }
        const rows = await orgQuery(
          sql`SELECT deptName, agentName, title, systemPrompt, status FROM wb_dept_agents
              WHERE factoryId = ${factory.id} AND deptId = ${targetId} LIMIT 1`,
        );
        const agent = rows[0];
        if (!agent || String(agent.status) !== "active") {
          throw new TRPCError({ code: "NOT_FOUND", message: "该部门数字员工尚未配置或未启用" });
        }
        deptName = String(agent.deptName);
        agentName = String(agent.agentName);
        agentTitle = String(agent.title);
        systemPrompt = String(agent.systemPrompt ?? "");
      }

      // 1) 存用户消息
      await db.execute(
        sql`INSERT INTO wb_org_chat_messages (threadId, role, content) VALUES (${input.threadId}, 'user', ${input.content})`,
      );

      // 2) 构造上下文：system(systemPrompt + 企业画像摘要 + 实时数据摘要裁剪) + 最近10条历史
      const digest = clip(await buildContextDigest(), 300);
      const historyRows = await orgQuery(
        sql`SELECT role, content FROM wb_org_chat_messages
            WHERE threadId = ${input.threadId} ORDER BY id DESC LIMIT 10`,
      );
      const history: LlmMessage[] = historyRows.reverse().map((m) => ({
        role: String(m.role) === "agent" ? "assistant" : "user",
        content: clip(String(m.content), 1200),
      }));
      const messages: LlmMessage[] = [
        {
          role: "system",
          content: `${systemPrompt}\n\n【企业画像】\n${factoryDigest(factory)}\n\n【统一库实时数据摘要】\n${digest}`,
        },
        ...history,
      ];

      // 3) 调 LLM，失败静默降级
      const reply = await llmReplyOrDegraded(
        messages,
        [
          `${agentName}（${agentTitle}）基于规则给出参考意见：`,
          deptName ? `1. 立足${deptName}职责，先明确「${clip(input.content, 60)}」一事的目标与负责人。` : `1. 围绕「${clip(input.content, 60)}」，建议先对齐全企业经营基线与优先级。`,
          `2. 拆解为本周可执行的三步动作，并明确复盘时间点。`,
          `3. 涉及 Token 的动作请按「结算/兑换/计量」口径评估成本。`,
        ].join("\n"),
        600,
        45_000,
        "chat",
      );

      // 4) 存 Agent 回复并更新线程时间
      await db.execute(
        sql`INSERT INTO wb_org_chat_messages (threadId, role, content, provider, degraded)
            VALUES (${input.threadId}, 'agent', ${reply.content}, ${reply.provider}, ${reply.degraded ? 1 : 0})`,
      );
      await db.execute(
        sql`UPDATE wb_org_chat_threads SET updatedAt = NOW() WHERE id = ${input.threadId}`,
      );

      return { ...reply, agentName, agentTitle };
    }),
});
