/**
 * staff —— 迭代 19「部门账号分发体系 + 部门独立工作台」服务端路由。
 *
 * 模块构成：
 * - admin 系：createHead / listAll / resetPassword / setDisabled（复用 terminal 的 requireAdmin）；
 * - 统一入口（公开）：login / me（scrypt 校验，nt_ 单点 token，st_staff_accounts 独立存储）；
 * - 部门空间（requireStaff）：deptHome / agentChatStart / agentChatSend（数据严格限定本人 deptKey）；
 * - head 专属（requireDeptHead）：createMember / memberList / resetMemberPassword / setMemberDisabled。
 *
 * 约定（与 terminal.ts 一致）：
 * - token 只在请求体；越权一律显式 UNAUTHORIZED / FORBIDDEN，文案中文；
 * - 新表（st_staff_*）由 db/sync-staff.mts 幂等创建，本文件一律 raw SQL 访问，不改 drizzle schema；
 * - 密码 scrypt（hashPassword/verifyPassword 复用 wbSession，与现有实现同参数），
 *   明文密码绝不入库、绝不回传、绝不写日志；
 * - LLM 只走 modelGateway.callModelChat（复用 terminal 的 llmReplyOrDegraded），
 *   失败静默降级为确定性模板（degraded:true），错误原因绝不回传前端。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { isNoSuchTable, infraUnavailable500 } from "../auth/identity"; // ④逐点核：canonical 政策件同引
import { getDb } from "../queries/connection";
import { hashPassword, verifyPassword, newCredential } from "./wbSession";
// P1-3b（门禁 portal#31 轮3 票①）：本文件的 import **从 ./terminal 改指 ./terminalShared**。
//   这一步是拆掉 terminal.ts → terminalMeetings.ts → staff.ts → terminal.ts 间接环的关键 ——
//   改指后 staff.ts 对 ./terminal 的边为 **0**，那条三段环**真正消失**
//   （此前只是「不炸」：requireStaff 是提升的函数声明、只在函数体内惰性调用；
//     任何未来的模块求值期顶层使用都会暴露 undefined 绑定 —— 那是脆弱性，不是保证）。
//   所需 7 件现全部由 terminalShared 提供（其中 requireAdmin/rawRows/buildContextDigest/collectKpis
//   原就在 shared；findAgentByCode/llmReplyOrDegraded/clip 由 P1-3b 从 terminal.ts 上提）。
import {
  requireAdmin,
  rawRows,
  buildContextDigest,
  findAgentByCode,
  llmReplyOrDegraded,
  collectKpis,
  clip,
} from "./terminalShared";
import type { LlmMessage } from "./modelGateway";
import {
  buildMemoryBlock,
  buildSkillPromptBlock,
  executeSkillTool,
  extractAndSaveMemories,
  getAgentMemories,
  matchDeptSkills,
  resolveSkillExecutor,
  type ArtifactInfo,
} from "./agentTools";
import { executeGenericSkill, isGenericExecutorKind } from "./skillExecutor";

const tokenInput = z.object({ token: z.string().trim().min(1) });

const STAFF_TABLES_HINT =
  "部门账号体系数据表未初始化，请先在服务器执行 db/sync-staff.mts 后再操作";
const STAFF_AUTH_REQUIRED = "登录状态无效或已过期，请重新登录";
const HEAD_REQUIRED = "仅部门负责人可执行此操作";
const LOGIN_FAIL = "账号或密码错误";

/** st_staff_ 表查询统一兜底：表缺失时给出友好提示（④逐点核对齐 wb canonical：cause 链判别+500 掩码——
 *  旧顶层正则在 drizzle 包装层永不中=412 支死代码；裸抛=SQL+绑定参数泄客户端面封死） */
async function staffQuery(statement: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  try {
    return rawRows(await getDb().execute(statement));
  } catch (err) {
    if (isNoSuchTable(err)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: STAFF_TABLES_HINT });
    }
    infraUnavailable500("[routers/staff] st_staff_ 查询失败（1146 以外）", err);
  }
}

// ─── st_staff_accounts 行类型与读取 ──────────────────────────────────────────
export interface StaffAccount {
  id: number;
  username: string;
  displayName: string;
  deptKey: string;
  role: "head" | "staff";
  disabled: boolean;
}

function mapAccount(r: Record<string, unknown>): StaffAccount {
  return {
    id: Number(r.id),
    username: String(r.username),
    displayName: String(r.displayName),
    deptKey: String(r.deptKey),
    role: String(r.role) === "head" ? "head" : "staff",
    disabled: Number(r.disabled) === 1,
  };
}

async function findAccountById(id: number): Promise<StaffAccount | null> {
  const rows = await staffQuery(
    sql`SELECT id, username, displayName, deptKey, role, disabled
        FROM st_staff_accounts WHERE id = ${id} LIMIT 1`,
  );
  return rows[0] ? mapAccount(rows[0]) : null;
}

/** 员工/负责人鉴权：token → st_staff_accounts.authToken 匹配 + 未停用 */
export async function requireStaff(token: string): Promise<StaffAccount> {
  const rows = await staffQuery(
    sql`SELECT id, username, displayName, deptKey, role, disabled
        FROM st_staff_accounts WHERE authToken = ${token} LIMIT 1`,
  );
  const account = rows[0] ? mapAccount(rows[0]) : null;
  if (!account) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: STAFF_AUTH_REQUIRED });
  }
  if (account.disabled) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "账号已被停用，请联系部门负责人或管理员",
    });
  }
  return account;
}

/** 部门负责人专属守卫 */
async function requireDeptHead(token: string): Promise<StaffAccount> {
  const account = await requireStaff(token);
  if (account.role !== "head") {
    throw new TRPCError({ code: "FORBIDDEN", message: HEAD_REQUIRED });
  }
  return account;
}

/** 部门名查询（st_departments；表缺失/无记录时回退 deptKey） */
async function deptNameOf(deptKey: string): Promise<string> {
  try {
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT name FROM st_departments WHERE code = ${deptKey} LIMIT 1`,
      ),
    );
    return rows[0] ? String(rows[0].name) : deptKey;
  } catch {
    return deptKey;
  }
}

async function ensureDeptExists(deptKey: string): Promise<string> {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = rawRows(
      await getDb().execute(
        sql`SELECT name FROM st_departments WHERE code = ${deptKey} LIMIT 1`,
      ),
    );
  } catch (err) {
    // ④逐点核对齐 wb canonical：cause 链判别（旧顶层正则永不中=死代码面封死）+掩码 500
    if (isNoSuchTable(err)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "部门数据未初始化，请先在服务器执行 db/sync-terminal.mts 后再操作",
      });
    }
    infraUnavailable500("[routers/staff] ensureDeptExists 查询失败（1146 以外）", err);
  }
  if (!rows[0]) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "部门不存在，请核对部门标识" });
  }
  return String(rows[0].name);
}

async function ensureUsernameFree(username: string) {
  const rows = await staffQuery(
    sql`SELECT id FROM st_staff_accounts WHERE username = ${username} LIMIT 1`,
  );
  if (rows[0]) {
    throw new TRPCError({ code: "CONFLICT", message: "该账号名已被使用，请更换" });
  }
}

const passwordInput = z.string().min(6, "密码至少 6 位").max(64, "密码最长 64 位");
const usernameInput = z
  .string()
  .trim()
  .min(3, "账号名至少 3 个字符")
  .max(64, "账号名最长 64 个字符")
  .regex(/^[A-Za-z0-9_+\-@.一-龥]+$/, "账号名仅支持中英文、数字与常见符号");

export const staffRouter = createRouter({
  // ═══ admin 系：部门负责人账号分发 ═════════════════════════════════════════

  /** 为某部门分发负责人账号（总经理/管理员操作） */
  createHead: publicQuery
    .input(
      tokenInput.extend({
        username: usernameInput,
        password: passwordInput,
        displayName: z.string().trim().min(1, "姓名不能为空").max(64),
        deptKey: z.string().trim().min(1).max(32),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const deptName = await ensureDeptExists(input.deptKey);
      await ensureUsernameFree(input.username);
      const res = (await getDb().execute(
        sql`INSERT INTO st_staff_accounts (username, passwordHash, displayName, deptKey, role, createdBy)
            VALUES (${input.username}, ${hashPassword(input.password)}, ${input.displayName},
                    ${input.deptKey}, 'head', 'admin')`,
      )) as unknown;
      const header = Array.isArray(res) ? (res[0] as { insertId?: number }) : {};
      return {
        accountId: Number(header?.insertId ?? 0),
        username: input.username,
        displayName: input.displayName,
        deptKey: input.deptKey,
        deptName,
        role: "head" as const,
      };
    }),

  /** 全部 head/staff 账号列表（含部门名） */
  listAll: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const rows = await staffQuery(
      sql`SELECT a.id, a.username, a.displayName, a.deptKey, a.role, a.disabled, a.createdBy, a.createdAt,
            (SELECT d.name FROM st_departments d WHERE d.code = a.deptKey LIMIT 1) AS deptName
          FROM st_staff_accounts a ORDER BY a.id ASC LIMIT 500`,
    );
    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        username: String(r.username),
        displayName: String(r.displayName),
        deptKey: String(r.deptKey),
        deptName: r.deptName == null ? String(r.deptKey) : String(r.deptName),
        role: String(r.role),
        disabled: Number(r.disabled) === 1,
        createdBy: String(r.createdBy),
        createdAt: r.createdAt,
      })),
    };
  }),

  /** 重置任意部门账号密码（同时吊销已签发 token，强制重登） */
  resetPassword: publicQuery
    .input(
      tokenInput.extend({
        accountId: z.number().int().positive(),
        newPassword: passwordInput,
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const target = await findAccountById(input.accountId);
      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "账号不存在" });
      await getDb().execute(
        sql`UPDATE st_staff_accounts
            SET passwordHash = ${hashPassword(input.newPassword)}, authToken = NULL
            WHERE id = ${input.accountId}`,
      );
      return { ok: true as const, accountId: input.accountId };
    }),

  /** 停用/启用任意部门账号（停用时吊销已签发 token） */
  setDisabled: publicQuery
    .input(
      tokenInput.extend({
        accountId: z.number().int().positive(),
        disabled: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const target = await findAccountById(input.accountId);
      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "账号不存在" });
      await getDb().execute(
        input.disabled
          ? sql`UPDATE st_staff_accounts SET disabled = 1, authToken = NULL WHERE id = ${input.accountId}`
          : sql`UPDATE st_staff_accounts SET disabled = 0 WHERE id = ${input.accountId}`,
      );
      return { ok: true as const, accountId: input.accountId, disabled: input.disabled };
    }),

  // ═══ 统一入口（公开） ═════════════════════════════════════════════════════

  /** 部门负责人/员工统一登录：scrypt 校验 + 停用检查，签发 nt_ 单点 token（覆盖旧值） */
  login: publicQuery
    .input(
      z.object({
        identifier: z.string().trim().min(1, "请输入账号").max(64),
        password: z.string().min(1, "请输入密码").max(64),
      }),
    )
    .mutation(async ({ input }) => {
      const rows = await staffQuery(
        sql`SELECT id, username, passwordHash, displayName, deptKey, role, disabled
            FROM st_staff_accounts WHERE username = ${input.identifier} LIMIT 1`,
      );
      const row = rows[0];
      // 账号不存在与密码错误统一口径，不泄露账号是否存在
      if (!row || !verifyPassword(input.password, String(row.passwordHash))) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: LOGIN_FAIL });
      }
      if (Number(row.disabled) === 1) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "账号已被停用，请联系部门负责人或管理员",
        });
      }
      const token = newCredential("nt_");
      const accountId = Number(row.id);
      await getDb().execute(
        sql`UPDATE st_staff_accounts SET authToken = ${token} WHERE id = ${accountId}`,
      );
      const deptKey = String(row.deptKey);
      return {
        token,
        displayName: String(row.displayName),
        deptKey,
        role: String(row.role) === "head" ? ("head" as const) : ("staff" as const),
        deptName: await deptNameOf(deptKey),
      };
    }),

  /** 当前账号信息（守卫 requireStaff） */
  me: publicQuery.input(tokenInput).query(async ({ input }) => {
    const account = await requireStaff(input.token);
    return {
      token: input.token,
      displayName: account.displayName,
      username: account.username,
      deptKey: account.deptKey,
      role: account.role,
      deptName: await deptNameOf(account.deptKey),
    };
  }),

  // ═══ 部门空间（requireStaff；数据严格限定本人 deptKey） ════════════════════

  /** 本部门首页：部门信息 + 驻部 Agent 列表 + 成员数 + 最近会议 */
  deptHome: publicQuery.input(tokenInput).query(async ({ input }) => {
    const account = await requireStaff(input.token);
    const db = getDb();

    let dept: { key: string; name: string; duty: string } = {
      key: account.deptKey,
      name: account.deptKey,
      duty: "",
    };
    try {
      const rows = rawRows(
        await db.execute(
          sql`SELECT code, name, duty FROM st_departments WHERE code = ${account.deptKey} LIMIT 1`,
        ),
      );
      if (rows[0]) {
        dept = {
          key: String(rows[0].code),
          name: String(rows[0].name),
          duty: String(rows[0].duty ?? ""),
        };
      }
    } catch {
      // st_departments 未初始化：回退为 deptKey 展示
    }

    let agents: Array<{
      id: number;
      code: string;
      name: string;
      title: string;
      avatarEmoji: string;
      status: string;
    }> = [];
    try {
      const rows = rawRows(
        await db.execute(
          sql`SELECT id, code, name, title, avatarEmoji, status FROM st_agents
              WHERE deptCode = ${account.deptKey} AND status = 'active' ORDER BY id ASC`,
        ),
      );
      agents = rows.map((r) => ({
        id: Number(r.id),
        code: String(r.code),
        name: String(r.name),
        title: String(r.title),
        avatarEmoji: String(r.avatarEmoji ?? "🤖"),
        status: String(r.status),
      }));
    } catch {
      // st_agents 未初始化：空列表
    }

    const memberRows = await staffQuery(
      sql`SELECT count(*) AS c FROM st_staff_accounts WHERE deptKey = ${account.deptKey}`,
    );
    const memberCount = Number(memberRows[0]?.c ?? 0);

    let recentMeetings: Array<{ id: number; topic: string; status: string; createdAt: unknown }> = [];
    try {
      const rows = rawRows(
        await db.execute(
          sql`SELECT id, topic, status, createdAt FROM st_meetings ORDER BY id DESC LIMIT 5`,
        ),
      );
      recentMeetings = rows.map((r) => ({
        id: Number(r.id),
        topic: String(r.topic),
        status: String(r.status),
        createdAt: r.createdAt,
      }));
    } catch {
      // st_meetings 未初始化：空列表
    }

    return {
      dept,
      agents,
      memberCount,
      recentMeetings,
      me: {
        displayName: account.displayName,
        role: account.role,
        deptKey: account.deptKey,
      },
    };
  }),

  /** 与本部门驻部 Agent 开/复用对话线程（跨部门 agentKey 一律 FORBIDDEN） */
  agentChatStart: publicQuery
    .input(tokenInput.extend({ agentKey: z.string().trim().min(1).max(32) }))
    .mutation(async ({ input }) => {
      const account = await requireStaff(input.token);
      const agent = await findAgentByCode(input.agentKey);
      if (!agent || agent.status !== "active") {
        throw new TRPCError({ code: "NOT_FOUND", message: "驻部智能体不存在或未启用" });
      }
      if (agent.deptCode !== account.deptKey) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "该智能体不属于您所在部门，无法对话",
        });
      }
      const db = getDb();
      const existing = await staffQuery(
        sql`SELECT id FROM st_staff_chat_threads
            WHERE accountId = ${account.id} AND agentCode = ${agent.code}
            ORDER BY updatedAt DESC LIMIT 1`,
      );
      let threadId: number;
      if (existing[0]) {
        threadId = Number(existing[0].id);
      } else {
        const title = `${agent.name}·${agent.title} 对话`;
        const res = (await db.execute(
          sql`INSERT INTO st_staff_chat_threads (agentCode, accountId, deptKey, title)
              VALUES (${agent.code}, ${account.id}, ${account.deptKey}, ${title})`,
        )) as unknown;
        const header = Array.isArray(res) ? (res[0] as { insertId?: number }) : {};
        threadId = Number(header?.insertId ?? 0);
        if (!threadId) {
          const back = await staffQuery(
            sql`SELECT id FROM st_staff_chat_threads
                WHERE accountId = ${account.id} AND agentCode = ${agent.code}
                ORDER BY id DESC LIMIT 1`,
          );
          threadId = Number(back[0]?.id ?? 0);
        }
      }
      const history = await staffQuery(
        sql`SELECT id, role, content, provider, degraded, createdAt FROM st_staff_chat_messages
            WHERE threadId = ${threadId} ORDER BY id ASC LIMIT 100`,
      );
      return {
        threadId,
        agent: {
          code: agent.code,
          name: agent.name,
          title: agent.title,
          avatarEmoji: agent.avatarEmoji,
          deptCode: agent.deptCode,
        },
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

  /** 与本部门驻部 Agent 对话发送（LLM 故障转移 + 静默降级标注） */
  agentChatSend: publicQuery
    .input(
      tokenInput.extend({
        threadId: z.number().int().positive(),
        content: z.string().trim().min(1, "消息不能为空").max(2000),
      }),
    )
    .mutation(async ({ input }) => {
      const account = await requireStaff(input.token);
      const db = getDb();
      const threads = await staffQuery(
        sql`SELECT id, agentCode, accountId, deptKey FROM st_staff_chat_threads
            WHERE id = ${input.threadId} LIMIT 1`,
      );
      const thread = threads[0];
      if (!thread || Number(thread.accountId) !== account.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "对话线程不存在" });
      }
      if (String(thread.deptKey) !== account.deptKey) {
        throw new TRPCError({ code: "FORBIDDEN", message: "无权访问其他部门的对话" });
      }
      const agent = await findAgentByCode(String(thread.agentCode));
      if (!agent || agent.status !== "active") {
        throw new TRPCError({ code: "NOT_FOUND", message: "驻部智能体不存在或未启用" });
      }
      if (agent.deptCode !== account.deptKey) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "该智能体不属于您所在部门，无法对话",
        });
      }

      // 1) 存用户消息
      await db.execute(
        sql`INSERT INTO st_staff_chat_messages (threadId, role, content)
            VALUES (${input.threadId}, 'user', ${input.content})`,
      );

      // 2) 迭代41·T1 技能接线：命中技能五件套注入 prompt
      const matchedSkills = await matchDeptSkills(input.content, agent.code);
      const skillBlock = buildSkillPromptBlock(matchedSkills);
      // 迭代55·个体记忆读路径：注入 ≤5 条对此人的记忆
      const memories = await getAgentMemories(agent.code, account.username);
      const memoryBlock = buildMemoryBlock(memories);
      const memoryCount = memories.length;

      // 3) 构造上下文：system(systemPrompt+实时数据摘要+技能要求) + 最近10条历史
      const digest = await buildContextDigest();
      const historyRows = await staffQuery(
        sql`SELECT role, content FROM st_staff_chat_messages
            WHERE threadId = ${input.threadId} ORDER BY id DESC LIMIT 10`,
      );
      const history: LlmMessage[] = historyRows.reverse().map((m) => ({
        role: String(m.role) === "agent" ? "assistant" : "user",
        content: clip(String(m.content), 1200),
      }));
      const messages: LlmMessage[] = [
        {
          role: "system",
          content: `${agent.systemPrompt}\n\n对话对象：${account.displayName}（${
            account.role === "head" ? "部门负责人" : "部门员工"
          }）。\n\n【两系统实时数据摘要】\n${digest}${skillBlock}${memoryBlock}`,
        },
        ...history,
      ];

      // 4) 迭代41·T2~T4 + 迭代84·通用执行器：命中可执行技能 → 工具管线/通用执行产出真结果
      let artifacts: ArtifactInfo[] = [];
      const toolSkill = matchedSkills.find((s) => resolveSkillExecutor(s.skillKey)) ?? null;
      if (toolSkill) {
        const artifactCtx = {
          agentCode: agent.code,
          threadId: input.threadId,
          actor: account.username,
          channel: "staff" as const,
        };
        const kind = resolveSkillExecutor(toolSkill.skillKey);
        let toolRun: { artifacts: ArtifactInfo[]; brief: string; degraded?: boolean } | null = null;
        if (kind && !isGenericExecutorKind(kind)) {
          toolRun = await executeSkillTool(toolSkill, input.content, artifactCtx);
        } else if (kind) {
          const g = await executeGenericSkill({
            skill: toolSkill,
            content: input.content,
            agentName: agent.name,
            agentCode: agent.code,
            ctx: artifactCtx,
          });
          toolRun = { artifacts: g.artifact ? [g.artifact] : [], brief: g.text, degraded: g.degraded ?? false };
        }
        if (toolRun) {
          artifacts = toolRun.artifacts;
          const reply = { content: toolRun.brief, provider: "skill-tool", model: null, degraded: toolRun.degraded === true } as const;
          await db.execute(
            sql`INSERT INTO st_staff_chat_messages (threadId, role, content, provider, degraded)
                VALUES (${input.threadId}, 'agent', ${reply.content}, ${reply.provider}, ${reply.degraded ? 1 : 0})`,
          );
          await db.execute(sql`UPDATE st_staff_chat_threads SET updatedAt = NOW() WHERE id = ${input.threadId}`);
          // 迭代55·个体记忆写路径：异步沉淀，绝不阻塞回复
          void extractAndSaveMemories(agent.code, account.username, input.content, reply.content);
          return { ...reply, artifacts, usedSkills: matchedSkills.map((s) => s.name), memoryCount };
        }
      }

      // 5) 调 LLM，失败静默降级
      const kpis = await collectKpis();
      const reply = await llmReplyOrDegraded(
        messages,
        [
          `${agent.name}（${agent.title}）基于规则给出参考意见：`,
          `1. 当前统一库注册账号 ${kpis.userTotal}、入驻企业 ${kpis.factoryTotal} 家，建议本部门保持对企业入驻与留存的关注。`,
          `2. 数字员工 ${kpis.agentTotal} 位、雇佣订单 ${kpis.hireOrderTotal} 单，建议围绕本部门职责拆解改进动作。`,
          `3. Token 计量流水 ${kpis.tokenFlowTotal}，相关动作请按计量与结算口径评估成本。`,
          `4. 就「${clip(input.content, 60)}」一事，建议先明确目标与责任人，再拆为本周可执行的三步动作。`,
        ].join("\n"),
        600,
        45_000,
        "chat",
      );

      // 6) 存 Agent 回复并更新线程时间
      await db.execute(
        sql`INSERT INTO st_staff_chat_messages (threadId, role, content, provider, degraded)
            VALUES (${input.threadId}, 'agent', ${reply.content}, ${reply.provider}, ${reply.degraded ? 1 : 0})`,
      );
      await db.execute(
        sql`UPDATE st_staff_chat_threads SET updatedAt = NOW() WHERE id = ${input.threadId}`,
      );

      // 迭代55·个体记忆写路径：异步沉淀，绝不阻塞回复
      void extractAndSaveMemories(agent.code, account.username, input.content, reply.content);

      return { ...reply, artifacts, usedSkills: matchedSkills.map((s) => s.name), memoryCount };
    }),

  // ═══ head 专属（requireDeptHead） ═════════════════════════════════════════

  /** 分发本部门员工账号（deptKey 取本人部门，不接受传参） */
  createMember: publicQuery
    .input(
      tokenInput.extend({
        username: usernameInput,
        password: passwordInput,
        displayName: z.string().trim().min(1, "姓名不能为空").max(64),
      }),
    )
    .mutation(async ({ input }) => {
      const head = await requireDeptHead(input.token);
      await ensureUsernameFree(input.username);
      const res = (await getDb().execute(
        sql`INSERT INTO st_staff_accounts (username, passwordHash, displayName, deptKey, role, createdBy)
            VALUES (${input.username}, ${hashPassword(input.password)}, ${input.displayName},
                    ${head.deptKey}, 'staff', ${String(head.id)})`,
      )) as unknown;
      const header = Array.isArray(res) ? (res[0] as { insertId?: number }) : {};
      return {
        accountId: Number(header?.insertId ?? 0),
        username: input.username,
        displayName: input.displayName,
        deptKey: head.deptKey,
        role: "staff" as const,
      };
    }),

  /** 本部门成员列表（含负责人自身） */
  memberList: publicQuery.input(tokenInput).query(async ({ input }) => {
    const head = await requireDeptHead(input.token);
    const rows = await staffQuery(
      sql`SELECT id, username, displayName, role, disabled, createdBy, createdAt
          FROM st_staff_accounts WHERE deptKey = ${head.deptKey} ORDER BY id ASC LIMIT 200`,
    );
    return {
      deptKey: head.deptKey,
      items: rows.map((r) => ({
        id: Number(r.id),
        username: String(r.username),
        displayName: String(r.displayName),
        role: String(r.role),
        disabled: Number(r.disabled) === 1,
        createdBy: String(r.createdBy),
        createdAt: r.createdAt,
      })),
    };
  }),

  /** 重置本部门成员密码（目标账号必须属于本部门，否则 FORBIDDEN） */
  resetMemberPassword: publicQuery
    .input(
      tokenInput.extend({
        accountId: z.number().int().positive(),
        newPassword: passwordInput,
      }),
    )
    .mutation(async ({ input }) => {
      const head = await requireDeptHead(input.token);
      const target = await findAccountById(input.accountId);
      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "账号不存在" });
      if (target.deptKey !== head.deptKey) {
        throw new TRPCError({ code: "FORBIDDEN", message: "无权操作其他部门的账号" });
      }
      await getDb().execute(
        sql`UPDATE st_staff_accounts
            SET passwordHash = ${hashPassword(input.newPassword)}, authToken = NULL
            WHERE id = ${input.accountId}`,
      );
      return { ok: true as const, accountId: input.accountId };
    }),

  /** 停用/启用本部门成员（不能停用自己；跨部门一律 FORBIDDEN） */
  setMemberDisabled: publicQuery
    .input(
      tokenInput.extend({
        accountId: z.number().int().positive(),
        disabled: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const head = await requireDeptHead(input.token);
      const target = await findAccountById(input.accountId);
      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "账号不存在" });
      if (target.deptKey !== head.deptKey) {
        throw new TRPCError({ code: "FORBIDDEN", message: "无权操作其他部门的账号" });
      }
      if (target.id === head.id && input.disabled) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "不能停用自己的账号" });
      }
      await getDb().execute(
        input.disabled
          ? sql`UPDATE st_staff_accounts SET disabled = 1, authToken = NULL WHERE id = ${input.accountId}`
          : sql`UPDATE st_staff_accounts SET disabled = 0 WHERE id = ${input.accountId}`,
      );
      return { ok: true as const, accountId: input.accountId, disabled: input.disabled };
    }),
});
