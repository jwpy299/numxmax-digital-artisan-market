/**
 * terminal —— 迭代 18「广东灵智枢生态科技有限公司 · 灵智枢智能运营」服务端路由。
 *
 * 模块构成：总经理驾驶舱（cockpit/briefing）+ 部门智能管理（departments）+
 * 驻部 Agent 单聊（agentChatStart/agentChatSend）+ 共生工作空间（meeting*）。
 *
 * 约定（与 admin.ts 一致）：
 * - 所有 procedure 输入都携带 { token, ... }（token 只在请求体）；
 * - requireHqAdmin：wb_users.authToken 匹配 + 本厂 HQ 面（比 requireAdmin 更严——总部管理员面），否则 UNAUTHORIZED「需要管理员权限」；
 * - 新表（st_ 前缀）由 db/sync-terminal.mts 幂等创建，本文件一律 raw SQL 访问，不改 drizzle schema；
 * - LLM 只允许经 modelGateway.callModelChat 服务端调用；失败一律静默降级为确定性模板回复
 *   （degraded:true，文案「大模型暂不可用，以下为规则生成的参考回复」），
 *   绝不把错误原因/密钥暴露给前端；成功时标注 provider/模型。
 */
import { probeDeep } from "../lib/probeDeep"; // 深健康探测共享单点（portal#42 票③）
import { z } from "zod";
import { sql, type SQLWrapper } from "drizzle-orm";
import { dbProbeTimed } from "../queries/healthProbe";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
// P1-3b：llmReplyOrDegraded 已上提至 ./terminalShared（连同 callModelChat/callSlotChat/SlotId）。
//   但本文件仍有 3 处直接构造 messages 传给别的 LLM 入口，故仍需 LlmMessage 类型。
import type { LlmMessage } from "./modelGateway";
import {
  type AgentRow,
  buildContextDigest,
  clip,
  collectKpis,
  findAgentByCode,
  HEAD_REQUIRED,
  listActiveAgents,
  listDepartments,
  llmReplyOrDegraded,
  rawRows,
  requireHqAdmin,
  stQuery,
} from "./terminalShared";
// P1-3 拆域根因：`export * from "./terminalMeetings"` 只把对侧导出**转发给本模块的消费方**，
//   不会把名字引入本模块作用域——本文件自用这些件必须显式 import。
//
// ⚠️ 环的真实状态（门禁 portal#31 轮2 票①指出，此处更正此前失实的「无环」断言）：
//   **直连环已消除，但间接环仍在**，真实图是
//     terminal.ts → terminalMeetings.ts → staff.ts → terminal.ts
//   （terminalMeetings 新引入 `./staff` 静态 import；staff.ts:24-32 又从 `./terminal` 静态 import 7 件）。
//   今天不崩**仅因** `requireStaff` 是提升的函数声明、只在 `meetingActor` 内调用（非模块求值期）——
//   是**脆弱性，不是安全性**。真断环步骤见 ./terminalMeetings 头注释「P1-3b」。
//   ⚠️ 另注：我此前用「模块加载实测通过」当作「无环」的证据，那是**错误推理** —— 该测试只能证明「没崩」。
import {
  assertSwarmScope,
  buildGmContext,
  GM_ADVISOR_CODE,
  GM_ADVISOR_PROMPT,
  loadMeetingRoom,
  loadMeetingSeats,
  loadSeatMembers,
  loadSwarmOrThrow,
  meetingActor,
  pushToEnterpriseFeed,
  recordSwarmDocRefs,
  requireMeetingHead,
  SWARM_MODEL_SLOT,
} from "./terminalMeetings";
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
import { noteSilent } from "./silentWatch";

const tokenInput = z.object({ token: z.string().trim().min(1) });

// ─── P1-3 拆域：本文件与 ./terminalMeetings 共用的基础件已抽至 ./terminalShared ───
//   （HEAD_REQUIRED / TERMINAL_TABLES_HINT / rawRows / requireAdmin /
//    requireHqAdmin / stQuery / collectKpis / buildContextDigest / listDepartments /
//    listActiveAgents / AgentRow 等；本文件经 export * 再导出，既有消费方零改动）───
//   ⚠️ 门禁 portal#31 轮2 票④：原列表把 `ADMIN_REQUIRED` 也算了进来，但它在 terminalShared 里
//   是**模块私有**（`const ADMIN_REQUIRED`，无 export）—— `export *` 只转发**已导出**的绑定，
//   故它并未被再导出。本仓无任何消费方引用它（tsc 全量通过即证据），故**保持私有、自此列表移除**。
//   若日后有消费方需要，应先在 terminalShared 显式 `export` 再列入本表。
// P1-3b：DEGRADED_PREFIX 已上提至 ./terminalShared（随 llmReplyOrDegraded 一并迁移）。

/** JSON 列容错解析：mysql2/drizzle 可能返回已解析的数组或 JSON 字符串（迭代 36） */
export function parseJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  try {
    const arr = JSON.parse(String(v ?? "[]")) as unknown;
    return Array.isArray(arr) ? arr.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}



// ─── P1-3b：findAgentByCode / LlmReply / llmReplyOrDegraded / clip 已上提至 ./terminalShared ───
//   目的：拆掉 terminal.ts → terminalMeetings.ts → staff.ts → terminal.ts 的**间接环**。
//   此前仅是「不炸」（requireStaff 是提升的函数声明、只在函数体内惰性调用），
//   任何未来的模块求值期顶层使用都会暴露 undefined 绑定 —— 那是脆弱性，不是保证。
//   现 staff.ts:24 起改从 ./terminalShared import（本文件对 staff 的边仍在，但 staff 不再回指本文件），
//   环消失。本文件自用这 4 件见文件头部从 ./terminalShared 的显式 import。
//   门禁 portal#31 轮3 票①（maintainability/medium）即要求此项。

// ─── 会议/群智/枢总模块已拆至 ./terminalMeetings（P2）、共用基础件抽至 ./terminalShared（P1-3）───
//     export * 保持既有 import 不变（注意：export * 不回导，本文件自用件见文件头部显式 import）。
export * from "./terminalShared";
export * from "./terminalMeetings";
export const terminalRouter = createRouter({
  /**
   * deptKpis（query，admin）：部门真实 KPI（死端点处置 t8·部门 KPI 占位填实）。
   * 全部取自真实台账：驻部智能体数 / 近 90 天对话任务量 / 产出物数 / 采纳率（反馈样本<3 标观察中）。
   */
  deptKpis: publicQuery
    .input(tokenInput.extend({ deptCode: z.string().trim().min(1).max(64) }))
    .query(async ({ input }) => {
      await requireHqAdmin(input.token);
      const agentsRows = await stQuery(
        sql`SELECT id, code, name FROM st_agents WHERE deptCode = ${input.deptCode} AND status = 'active'`,
      );
      const codes = agentsRows.map((r) => String(r.code));
      let tasks90d = 0;
      let artifacts90d = 0;
      let adopted = 0;
      let rejected = 0;
      if (codes.length > 0) {
        const inSql = sql.join(codes.map((c) => sql`${c}`), sql`,`);
        const t = await stQuery(
          sql`SELECT COUNT(*) AS c FROM st_chat_threads t JOIN st_chat_messages m ON m.threadId = t.id AND m.role = 'user'
              WHERE t.agentCode IN (${inSql}) AND m.createdAt > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 DAY)`,
        );
        tasks90d = Number(t[0]?.c ?? 0);
        const a = await stQuery(
          sql`SELECT COUNT(*) AS c FROM st_agent_artifacts
              WHERE agentCode IN (${inSql}) AND createdAt > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 DAY)`,
        );
        artifacts90d = Number(a[0]?.c ?? 0);
        const f = await stQuery(
          sql`SELECT SUM(f.fb_signal = 'adopted') AS ad, SUM(f.fb_signal = 'rejected') AS rj
              FROM st_artifact_feedback f JOIN st_agent_artifacts a ON a.id = f.artifact_id
              WHERE a.agentCode IN (${inSql})`,
        );
        adopted = Number(f[0]?.ad ?? 0);
        rejected = Number(f[0]?.rj ?? 0);
      }
      const samples = adopted + rejected;
      return {
        deptCode: input.deptCode,
        activeAgents: agentsRows.length,
        tasks90d,
        artifacts90d,
        adopted,
        rejected,
        adoptionRate: samples > 0 ? adopted / samples : null,
        note: samples < 3 ? "反馈样本不足 3 条，采纳率标观察中" : undefined,
      };
    }),

  // ─── 驾驶舱聚合 ────────────────────────────────────────────────────────────
  cockpit: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireHqAdmin(input.token);
    const kpis = await collectKpis();

    // 系统健康：DB 自检 + 门户/工作台探测（复用 systemHealth 同款逻辑）
    const portalUrl = process.env.PORTAL_URL ?? "https://downloads.example.invalid";
    const workbenchUrl = process.env.WORKBENCH_URL ?? "https://wb.example.invalid";
    const database = await dbProbeTimed(); // R24 票②：计时包装走 dbProbeTimed 单点（不再两处手写）
    const [portal, workbench] = await Promise.all([probeDeep(portalUrl), probeDeep(workbenchUrl)]);

    // 波 1·P1-1：「等你拍板」四组计数（审批/进化提案/协议评审/今日异常——拍板台化首屏数据源；
    //  各组 SQL 失败独立回落 -1（前端显「—」），不拖垮驾驶舱主面板）
    const pendingOf = async (q: SQLWrapper, source: string): Promise<number> => {
      try {
        const rows = rawRows(await getDb().execute(q));
        return Number(rows[0]?.c ?? 0);
      } catch (e) {
        console.error(`[cockpit] pendingBoard 计数查询失败 [${source}]（降级 -1 显「—」）:`, e instanceof Error ? e.message : String(e)); // R31 票②：来源标签入日志
        return -1;
      }
    };
    const [approvalsClaw, approvalsTopup, proposalsPending, reviewsPending, alertsToday] = await Promise.all([
      pendingOf(sql`SELECT COUNT(*) AS c FROM st_claw_operations WHERE status = 'pending'`, 'claw_operations'),
      pendingOf(sql`SELECT COUNT(*) AS c FROM st_token_topups WHERE status = 'pending'`, 'token_topups'),
      pendingOf(sql`SELECT COUNT(*) AS c FROM st_evo_proposals WHERE status = 'pending'`, 'evo_proposals'),
      pendingOf(sql`SELECT COUNT(*) AS c FROM st_protocols WHERE status IN ('draft', 'reviewing')`, 'protocols'),
      pendingOf(sql`SELECT COUNT(*) AS c FROM st_alert_log WHERE created_at >= CURDATE() AND level IN ('error', 'warn')`, 'alert_log'),
    ]);
    const pendingBoard = {
      // R31 票①诚实定稿：任一子查询失败即 -1 显「—」——部分和与全量不可分辨，宁可「—」不拿部分数冒充全量（点进去看全量）
      approvals: approvalsClaw < 0 || approvalsTopup < 0 ? -1 : approvalsClaw + approvalsTopup,
      proposals: proposalsPending,
      reviews: reviewsPending,
      alertsToday,
    };

    const [departments, agentsList] = await Promise.all([listDepartments(), listActiveAgents()]);
    // v147：北极星面板（字典+验收确权事实源；表缺席时降级为空阵列，绝不影响驾驶舱主功能）
    let northStar: {
      key: string; layer: string; name: string; direction: string;
      currentValue: number | null; ownerDept: string | null;
    }[] = [];
    let weeklyVerifiedDeliveries = 0;
    try {
      const m = rawRows(
        await getDb().execute(
          sql`SELECT metric_key AS \`key\`, layer, name, direction, current_value AS currentValue, owner_dept AS ownerDept FROM st_northstar_metrics ORDER BY FIELD(layer,'north_star','verify','auxiliary','guard','input')`,
        ),
      );
      northStar = m.map((r) => ({
        key: String(r.key), layer: String(r.layer), name: String(r.name),
        direction: String(r.direction), currentValue: r.currentValue == null ? null : Number(r.currentValue),
        ownerDept: r.ownerDept == null ? null : String(r.ownerDept),
      }));
      const w = rawRows(
        await getDb().execute(
          sql`SELECT COUNT(*) AS c FROM st_delivery_acceptances WHERE accepted_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
        ),
      );
      weeklyVerifiedDeliveries = Number(w[0]?.c ?? 0);
    } catch {
      // st_northstar_* 未初始化：忽略
    }

    // v165 预审准星（学习环；表未建/故障静默 null）
    let sdlc: { total: number; accuracy: number; missRate: number; falseRate: number } | null = null;
    try {
      const { sdlcAccuracy } = await import("../harness/sdlcLearning");
      sdlc = await sdlcAccuracy();
    } catch {
      sdlc = null;
    }

    // 彭总令（2026-09-03）① 汇聚预警：异常主动浮到驾驶舱（不翻也看见）
    const alerts: { kind: string; level: "warn" | "action"; text: string }[] = [];
    try {
      // 舱位逾期任务（超 48h 未动的 open 任务）
      const overdue = rawRows(await getDb().execute(
        sql`SELECT c.name AS cabin, COUNT(*) AS c FROM st_cabin_tasks t
            JOIN st_ent_cabins c ON c.id=t.cabin_id
            WHERE t.status='open' AND t.created_at < NOW() - INTERVAL 2 DAY
            GROUP BY c.name ORDER BY c DESC LIMIT 5`,
      )) as unknown as { cabin: string; c: number }[];
      for (const o of overdue) {
        alerts.push({ kind: "cabin_overdue", level: "action", text: `「${o.cabin}」有 ${o.c} 件任务超 48h 未动` });
      }
    } catch { /* 静默 */ }
    try {
      // 系统异常信号（24h 反复出现的）
      const hot = rawRows(await getDb().execute(
        sql`SELECT kind, COUNT(*) AS c FROM st_evo_signals
            WHERE created_at >= NOW() - INTERVAL 1 DAY GROUP BY kind HAVING c >= 3 LIMIT 3`,
      )) as unknown as { kind: string; c: number }[];
      for (const h of hot) {
        alerts.push({ kind: "signal_repeat", level: "warn", text: `信号「${h.kind}」24h 出现 ${h.c} 次（进化脑已收件）` });
      }
    } catch { /* 静默 */ }

    return {
      kpis,
      pendingBoard,
      health: { portal, workbench, database },
      northStar,
      sdlc,
      alerts,
      weeklyVerifiedDeliveries,
      departments,
      agents: agentsList.map((a) => ({
        id: a.id,
        deptCode: a.deptCode,
        code: a.code,
        name: a.name,
        title: a.title,
        avatarEmoji: a.avatarEmoji,
        status: a.status,
      })),
      digest: await buildContextDigest(),
    };
  }),

  // ─── 总经理智能简报（LLM，降级规则模板同样 5 条）───────────────────────────
  briefing: publicQuery.input(tokenInput).mutation(async ({ input }) => {
    await requireHqAdmin(input.token);
    const digest = await buildContextDigest();
    const kpis = await collectKpis();
    const reply = await llmReplyOrDegraded(
      [
        {
          role: "system",
          content:
            "你是广东灵智枢生态科技有限公司的总经理助理，基于公司两套系统（星云数字匠市门户、NumX Max 智能工作台）的实时数据，为总经理写 5 条要点智能简报。要求：务实中文、每条一句话、分点编号、给出可执行动作；Token 只按「结算/兑换/计量」口径表述，不使用金融/炒作/投机类词汇。",
        },
        { role: "user", content: `以下为当前实时数据摘要，请据此生成简报：\n${digest}` },
      ],
      [
        `1. 用户侧：注册账号 ${kpis.userTotal}（企业 ${kpis.enterpriseUserTotal}），建议运营部持续跟进企业入驻转化。`,
        `2. 供给侧：数字员工 ${kpis.agentTotal} 位（生效中 ${kpis.activeAgentTotal}），建议技术部关注待审核与暂停员工的质量闭环。`,
        `3. 交易侧：累计雇佣订单 ${kpis.hireOrderTotal} 单，建议运营部复盘订单转化路径并优化招募匹配。`,
        `4. 招聘侧：招聘中岗位 ${kpis.openRecruitmentTotal} 个，建议关注长期未招满岗位并调整预算或要求。`,
        `5. 结算侧：Token 计量流水 ${kpis.tokenFlowTotal}、平台结算佣金 ${kpis.tokenPlatformFeeTotal}，建议财务部按周核对计量口径。`,
      ].join("\n"),
      700,
      45_000,
      "flash",
    );
    return { ...reply, digest, generatedAt: new Date().toISOString() };
  }),

  // ─── iter89：总经理 AI 参谋「枢总」单聊（驾驶舱问数/派活）──────────────────
  gmChat: publicQuery
    .input(
      tokenInput.extend({
        message: z.string().trim().min(1, "消息不能为空").max(2000),
        threadId: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireHqAdmin(input.token);
      const db = getDb();

      // 参谋档案（sync-iter89 幂等补齐；档案缺失时用内置人设兜底，不阻断对话）
      let gmAgent: AgentRow | null = null;
      try {
        gmAgent = await findAgentByCode(GM_ADVISOR_CODE);
      } catch {
        gmAgent = null;
      }
      const agentName = gmAgent ? `${gmAgent.name}·${gmAgent.title}` : "枢总·总经理参谋";
      const persona = gmAgent?.systemPrompt || GM_ADVISOR_PROMPT;

      // 1) 线程：复用（归属 + agentCode 校验）或新建
      let threadId = input.threadId ?? 0;
      if (threadId) {
        const rows = await stQuery(
          sql`SELECT id, agentCode, userId FROM st_chat_threads WHERE id = ${threadId} LIMIT 1`,
        );
        const t = rows[0];
        if (!t || Number(t.userId) !== admin.id || String(t.agentCode) !== GM_ADVISOR_CODE) {
          throw new TRPCError({ code: "NOT_FOUND", message: "对话线程不存在" });
        }
      } else {
        const res = (await db.execute(
          sql`INSERT INTO st_chat_threads (agentCode, userId, title) VALUES (${GM_ADVISOR_CODE}, ${admin.id}, '枢总·总经理参谋 对话')`,
        )) as unknown;
        const header = Array.isArray(res) ? (res[0] as { insertId?: number }) : {};
        threadId = Number(header?.insertId ?? 0);
        if (!threadId) {
          const back = await stQuery(
            sql`SELECT id FROM st_chat_threads WHERE userId = ${admin.id} AND agentCode = ${GM_ADVISOR_CODE} ORDER BY id DESC LIMIT 1`,
          );
          threadId = Number(back[0]?.id ?? 0);
        }
      }

      // 2) 留痕：存用户消息
      await db.execute(
        sql`INSERT INTO st_chat_messages (threadId, role, content) VALUES (${threadId}, 'user', ${input.message})`,
      );

      // 3) 上下文注入：驾驶舱聚合摘要（KPI 9 项 + 健康 + 部门数），支撑「问数」
      const context = await buildGmContext();

      // 4) 技能接线：命中可执行技能 → 专用工具/通用执行器真执行（产出物走 saveArtifact，channel='admin'）
      const matchedSkills = await matchDeptSkills(input.message, GM_ADVISOR_CODE);
      const skillBlock = buildSkillPromptBlock(matchedSkills);
      let artifact: ArtifactInfo | null = null;
      const toolSkill = matchedSkills.find((s) => resolveSkillExecutor(s.skillKey)) ?? null;
      if (toolSkill) {
        const artifactCtx = {
          agentCode: GM_ADVISOR_CODE,
          threadId,
          actor: admin.username,
          channel: "admin" as const,
        };
        const kind = resolveSkillExecutor(toolSkill.skillKey);
        let toolRun: { artifacts: ArtifactInfo[]; brief: string; degraded?: boolean } | null = null;
        if (kind && !isGenericExecutorKind(kind)) {
          toolRun = await executeSkillTool(toolSkill, input.message, artifactCtx);
        } else if (kind) {
          const g = await executeGenericSkill({
            skill: toolSkill,
            content: input.message,
            agentName,
            agentCode: GM_ADVISOR_CODE,
            ctx: artifactCtx,
          });
          toolRun = { artifacts: g.artifact ? [g.artifact] : [], brief: g.text, degraded: g.degraded ?? false };
        }
        if (toolRun) {
          artifact = toolRun.artifacts[0] ?? null;
          await db.execute(
            sql`INSERT INTO st_chat_messages (threadId, role, content, provider, degraded)
                VALUES (${threadId}, 'agent', ${toolRun.brief}, 'skill-tool', ${toolRun.degraded === true ? 1 : 0})`,
          );
          await db.execute(sql`UPDATE st_chat_threads SET updatedAt = NOW() WHERE id = ${threadId}`);
          return {
            reply: toolRun.brief,
            threadId,
            provider: "skill-tool",
            model: null,
            degraded: toolRun.degraded === true,
            artifact,
            usedSkills: matchedSkills.map((s) => s.name),
          };
        }
      }

      // 5) LLM 对话：枢总人设 + 驾驶舱实时上下文 + 技能要求 + 最近 10 条历史；失败静默降级不抛错
      const historyRows = await stQuery(
        sql`SELECT role, content FROM st_chat_messages
            WHERE threadId = ${threadId} ORDER BY id DESC LIMIT 10`,
      );
      const history: LlmMessage[] = historyRows
        .reverse()
        .map((m) => ({
          role: String(m.role) === "agent" ? "assistant" : "user",
          content: clip(String(m.content), 1200),
        }));
      const kpis = await collectKpis();
      const reply = await llmReplyOrDegraded(
        [
          {
            role: "system",
            content: `${persona}\n\n【驾驶舱实时数据上下文】\n${context}${skillBlock}`,
          },
          ...history,
        ],
        [
          `枢总（规则参考回复）：`,
          `1. 当前注册账号 ${kpis.userTotal}（企业 ${kpis.enterpriseUserTotal}）、入驻企业 ${kpis.factoryTotal} 家。`,
          `2. 数字员工 ${kpis.agentTotal} 位（生效中 ${kpis.activeAgentTotal}），累计雇佣订单 ${kpis.hireOrderTotal} 单。`,
          `3. Token 计量流水 ${kpis.tokenFlowTotal}、平台结算佣金 ${kpis.tokenPlatformFeeTotal}（结算口径）。`,
          `4. 就「${clip(input.message, 60)}」一事，建议先明确目标与责任部门，再拆为本周可执行的三步动作。`,
        ].join("\n"),
        700,
        45_000,
        "chat",
      );

      // 6) 留痕：存参谋回复并更新线程时间
      await db.execute(
        sql`INSERT INTO st_chat_messages (threadId, role, content, provider, degraded)
            VALUES (${threadId}, 'agent', ${reply.content}, ${reply.provider}, ${reply.degraded ? 1 : 0})`,
      );
      await db.execute(sql`UPDATE st_chat_threads SET updatedAt = NOW() WHERE id = ${threadId}`);

      return {
        reply: reply.content,
        threadId,
        provider: reply.provider,
        model: reply.model,
        degraded: reply.degraded,
        artifact,
        usedSkills: matchedSkills.map((s) => s.name),
      };
    }),

  // ─── 部门智能管理 ──────────────────────────────────────────────────────────
  departments: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireHqAdmin(input.token);
    const [depts, agentsList] = await Promise.all([listDepartments(), listActiveAgents()]);
    return {
      items: depts.map((d) => ({
        ...d,
        todoPlaceholder: "部门待办将在后续迭代接入两系统任务流",
        agents: agentsList
          .filter((a) => a.deptCode === d.code)
          .map((a) => ({
            id: a.id,
            code: a.code,
            name: a.name,
            title: a.title,
            avatarEmoji: a.avatarEmoji,
            status: a.status,
          })),
      })),
    };
  }),

  // ─── 驻部 Agent 单聊：开/复用线程 ──────────────────────────────────────────
  agentChatStart: publicQuery
    .input(tokenInput.extend({ agentCode: z.string().trim().min(1).max(32) }))
    .mutation(async ({ input }) => {
      const admin = await requireHqAdmin(input.token);
      const agent = await findAgentByCode(input.agentCode);
      if (!agent || agent.status !== "active") {
        throw new TRPCError({ code: "NOT_FOUND", message: "驻部智能体不存在或未启用" });
      }
      const db = getDb();
      const existing = await stQuery(
        sql`SELECT id, title FROM st_chat_threads
            WHERE userId = ${admin.id} AND agentCode = ${agent.code}
            ORDER BY updatedAt DESC LIMIT 1`,
      );
      let threadId: number;
      if (existing[0]) {
        threadId = Number(existing[0].id);
      } else {
        const title = `${agent.name}·${agent.title} 对话`;
        const res = (await db.execute(
          sql`INSERT INTO st_chat_threads (agentCode, userId, title) VALUES (${agent.code}, ${admin.id}, ${title})`,
        )) as unknown;
        const header = Array.isArray(res) ? (res[0] as { insertId?: number }) : {};
        threadId = Number(header?.insertId ?? 0);
        if (!threadId) {
          const back = await stQuery(
            sql`SELECT id FROM st_chat_threads WHERE userId = ${admin.id} AND agentCode = ${agent.code} ORDER BY id DESC LIMIT 1`,
          );
          threadId = Number(back[0]?.id ?? 0);
        }
      }
      const history = await stQuery(
        sql`SELECT id, role, content, provider, degraded, createdAt FROM st_chat_messages
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

  // ─── 驻部 Agent 单聊：发送 ────────────────────────────────────────────────
  agentChatSend: publicQuery
    .input(
      tokenInput.extend({
        threadId: z.number().int().positive(),
        content: z.string().trim().min(1, "消息不能为空").max(2000),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireHqAdmin(input.token);
      const db = getDb();
      const threads = await stQuery(
        sql`SELECT id, agentCode, userId FROM st_chat_threads WHERE id = ${input.threadId} LIMIT 1`,
      );
      const thread = threads[0];
      if (!thread || Number(thread.userId) !== admin.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "对话线程不存在" });
      }
      const agent = await findAgentByCode(String(thread.agentCode));
      if (!agent || agent.status !== "active") {
        throw new TRPCError({ code: "NOT_FOUND", message: "驻部智能体不存在或未启用" });
      }

      // 1) 存用户消息
      await db.execute(
        sql`INSERT INTO st_chat_messages (threadId, role, content) VALUES (${input.threadId}, 'user', ${input.content})`,
      );

      // 2) 迭代41·T1 技能接线：按 trigger_hints 命中技能，五件套注入 prompt
      const matchedSkills = await matchDeptSkills(input.content, agent.code);
      const skillBlock = buildSkillPromptBlock(matchedSkills);
      // 迭代55·个体记忆读路径：注入 ≤5 条对此人的记忆
      const memories = await getAgentMemories(agent.code, admin.username);
      const memoryBlock = buildMemoryBlock(memories);
      const memoryCount = memories.length;

      // 3) 构造上下文：system(systemPrompt+实时数据摘要+技能要求+个体记忆) + 最近10条历史 + 本次用户消息
      const digest = await buildContextDigest();
      const historyRows = await stQuery(
        sql`SELECT role, content FROM st_chat_messages
            WHERE threadId = ${input.threadId} ORDER BY id DESC LIMIT 10`,
      );
      const history: LlmMessage[] = historyRows
        .reverse()
        .map((m) => ({
          role: String(m.role) === "agent" ? "assistant" : "user",
          content: clip(String(m.content), 1200),
        }));
      const messages: LlmMessage[] = [
        {
          role: "system",
          content: `${agent.systemPrompt}\n\n【两系统实时数据摘要】\n${digest}${skillBlock}${memoryBlock}`,
        },
        ...history,
      ];

      // 4) 迭代41·T2~T4 + 迭代84·通用执行器：命中可执行技能 → 工具管线/通用执行产出真结果
      //    优先取「可执行」的命中技能（避免非工具技能分高而遮蔽可执行技能）
      let artifacts: ArtifactInfo[] = [];
      const toolSkill = matchedSkills.find((s) => resolveSkillExecutor(s.skillKey)) ?? null;
      if (toolSkill) {
        const artifactCtx = {
          agentCode: agent.code,
          threadId: input.threadId,
          actor: admin.username,
          channel: "admin" as const,
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
            sql`INSERT INTO st_chat_messages (threadId, role, content, provider, degraded)
                VALUES (${input.threadId}, 'agent', ${reply.content}, ${reply.provider}, ${reply.degraded ? 1 : 0})`,
          );
          await db.execute(sql`UPDATE st_chat_threads SET updatedAt = NOW() WHERE id = ${input.threadId}`);
          // 迭代55·个体记忆写路径：异步沉淀，绝不阻塞回复
          void extractAndSaveMemories(agent.code, admin.username, input.content, reply.content);
          return { ...reply, artifacts, usedSkills: matchedSkills.map((s) => s.name), memoryCount };
        }
      }

      // 5) 调 LLM，失败静默降级
      const kpis = await collectKpis();
      const reply = await llmReplyOrDegraded(
        messages,
        [
          `${agent.name}（${agent.title}）基于规则给出参考意见：`,
          `1. 当前统一库注册账号 ${kpis.userTotal}、入驻企业 ${kpis.factoryTotal} 家，建议保持对企业入驻与留存的关注。`,
          `2. 数字员工 ${kpis.agentTotal} 位、雇佣订单 ${kpis.hireOrderTotal} 单，建议围绕订单转化拆解改进动作。`,
          `3. Token 计量流水 ${kpis.tokenFlowTotal}，相关动作请按计量与结算口径评估成本。`,
          `4. 就「${clip(input.content, 60)}」一事，建议先明确目标与责任部门，再拆为本周可执行的三步动作。`,
        ].join("\n"),
        600,
        45_000,
        "chat",
      );

      // 6) 存 Agent 回复并更新线程时间
      await db.execute(
        sql`INSERT INTO st_chat_messages (threadId, role, content, provider, degraded)
            VALUES (${input.threadId}, 'agent', ${reply.content}, ${reply.provider}, ${reply.degraded ? 1 : 0})`,
      );
      await db.execute(
        sql`UPDATE st_chat_threads SET updatedAt = NOW() WHERE id = ${input.threadId}`,
      );

      // 迭代55·个体记忆写路径：异步沉淀，绝不阻塞回复
      void extractAndSaveMemories(agent.code, admin.username, input.content, reply.content);

      return { ...reply, artifacts, usedSkills: matchedSkills.map((s) => s.name), memoryCount };
    }),

  // ─── 迭代 41：技能产出物下载（双轨：admin / staff，base64 回传）─────────────
  artifactDownload: publicQuery
    .input(tokenInput.extend({ artifactId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const actor = await meetingActor(input.token);
      const rows = await stQuery(
        sql`SELECT id, title, filename, filePath, kind, sizeBytes FROM st_agent_artifacts
            WHERE id = ${input.artifactId} LIMIT 1`,
      );
      const row = rows[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "产出物不存在" });
      void actor; // 双轨鉴权已通过即可下载（产出物含经营数据，均需登录身份）
      const { promises: fsp } = await import("fs");
      try {
        const buf = await fsp.readFile(String(row.filePath));
        const mime =
          String(row.kind) === "xlsx"
            ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            : String(row.kind) === "pptx"
              ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
              : String(row.kind) === "png"
                ? "image/png"
                : String(row.kind) === "jpg" || String(row.kind) === "jpeg"
                  ? "image/jpeg"
                  : String(row.kind) === "docx"
                    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    : "application/octet-stream";
        return {
          title: String(row.title),
          filename: String(row.filename),
          kind: String(row.kind),
          mime,
          base64: buf.toString("base64"),
        };
      } catch {
        throw new TRPCError({ code: "NOT_FOUND", message: "产出物文件已不存在，请重新生成" });
      }
    }),

  // ─── B1 反馈环：产出物 采用/驳回（同 actor 覆盖；北极星数据源）──────────────
  artifactFeedback: publicQuery
    .input(
      tokenInput.extend({
        artifactId: z.number().int().positive(),
        signal: z.enum(["adopted", "rejected"]),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const actor = await meetingActor(input.token);
      const art = await stQuery(
        sql`SELECT id, channel FROM st_agent_artifacts WHERE id = ${input.artifactId} LIMIT 1`,
      );
      if (!art[0]) throw new TRPCError({ code: "NOT_FOUND", message: "产出物不存在" });
      const channel = String(art[0].channel);
      const actorName = actor.kind === "admin" ? `admin:${actor.username}` : `staff:${actor.username}`;
      await stQuery(
        sql`INSERT INTO st_artifact_feedback (artifact_id, actor, channel, fb_signal, note)
            VALUES (${input.artifactId}, ${actorName}, ${channel}, ${input.signal}, ${input.note ?? null})
            ON DUPLICATE KEY UPDATE fb_signal = VALUES(fb_signal), note = VALUES(note)`,
      );
      return { ok: true as const, signal: input.signal };
    }),

  artifactFeedbackMine: publicQuery
    .input(tokenInput.extend({ artifactIds: z.array(z.number().int().positive()).max(50) }))
    .query(async ({ input }) => {
      const actor = await meetingActor(input.token);
      const actorName = actor.kind === "admin" ? `admin:${actor.username}` : `staff:${actor.username}`;
      const idList = input.artifactIds.map((id) => Math.floor(id)).filter((id) => id > 0);
      if (idList.length === 0) return { rows: [] as { artifactId: number; signal: string }[] };
      const rows = await stQuery(
        sql`SELECT artifact_id AS artifactId, fb_signal AS fbSignal FROM st_artifact_feedback
            WHERE actor = ${actorName} AND artifact_id IN (${sql.raw(idList.join(","))})`,
      );
      return { rows: rows.map((r) => ({ artifactId: Number(r.artifactId), signal: String(r.fbSignal) })) };
    }),

  // ─── B2 员工主动性：主动消息收件箱（evo 周报 + 近 48h 产出进展）──────────────
  proactiveInbox: publicQuery
    .input(tokenInput)
    .query(async ({ input }) => {
      const actor = await meetingActor(input.token);
      void actor;
      const report = await stQuery(
        sql`SELECT week, content, created_at AS createdAt FROM st_evo_reports ORDER BY week DESC LIMIT 1`,
      );
      const arts = await stQuery(
        sql`SELECT id, title, kind, agentCode, channel, createdAt FROM st_agent_artifacts
            WHERE createdAt > DATE_SUB(NOW(), INTERVAL 48 HOUR) ORDER BY id DESC LIMIT 10`,
      );
      const items: { type: "weekly_report" | "artifact"; title: string; body: string; at: string | null }[] = [];
      if (report[0]) {
        items.push({
          type: "weekly_report",
          title: `进化周报 · ${String(report[0].week)}`,
          body: String(report[0].content).slice(0, 300),
          at: report[0].createdAt ? String(report[0].createdAt) : null,
        });
      }
      for (const a of arts) {
        items.push({
          type: "artifact",
          title: `${String(a.agentCode)} 交付了 ${String(a.kind).toUpperCase()}《${String(a.title)}》`,
          body: `你交办的事有进展了：${String(a.kind)} 产出物已归档，可在对话中下载。`,
          at: a.createdAt ? String(a.createdAt) : null,
        });
      }
      return { items };
    }),

  // ─── 共生工作空间：发起会议 ────────────────────────────────────────────────
  meetingCreate: publicQuery
    .input(
      tokenInput.extend({
        topic: z.string().trim().min(2, "议题至少 2 个字").max(200),
        opening: z.string().trim().max(1000).optional(),
        // 迭代 36：full 全员会（默认，行为与现行一致）/ partial 临时协同会（勾选参会部门）
        meetingType: z.enum(["full", "partial"]).optional().default("full"),
        // iter76 熊猫组织底座：三类标准会议室；缺省按 meetingType 映射（full→enterprise, partial→cross）
        roomType: z.enum(["enterprise", "dept", "cross"]).optional(),
        participantDepts: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
        projectTag: z.string().trim().max(64).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const actor = await meetingActor(input.token);
      requireMeetingHead(actor);
      const db = getDb();
      const enabledDeptKeys = (await loadMeetingSeats()).filter((s) => s.enabled).map((s) => s.deptKey);
      // iter76：会议室类型解析与席位规则
      const roomType = input.roomType ?? (input.meetingType === "partial" ? "cross" : "enterprise");
      let roomDeptKey: string | null = null;
      if (roomType === "enterprise" && actor.kind !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "企业会议室仅老板可发起（部门负责人请用部门/跨部门会议室）" });
      }
      if (roomType === "dept") {
        if (actor.kind === "staff") {
          roomDeptKey = actor.deptKey ?? null;
        } else {
          const req = [...new Set(input.participantDepts ?? [])];
          if (req.length !== 1) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "管理员发起部门会议室需指定且仅指定 1 个部门" });
          }
          roomDeptKey = req[0];
        }
        if (!roomDeptKey || !enabledDeptKeys.includes(roomDeptKey)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "部门会议室的部门不在已启用圆桌席位内" });
        }
      }
      if (roomType === "cross") {
        const requested = [...new Set(input.participantDepts ?? [])];
        if (requested.length < 2) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "跨部门会议室需至少勾选 2 个参会部门" });
        }
        const invalid = requested.filter((d) => !enabledDeptKeys.includes(d));
        if (invalid.length > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `参会部门不在已启用圆桌席位内：${invalid.join("、")}`,
          });
        }
      }
      // 迭代 36：partial 校验——参会部门 ⊆ enabled 圆桌席位，至少 1 个
      let participantsJson: string | null = null;
      if (input.meetingType === "partial" || roomType === "cross" || roomType === "dept") {
        const requested =
          roomType === "dept"
            ? [roomDeptKey as string]
            : [...new Set(input.participantDepts ?? [])];
        if (requested.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "临时协同会需至少勾选 1 个参会部门" });
        }
        const invalid = requested.filter((d) => !enabledDeptKeys.includes(d));
        if (invalid.length > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `参会部门不在已启用圆桌席位内：${invalid.join("、")}`,
          });
        }
        participantsJson = JSON.stringify(requested);
      }
      const projectTag = input.projectTag?.trim() ? input.projectTag.trim() : null;
      const res = (await db.execute(
        sql`INSERT INTO st_meetings (topic, status, createdBy, meetingType, participants, projectTag, room_type, dept_key)
            VALUES (${input.topic}, 'open', ${actor.id}, ${input.meetingType}, ${participantsJson}, ${projectTag}, ${roomType}, ${roomDeptKey})`,
      )) as unknown;
      const header = Array.isArray(res) ? (res[0] as { insertId?: number }) : {};
      let meetingId = Number(header?.insertId ?? 0);
      if (!meetingId) {
        const back = await stQuery(
          sql`SELECT id FROM st_meetings WHERE createdBy = ${actor.id} ORDER BY id DESC LIMIT 1`,
        );
        meetingId = Number(back[0]?.id ?? 0);
      }
      // 真人首条消息（round 0；staff 显示名附加「·deptKey」）
      const displayName =
        actor.kind === "staff" ? `${actor.displayName}·${actor.deptKey}` : actor.displayName;
      const openContent = input.opening?.trim() || `发起协同会议：${input.topic}`;
      const openIns = (await db.execute(
        sql`INSERT INTO st_meeting_messages (meetingId, participantType, participantKey, displayName, content, round)
            VALUES (${meetingId}, 'human', ${actor.username}, ${displayName},
                    ${openContent}, 0)`,
      )) as unknown;
      // iter76：开场白同步进企业会议室流（enterprise/legacy 自动跳过）
      const openHeader = Array.isArray(openIns) ? (openIns[0] as { insertId?: number }) : {};
      await pushToEnterpriseFeed({
        srcMsgId: Number(openHeader?.insertId ?? 0),
        meetingId,
        roomType,
        deptKey: roomDeptKey,
        participant: displayName,
        content: `【${input.topic}】${openContent}`,
        round: 0,
      });
      return { meetingId, topic: input.topic, status: "open" as const, roomType };
    }),

  // ─── 共生工作空间：圆桌讨论（5 个 active Agent 依次发言）────────────────────
  meetingRunRound: publicQuery
    .input(tokenInput.extend({ meetingId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const actor = await meetingActor(input.token);
      requireMeetingHead(actor);
      const db = getDb();
      const meetings = await stQuery(
        sql`SELECT id, topic, status, meetingType, participants FROM st_meetings WHERE id = ${input.meetingId} LIMIT 1`,
      );
      const meeting = meetings[0];
      if (!meeting) throw new TRPCError({ code: "NOT_FOUND", message: "会议不存在" });
      if (String(meeting.status) === "closed") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "会议已关闭，无法继续圆桌讨论" });
      }
      // iter76：会议室类型（供企业会议室同步流）
      const room = await loadMeetingRoom(input.meetingId);
      // 迭代 36：临时协同会仅轮转勾选部门的席位
      let partialDeptKeys: string[] | null = null;
      if (String(meeting.meetingType ?? "full") === "partial") {
        partialDeptKeys = parseJsonArray(meeting.participants);
        if (partialDeptKeys.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "临时协同会参会范围为空，无法开议" });
        }
      }

      const roundRows = await stQuery(
        sql`SELECT COALESCE(MAX(round), 0) AS r FROM st_meeting_messages WHERE meetingId = ${input.meetingId}`,
      );
      const round = Number(roundRows[0]?.r ?? 0) + 1;

      const digest = await buildContextDigest();
      const agentList = await listActiveAgents();
      // 迭代 28：参与智能体 = enabled 的圆桌席位（无配置则现行默认 5 位驻部智能体）
      const seats = (await loadMeetingSeats())
        .filter((s) => s.enabled)
        .filter((s) => (partialDeptKeys ? partialDeptKeys.includes(s.deptKey) : true));
      if (seats.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "参会范围内无可用圆桌席位" });
      }
      const agentByDept = new Map(agentList.map((a) => [a.deptCode, a]));
      // iter99：批量取席位挂载的军团成员档案（真实技能上下文注入发言）
      const seatMembers = await loadSeatMembers(seats.map((s) => s.memberKey));
      const MEMBER_ROLE_LABEL: Record<string, string> = {
        co: "指挥官", ex: "执行者", va: "监察者", ev: "学习者",
      };
      const transcriptRows = await stQuery(
        sql`SELECT displayName, content FROM st_meeting_messages
            WHERE meetingId = ${input.meetingId} ORDER BY id ASC LIMIT 60`,
      );

      const roundMessages: Array<{
        id: number;
        participantKey: string;
        displayName: string;
        title: string;
        avatarEmoji: string;
        content: string;
        provider: string | null;
        model: string | null;
        degraded: boolean;
        round: number;
        artifacts?: ArtifactInfo[];
        usedSkills?: string[];
        memoryCount?: number;
      }> = [];

      // 迭代 41·会议技能接线：议题 + 最近真人插话做技能匹配（T1 注入全员；T2~T4 每轮至多一次工具执行）
      const lastHumanRows = await stQuery(
        sql`SELECT content FROM st_meeting_messages
            WHERE meetingId = ${input.meetingId} AND participantType = 'human' ORDER BY id DESC LIMIT 2`,
      );
      const skillCue = `${String(meeting.topic)}\n${lastHumanRows.map((r) => String(r.content)).join("\n")}`;
      // 会议为多席位场景，无单一 agentCode，挂载加权此处传 undefined
      const meetingSkills = await matchDeptSkills(skillCue, undefined);
      const skillBlock = buildSkillPromptBlock(meetingSkills);
      const toolSkill = meetingSkills.find((s) => resolveSkillExecutor(s.skillKey)) ?? null;
      let toolUsed = false;

      for (const seat of seats) {
        const agent = agentByDept.get(seat.deptKey);
        if (!agent) continue; // 席位部门无驻部智能体：跳过
        const ag = agent; // 闭包内类型收窄（seatLlmReply/工具管线使用）
        const personaPart = seat.personaHint.trim()
          ? `\n\n【席位人设提示】\n${clip(seat.personaHint.trim(), 500)}`
          : "";
        // iter99：席位挂军团成员 → 真实职责/挂载技能上下文注入
        const seatMember = seat.memberKey ? seatMembers.get(seat.memberKey) : undefined;
        const memberPart = seatMember
          ? `\n\n【熊猫军团成员档案】\n角色：${MEMBER_ROLE_LABEL[seatMember.role] ?? seatMember.role}（${seatMember.refKey}）\n职责与已挂载技能：${clip(seatMember.duty || "（未填写）", 400)}\n请以该军团成员的身份发言，优先运用其已挂载技能的经验。`
          : "";
        const transcript = clip(
          transcriptRows.map((m) => `${String(m.displayName)}：${clip(String(m.content), 200)}`).join("\n"),
          2500,
        );
        // 迭代65·圆桌记忆读路径：席位员工记住会议发起人（与单聊同一 actor 口径）
        const seatMemories = await getAgentMemories(ag.code, actor.username);
        const seatMemoryBlock = buildMemoryBlock(seatMemories);
        const seatMemoryCount = seatMemories.length;

        // T2~T4 + 迭代84·通用执行器：本轮尚未执行工具且命中可执行技能 → 该席位直接产出真结果
        let reply: { content: string; provider: string | null; model: string | null; degraded: boolean };
        let seatArtifacts: ArtifactInfo[] = [];
        if (toolSkill && !toolUsed) {
          const kind = resolveSkillExecutor(toolSkill.skillKey);
          let toolRun: { artifacts: ArtifactInfo[]; brief: string; degraded?: boolean } | null = null;
          if (kind && !isGenericExecutorKind(kind)) {
            toolRun = await executeSkillTool(toolSkill, skillCue, {
              agentCode: ag.code,
              threadId: input.meetingId,
              actor: actor.username,
              channel: "meeting",
            });
          } else if (kind) {
            const g = await executeGenericSkill({
              skill: toolSkill,
              content: skillCue,
              agentName: seat.agentName || ag.name,
              agentCode: ag.code,
              ctx: {
                agentCode: ag.code,
                threadId: input.meetingId,
                actor: actor.username,
                channel: "meeting",
              },
            });
            toolRun = { artifacts: g.artifact ? [g.artifact] : [], brief: g.text, degraded: g.degraded ?? false };
          }
          if (toolRun) {
            toolUsed = true;
            seatArtifacts = toolRun.artifacts;
            reply = { content: toolRun.brief, provider: "skill-tool", model: null, degraded: toolRun.degraded === true };
          } else {
            reply = await seatLlmReply();
          }
        } else {
          reply = await seatLlmReply();
        }

        async function seatLlmReply() {
          return llmReplyOrDegraded(
          [
            {
              role: "system",
              content: `${ag.systemPrompt}${personaPart}${memberPart}\n\n你正在共生工作空间参加多部门圆桌会议。议题：「${String(meeting.topic)}」。你是圆桌发言人${seat.agentName ? `（${seat.agentName}）` : ""}，发言 3-5 句、务实、与其他部门视角互补、给出可执行动作。\n\n【两系统实时数据摘要】\n${digest}${skillBlock}${seatMemoryBlock}`,
            },
            {
              role: "user",
              content: `以下为本次会议已有发言纪要，请作为${ag.title}发表本轮看法：\n${transcript || "（暂无其他发言，你是首位发言人）"}`,
            },
          ],
          [
            `${seat.agentName}（${ag.title}）规则参考发言：`,
            `1. 围绕议题「${clip(String(meeting.topic), 60)}」，本部门视角下建议先对齐两系统当前数据基线（注册 ${digest.includes("注册账号") ? "见实时摘要" : "—"}）。`,
            `2. 建议明确一项本部门本周可交付的具体动作，并在下轮会议复盘进展。`,
            `3. 跨部门协同事项建议由总经理室统一排期，避免口径不一致。`,
          ].join("\n"),
          500,
          45_000,
          "chat",
          );
        }

        const seatMemoryReported = seatArtifacts.length > 0 ? 0 : seatMemoryCount;
        const ins = (await db.execute(
          sql`INSERT INTO st_meeting_messages (meetingId, participantType, participantKey, displayName, content, provider, degraded, round, memory_count)
              VALUES (${input.meetingId}, 'agent', ${ag.code}, ${seat.agentName},
                      ${reply.content}, ${reply.provider}, ${reply.degraded ? 1 : 0}, ${round}, ${seatMemoryReported})`,
        )) as unknown;
        const insHeader = Array.isArray(ins) ? (ins[0] as { insertId?: number }) : {};
        // iter76：Agent 发言同步进企业会议室流
        await pushToEnterpriseFeed({
          srcMsgId: Number(insHeader?.insertId ?? 0),
          meetingId: input.meetingId,
          roomType: room.roomType,
          deptKey: room.deptKey,
          participant: seat.agentName,
          content: reply.content,
          round,
        });
        transcriptRows.push({ displayName: seat.agentName, content: reply.content });
        roundMessages.push({
          id: Number(insHeader?.insertId ?? 0),
          participantKey: ag.code,
          displayName: seat.agentName,
          title: ag.title,
          avatarEmoji: ag.avatarEmoji,
          content: reply.content,
          provider: reply.provider,
          model: reply.model,
          degraded: reply.degraded,
          round,
          artifacts: seatArtifacts,
          usedSkills: meetingSkills.map((s) => s.name),
          // 迭代65 诚实口径：工具产出路径未注入记忆 → 0；LLM 发言路径为实际注入条数
          memoryCount: seatMemoryReported,
        });
      }

      await db.execute(
        sql`UPDATE st_meetings SET updatedAt = NOW() WHERE id = ${input.meetingId}`,
      );
      return { meetingId: input.meetingId, round, messages: roundMessages };
    }),

  // ─── 共生工作空间：真人插话 ────────────────────────────────────────────────
  meetingHumanSay: publicQuery
    .input(
      tokenInput.extend({
        meetingId: z.number().int().positive(),
        content: z.string().trim().min(1, "发言不能为空").max(1000),
      }),
    )
    .mutation(async ({ input }) => {
      const actor = await meetingActor(input.token);
      const db = getDb();
      const meetings = await stQuery(
        sql`SELECT id, status FROM st_meetings WHERE id = ${input.meetingId} LIMIT 1`,
      );
      if (!meetings[0]) throw new TRPCError({ code: "NOT_FOUND", message: "会议不存在" });
      const roundRows = await stQuery(
        sql`SELECT COALESCE(MAX(round), 0) AS r FROM st_meeting_messages WHERE meetingId = ${input.meetingId}`,
      );
      const round = Number(roundRows[0]?.r ?? 0);
      const displayName =
        actor.kind === "staff" ? `${actor.displayName}·${actor.deptKey}` : actor.displayName;
      const sayIns = (await db.execute(
        sql`INSERT INTO st_meeting_messages (meetingId, participantType, participantKey, displayName, content, round)
            VALUES (${input.meetingId}, 'human', ${actor.username}, ${displayName}, ${input.content}, ${round})`,
      )) as unknown;
      // iter76：真人插话同步进企业会议室流
      const room = await loadMeetingRoom(input.meetingId);
      const sayHeader = Array.isArray(sayIns) ? (sayIns[0] as { insertId?: number }) : {};
      await pushToEnterpriseFeed({
        srcMsgId: Number(sayHeader?.insertId ?? 0),
        meetingId: input.meetingId,
        roomType: room.roomType,
        deptKey: room.deptKey,
        participant: displayName,
        content: input.content,
        round,
      });
      await db.execute(
        sql`UPDATE st_meetings SET updatedAt = NOW() WHERE id = ${input.meetingId}`,
      );
      // 迭代66·圆桌记忆写路径：真人插话对每个参会席位驻部 agent（按 code 去重）
      // fire-and-forget 抽取个体记忆；与单聊同一 actor 口径，开完会不再忘。
      let memoryExtraction = 0;
      try {
        const agentList = await listActiveAgents();
        const agentByDept = new Map(agentList.map((a) => [a.deptCode, a]));
        const seatCodes = new Set<string>();
        for (const s of await loadMeetingSeats()) {
          if (!s.enabled) continue;
          const ag = agentByDept.get(s.deptKey);
          if (ag) seatCodes.add(ag.code);
        }
        memoryExtraction = seatCodes.size;
        for (const code of seatCodes) {
          void extractAndSaveMemories(code, actor.username, input.content, "（圆桌会议真人插话，无逐句应答）");
        }
      } catch (e) { /* 席位解析失败打点观测（A3），不影响插话主流程 */
        noteSilent("memory.meetingSay.seats", e);
      }
      return { ok: true as const, round, memoryExtraction };
    }),

  // ─── iter76 熊猫组织底座：企业会议室同步流（全部会议室工作内容汇聚）─────────
  enterpriseFeed: publicQuery
    .input(
      tokenInput.extend({
        limit: z.number().int().min(1).max(200).optional().default(50),
      }),
    )
    .query(async ({ input }) => {
      const actor = await meetingActor(input.token);
      requireMeetingHead(actor);
      let items: Array<Record<string, unknown>> = [];
      try {
        items = await stQuery(
          sql`SELECT f.id, f.src_meeting_id AS meetingId, m.topic, f.room_type AS roomType,
                     f.dept_key AS deptKey, f.participant, f.content, f.round, f.created_at AS createdAt
              FROM st_enterprise_feed f
              LEFT JOIN st_meetings m ON m.id = f.src_meeting_id
              ORDER BY f.id DESC LIMIT ${input.limit}`,
        );
      } catch (e) {
        noteSilent("meeting.enterpriseFeed.list", e);
      }
      return { items };
    }),

  // ─── 共生工作空间：生成会议纪要（LLM，降级=按部门拼接各 Agent 首句）─────────
  meetingSummarize: publicQuery
    .input(tokenInput.extend({ meetingId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const actor = await meetingActor(input.token);
      requireMeetingHead(actor);
      const db = getDb();
      const meetings = await stQuery(
        sql`SELECT id, topic, status FROM st_meetings WHERE id = ${input.meetingId} LIMIT 1`,
      );
      const meeting = meetings[0];
      if (!meeting) throw new TRPCError({ code: "NOT_FOUND", message: "会议不存在" });

      const msgs = await stQuery(
        sql`SELECT participantType, displayName, content, round FROM st_meeting_messages
            WHERE meetingId = ${input.meetingId} ORDER BY id ASC LIMIT 100`,
      );
      if (msgs.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "会议暂无发言，无法生成纪要" });
      }

      const transcript = clip(
        msgs
          .map((m) => `[第${Number(m.round)}轮] ${String(m.displayName)}：${clip(String(m.content), 260)}`)
          .join("\n"),
        3500,
      );
      const reply = await llmReplyOrDegraded(
        [
          {
            role: "system",
            content:
              "你是广东灵智枢生态科技有限公司总经理助理，负责为多部门协同会议生成纪要。要求：务实中文，先一句结论，再按部门分点列出关键观点，最后给出 3 条可执行的后续动作；Token 只按「结算/兑换/计量」口径表述。",
          },
          {
            role: "user",
            content: `会议议题：「${String(meeting.topic)}」\n以下为完整发言记录，请生成会议纪要：\n${transcript}`,
          },
        ],
        (() => {
          // 规则摘要：按部门拼接各 Agent 首句
          const firstLines = new Map<string, string>();
          for (const m of msgs) {
            if (String(m.participantType) !== "agent") continue;
            const name = String(m.displayName);
            if (firstLines.has(name)) continue;
            const first = String(m.content).split(/[\n。]/).find((s) => s.trim().length > 0) ?? "";
            firstLines.set(name, clip(first.trim(), 80));
          }
          const lines = [...firstLines.entries()].map(([name, line]) => `· ${name}：${line}`);
          return [
            `会议「${String(meeting.topic)}」规则纪要（按部门拼接各 Agent 首句）：`,
            ...lines,
            `后续动作：1. 各部门确认本轮建议的落地负责人；2. 一周后在共生工作空间复盘进展；3. 涉及跨部门事项由总经理室统一排期。`,
          ].join("\n");
        })(),
        900,
        45_000,
        "flash",
      );

      await db.execute(
        sql`UPDATE st_meetings SET status = 'summarized', summary = ${reply.content}, updatedAt = NOW()
            WHERE id = ${input.meetingId}`,
      );
      return { meetingId: input.meetingId, summary: reply.content, provider: reply.provider, model: reply.model, degraded: reply.degraded };
    }),

  // ─── 迭代 36：纪要抄送（summarized 后按部门分发到收件箱）────────────────────
  meetingCc: publicQuery
    .input(
      tokenInput.extend({
        meetingId: z.number().int().positive(),
        deptKeys: z.array(z.string().trim().min(1).max(64)).min(1, "至少选择 1 个抄送部门").max(20),
      }),
    )
    .mutation(async ({ input }) => {
      const actor = await meetingActor(input.token);
      requireMeetingHead(actor);
      const db = getDb();
      const meetings = await stQuery(
        sql`SELECT id, topic, status, summary FROM st_meetings WHERE id = ${input.meetingId} LIMIT 1`,
      );
      const meeting = meetings[0];
      if (!meeting) throw new TRPCError({ code: "NOT_FOUND", message: "会议不存在" });
      if (meeting.summary == null || String(meeting.summary).length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "请先生成会议纪要，再抄送各部门" });
      }
      // 校验部门真实存在
      const deptRows = await stQuery(sql`SELECT code FROM st_departments`);
      const validCodes = new Set(deptRows.map((d) => String(d.code)));
      const requested = [...new Set(input.deptKeys)];
      const invalid = requested.filter((d) => !validCodes.has(d));
      if (invalid.length > 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `部门不存在：${invalid.join("、")}` });
      }
      let inserted = 0;
      for (const deptKey of requested) {
        const res = (await db.execute(
          sql`INSERT IGNORE INTO st_meeting_inbox (meetingId, deptKey) VALUES (${input.meetingId}, ${deptKey})`,
        )) as unknown;
        const header = Array.isArray(res) ? (res[0] as { affectedRows?: number }) : {};
        inserted += Number(header?.affectedRows ?? 0);
      }
      await db.execute(
        sql`UPDATE st_meetings SET ccDepts = ${JSON.stringify(requested)}, ccStatus = 'sent', updatedAt = NOW()
            WHERE id = ${input.meetingId}`,
      );
      return { ok: true as const, meetingId: input.meetingId, ccCount: requested.length, newCount: inserted };
    }),

  // ─── 迭代 36：抄送收件箱（staff 仅本部门；admin 可看全部/按部门过滤）─────────
  ccInbox: publicQuery
    .input(tokenInput.extend({ deptKey: z.string().trim().max(64).optional() }))
    .query(async ({ input }) => {
      const actor = await meetingActor(input.token);
      let deptFilter: string | null = null;
      if (actor.kind === "staff") {
        deptFilter = actor.deptKey; // 部门空间严格限定本部门
      } else {
        deptFilter = input.deptKey?.trim() ? input.deptKey.trim() : null;
      }
      const rows = await stQuery(
        sql`SELECT i.id, i.meetingId, i.deptKey, i.readAt, i.dispatchedThreadId, i.createdAt,
              m.topic, m.meetingType, m.projectTag, m.summary
            FROM st_meeting_inbox i
            JOIN st_meetings m ON m.id = i.meetingId
            WHERE (${deptFilter} IS NULL OR i.deptKey = ${deptFilter})
            ORDER BY i.id DESC LIMIT 50`,
      );
      const items = rows.map((r) => ({
        id: Number(r.id),
        meetingId: Number(r.meetingId),
        deptKey: String(r.deptKey),
        topic: String(r.topic),
        meetingType: String(r.meetingType ?? "full"),
        projectTag: r.projectTag == null ? null : String(r.projectTag),
        summary: r.summary == null ? null : String(r.summary),
        read: r.readAt != null,
        readAt: r.readAt,
        dispatchedThreadId: r.dispatchedThreadId == null ? null : Number(r.dispatchedThreadId),
        createdAt: r.createdAt,
      }));
      return { items, unread: items.filter((x) => !x.read).length };
    }),

  // ─── 迭代 36：抄送已读（staff 仅本部门条目）────────────────────────────────
  ccRead: publicQuery
    .input(tokenInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const actor = await meetingActor(input.token);
      const rows = await stQuery(sql`SELECT id, deptKey FROM st_meeting_inbox WHERE id = ${input.id} LIMIT 1`);
      const item = rows[0];
      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "抄送条目不存在" });
      if (actor.kind === "staff" && String(item.deptKey) !== actor.deptKey) {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅可操作本部门抄送条目" });
      }
      await getDb().execute(
        sql`UPDATE st_meeting_inbox SET readAt = COALESCE(readAt, NOW()) WHERE id = ${input.id}`,
      );
      return { ok: true as const };
    }),

  // ─── 迭代 36：抄送转任务——以纪要+交办指令开启本部门 Agent 单聊线程 ───────────
  ccDispatch: publicQuery
    .input(
      tokenInput.extend({
        id: z.number().int().positive(),
        instruction: z.string().trim().min(2, "交办指令至少 2 个字").max(500),
      }),
    )
    .mutation(async ({ input }) => {
      const actor = await meetingActor(input.token);
      requireMeetingHead(actor);
      const rows = await stQuery(
        sql`SELECT i.id, i.deptKey, i.dispatchedThreadId, m.topic, m.summary
            FROM st_meeting_inbox i JOIN st_meetings m ON m.id = i.meetingId
            WHERE i.id = ${input.id} LIMIT 1`,
      );
      const item = rows[0];
      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "抄送条目不存在" });
      if (actor.kind === "staff" && String(item.deptKey) !== actor.deptKey) {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅可将本部门抄送转为任务" });
      }
      if (item.dispatchedThreadId != null) {
        return { ok: true as const, threadId: Number(item.dispatchedThreadId), already: true };
      }
      // 本部门驻部 Agent
      const agentsRows = await stQuery(
        sql`SELECT code, name, title FROM st_agents WHERE deptCode = ${String(item.deptKey)} AND status = 'active'
            ORDER BY id ASC LIMIT 1`,
      );
      const agent = agentsRows[0];
      if (!agent) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "该部门暂无可用驻部智能体" });
      const db = getDb();
      // 幂等：同一 actor 同一 Agent 复用最新线程
      const existing = await stQuery(
        sql`SELECT id FROM st_chat_threads WHERE userId = ${actor.id} AND agentCode = ${String(agent.code)}
            ORDER BY updatedAt DESC LIMIT 1`,
      );
      let threadId = Number(existing[0]?.id ?? 0);
      if (!threadId) {
        const title = `${String(agent.name)}·${String(agent.title)} 对话`;
        const res = (await db.execute(
          sql`INSERT INTO st_chat_threads (agentCode, userId, title) VALUES (${String(agent.code)}, ${actor.id}, ${title})`,
        )) as unknown;
        const header = Array.isArray(res) ? (res[0] as { insertId?: number }) : {};
        threadId = Number(header?.insertId ?? 0);
        if (!threadId) {
          const back = await stQuery(
            sql`SELECT id FROM st_chat_threads WHERE userId = ${actor.id} AND agentCode = ${String(agent.code)} ORDER BY id DESC LIMIT 1`,
          );
          threadId = Number(back[0]?.id ?? 0);
        }
      }
      // 种子消息：纪要 + 交办指令（下一轮对话由 staff 在单聊界面继续）
      const seed = [
        `【会议纪要转任务】议题：「${clip(String(item.topic), 80)}」`,
        `纪要摘要：${clip(String(item.summary ?? ""), 500)}`,
        `交办指令：${input.instruction}`,
      ].join("\n");
      await db.execute(
        sql`INSERT INTO st_chat_messages (threadId, role, content) VALUES (${threadId}, 'user', ${seed})`,
      );
      await db.execute(sql`UPDATE st_chat_threads SET updatedAt = NOW() WHERE id = ${threadId}`);
      await db.execute(
        sql`UPDATE st_meeting_inbox SET dispatchedThreadId = ${threadId}, readAt = COALESCE(readAt, NOW())
            WHERE id = ${input.id}`,
      );
      return { ok: true as const, threadId, already: false };
    }),

  // ─── 迭代 28：圆桌席位配置读取（admin/staff 均可）──────────────────────────
  meetingGetConfig: publicQuery.input(tokenInput).query(async ({ input }) => {
    await meetingActor(input.token);
    const seats = await loadMeetingSeats();
    return { seats };
  }),

  // ─── iter99：可挂席位的熊猫军团成员清单（enabled=1，key="role:ref_key"）───
  meetingCorpsMembers: publicQuery.input(tokenInput).query(async ({ input }) => {
    await meetingActor(input.token);
    const rows = await stQuery(
      sql`SELECT CONCAT(role, ':', ref_key) AS memberKey, role, ref_key AS refKey, duty,
                 factory_id AS factoryId
          FROM st_panda_members WHERE enabled = 1 ORDER BY role, ref_key LIMIT 200`,
    );
    return {
      members: rows.map((r) => ({
        memberKey: String(r.memberKey),
        role: String(r.role),
        refKey: String(r.refKey),
        duty: r.duty == null ? "" : String(r.duty),
        factoryId: r.factoryId == null ? null : Number(r.factoryId),
      })),
    };
  }),

  // ─── 迭代 28：圆桌席位配置保存（admin 任意部门；head 仅本部门；member 禁止）─
  meetingSaveConfig: publicQuery
    .input(
      tokenInput.extend({
        deptKey: z.string().trim().min(1, "部门标识不能为空").max(64),
        agentName: z.string().trim().min(1, "席位名称不能为空").max(64),
        personaHint: z.string().trim().max(2000).optional().default(""),
        enabled: z.boolean(),
        // iter99：可选挂载熊猫军团成员（"role:ref_key"；空串/缺省=不挂）
        memberKey: z.string().trim().max(96).optional().default(""),
      }),
    )
    .mutation(async ({ input }) => {
      const actor = await meetingActor(input.token);
      if (actor.kind === "staff") {
        if (actor.staffRole !== "head") {
          throw new TRPCError({ code: "FORBIDDEN", message: HEAD_REQUIRED });
        }
        if (actor.deptKey !== input.deptKey) {
          throw new TRPCError({ code: "FORBIDDEN", message: "仅可配置本部门席位" });
        }
      }
      const memberKey = input.memberKey.trim() === "" ? null : input.memberKey.trim();
      if (memberKey) {
        // 校验格式 + 真实存在且 enabled=1（st_panda_members）
        const [role, refKey] = memberKey.split(":", 2);
        if (!role || !refKey) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "memberKey 格式应为 role:ref_key（如 ex:panda-ex-01）" });
        }
        const rows = await stQuery(
          sql`SELECT id FROM st_panda_members WHERE role = ${role} AND ref_key = ${refKey} AND enabled = 1 LIMIT 1`,
        );
        if (!rows[0]) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `军团成员 ${memberKey} 不存在或已停用` });
        }
      }
      await getDb().execute(
        sql`INSERT INTO st_meeting_config (dept_key, agent_name, persona_hint, member_key, enabled, updated_by)
            VALUES (${input.deptKey}, ${input.agentName}, ${input.personaHint}, ${memberKey}, ${input.enabled ? 1 : 0}, ${actor.username})
            ON DUPLICATE KEY UPDATE
              agent_name = VALUES(agent_name), persona_hint = VALUES(persona_hint),
              member_key = VALUES(member_key),
              enabled = VALUES(enabled), updated_by = VALUES(updated_by)`,
      );
      return { ok: true as const, memberKey };
    }),

  // ─── 共生工作空间：会议列表 ────────────────────────────────────────────────
  meetingList: publicQuery
    .input(
      tokenInput.extend({
        // 迭代 36：类型 / 项目标签筛选（可选）
        meetingType: z.enum(["full", "partial"]).optional(),
        // iter76b：按会议室类型筛选
        roomType: z.enum(["enterprise", "dept", "cross", "legacy"]).optional(),
        projectTag: z.string().trim().max(64).optional(),
      }),
    )
    .query(async ({ input }) => {
      await meetingActor(input.token);
      const rows = await stQuery(
        sql`SELECT m.id, m.topic, m.status, m.summary, m.createdAt, m.updatedAt,
              m.meetingType, m.participants, m.projectTag, m.ccStatus, m.room_type, m.dept_key,
              (SELECT count(*) FROM st_meeting_messages mm WHERE mm.meetingId = m.id) AS messageCount,
              (SELECT COALESCE(MAX(mm.round), 0) FROM st_meeting_messages mm WHERE mm.meetingId = m.id) AS round
            FROM st_meetings m
            WHERE (${input.meetingType ?? null} IS NULL OR m.meetingType = ${input.meetingType ?? null})
              AND (${input.roomType ?? null} IS NULL OR m.room_type = ${input.roomType ?? null})
              AND (${input.projectTag ?? null} IS NULL OR m.projectTag = ${input.projectTag ?? null})
            ORDER BY m.id DESC LIMIT 50`,
      );
      return {
        items: rows.map((r) => ({
          id: Number(r.id),
          topic: String(r.topic),
          status: String(r.status),
          meetingType: String(r.meetingType ?? "full"),
          roomType: String(r.room_type ?? "legacy"),
          deptKey: r.dept_key == null ? null : String(r.dept_key),
          projectTag: r.projectTag == null ? null : String(r.projectTag),
          ccStatus: String(r.ccStatus ?? "none"),
          hasSummary: r.summary != null && String(r.summary).length > 0,
          messageCount: Number(r.messageCount ?? 0),
          round: Number(r.round ?? 0),
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
      };
    }),

  // ─── 共生工作空间：会议详情（含全部消息）───────────────────────────────────
  meetingDetail: publicQuery
    .input(tokenInput.extend({ meetingId: z.number().int().positive() }))
    .query(async ({ input }) => {
      await meetingActor(input.token);
      const meetings = await stQuery(
        sql`SELECT id, topic, status, summary, createdAt, updatedAt, meetingType, participants, projectTag, ccDepts, ccStatus, room_type, dept_key
            FROM st_meetings WHERE id = ${input.meetingId} LIMIT 1`,
      );
      const meeting = meetings[0];
      if (!meeting) throw new TRPCError({ code: "NOT_FOUND", message: "会议不存在" });
      const msgs = await stQuery(
        sql`SELECT id, participantType, participantKey, displayName, content, provider, degraded, round, memory_count AS memoryCount, createdAt
            FROM st_meeting_messages WHERE meetingId = ${input.meetingId} ORDER BY id ASC LIMIT 300`,
      );
      // 迭代 36：抄送状态（哪些部门已抄送、已读时间）
      let ccItems: Array<{ deptKey: string; readAt: unknown; dispatchedThreadId: number | null }> = [];
      try {
        const ccRows = await stQuery(
          sql`SELECT deptKey, readAt, dispatchedThreadId FROM st_meeting_inbox WHERE meetingId = ${input.meetingId}`,
        );
        ccItems = ccRows.map((r) => ({
          deptKey: String(r.deptKey),
          readAt: r.readAt,
          dispatchedThreadId: r.dispatchedThreadId == null ? null : Number(r.dispatchedThreadId),
        }));
      } catch {
        ccItems = [];
      }
      // 迭代 41：会议产出物（技能工具落盘文件，按 meetingId 归集）
      const artifactRows = await stQuery(
        sql`SELECT id, kind, title, filename, sizeBytes, agentCode, createdAt FROM st_agent_artifacts
            WHERE channel = 'meeting' AND threadId = ${input.meetingId} ORDER BY id ASC LIMIT 50`,
      );
      return {
        artifacts: artifactRows.map((a) => ({
          id: Number(a.id),
          kind: String(a.kind),
          title: String(a.title),
          filename: String(a.filename),
          sizeBytes: Number(a.sizeBytes),
          agentCode: String(a.agentCode),
          createdAt: a.createdAt,
        })),
        meeting: {
          id: Number(meeting.id),
          topic: String(meeting.topic),
          status: String(meeting.status),
          meetingType: String(meeting.meetingType ?? "full"),
          roomType: String(meeting.room_type ?? "legacy"),
          deptKey: meeting.dept_key == null ? null : String(meeting.dept_key),
          participants: parseJsonArray(meeting.participants),
          projectTag: meeting.projectTag == null ? null : String(meeting.projectTag),
          ccStatus: String(meeting.ccStatus ?? "none"),
          ccItems,
          summary: meeting.summary == null ? null : String(meeting.summary),
          createdAt: meeting.createdAt,
          updatedAt: meeting.updatedAt,
        },
        messages: msgs.map((m) => ({
          id: Number(m.id),
          participantType: String(m.participantType),
          participantKey: String(m.participantKey),
          displayName: String(m.displayName),
          content: String(m.content),
          provider: m.provider == null ? null : String(m.provider),
          degraded: Number(m.degraded) === 1,
          round: Number(m.round),
          memoryCount: Number(m.memoryCount ?? 0),
          createdAt: m.createdAt,
        })),
      };
    }),

  /** 迭代 39：当前管理员身份（含委派标记）——前端登录后确认放行口径用 */
  adminWhoami: publicQuery.input(tokenInput).query(async ({ input }) => {
    const user = await requireHqAdmin(input.token);
    const u = user as unknown as Record<string, unknown>;
    return {
      username: String(u.username ?? ""),
      displayName: String(u.displayName ?? u.username ?? "管理员"),
      role: "admin" as const,
      delegated: u.delegated === true,
    };
  }),

  // ─── 迭代 37：部门班组（多 Agent 同事 + 并行协同 + 四权介入）──────────────────
  /** 班组席位列表：lead（st_agents 驻部智能体）+ mate（st_dept_mates） */
  mateList: publicQuery
    .input(tokenInput.extend({ deptKey: z.string().trim().min(1).max(32).optional() }))
    .query(async ({ input }) => {
      const actor = await meetingActor(input.token);
      const deptKey = actor.kind === "staff" ? actor.deptKey : (input.deptKey ?? null);
      if (!deptKey) throw new TRPCError({ code: "BAD_REQUEST", message: "缺少部门参数" });
      const leads = await stQuery(
        sql`SELECT id, name, title, systemPrompt, status FROM st_agents
            WHERE deptCode = ${deptKey} AND status = 'active' ORDER BY id ASC LIMIT 1`,
      );
      const lead = leads[0]
        ? {
            seatType: "lead" as const,
            seatId: Number(leads[0].id),
            agentName: String(leads[0].name),
            title: String(leads[0].title),
            preferredModel: "glm",
            specialty: "主理 · 任务分派与汇总",
            budgetDaily: null as number | null,
            tokensToday: 0,
            status: String(leads[0].status),
          }
        : null;
      const mates = await stQuery(
        sql`SELECT id, agentName, title, preferredModel, specialty, budgetDaily, tokensToday, tokensDate, status
            FROM st_dept_mates WHERE deptKey = ${deptKey} AND status != 'removed' ORDER BY id ASC`,
      );
      const today = new Date().toISOString().slice(0, 10);
      return {
        deptKey,
        lead,
        mates: mates.map((m) => ({
          seatType: "mate" as const,
          seatId: Number(m.id),
          agentName: String(m.agentName),
          title: String(m.title),
          preferredModel: String(m.preferredModel),
          specialty: m.specialty == null ? null : String(m.specialty),
          budgetDaily: m.budgetDaily == null ? null : Number(m.budgetDaily),
          tokensToday: String(m.tokensDate ?? "").slice(0, 10) === today ? Number(m.tokensToday) : 0,
          status: String(m.status),
        })),
      };
    }),

  /** 配同事（mate）：负责人/管理员；单部门 active+paused ≤ 4 */
  mateCreate: publicQuery
    .input(
      tokenInput.extend({
        deptKey: z.string().trim().min(1).max(32).optional(),
        agentName: z.string().trim().min(1, "同事名不能为空").max(64),
        title: z.string().trim().min(1).max(64).optional(),
        preferredModel: z.enum(["kimi", "deepseek", "glm", "minimax", "claude", "gpt", "qwen", "gpt-oss", "gemma", "idoictos"]),
        specialty: z.string().trim().max(64).optional(),
        budgetDaily: z.number().int().positive().max(1_000_000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const actor = await meetingActor(input.token);
      requireMeetingHead(actor);
      const deptKey = actor.kind === "staff" ? actor.deptKey : input.deptKey;
      if (!deptKey) throw new TRPCError({ code: "BAD_REQUEST", message: "缺少部门参数" });
      const countRows = await stQuery(
        sql`SELECT COUNT(*) AS c FROM st_dept_mates WHERE deptKey = ${deptKey} AND status != 'removed'`,
      );
      if (Number(countRows[0]?.c ?? 0) >= 4) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "班组同事已达上限（4 位）" });
      }
      const deptRows = await stQuery(sql`SELECT code FROM st_departments WHERE code = ${deptKey} LIMIT 1`);
      if (!deptRows[0]) throw new TRPCError({ code: "BAD_REQUEST", message: "部门不存在" });
      const db = getDb();
      await db.execute(
        sql`INSERT INTO st_dept_mates (deptKey, agentName, title, preferredModel, specialty, budgetDaily, createdBy)
            VALUES (${deptKey}, ${input.agentName}, ${input.title ?? "班组同事"}, ${input.preferredModel},
                    ${input.specialty ?? null}, ${input.budgetDaily ?? null}, ${actor.displayName})`,
      );
      return { ok: true };
    }),

  /** 同事位调整（专长/模型/日预算/状态暂停恢复移除） */
  mateUpdate: publicQuery
    .input(
      tokenInput.extend({
        mateId: z.number().int().positive(),
        agentName: z.string().trim().min(1).max(64).optional(),
        title: z.string().trim().min(1).max(64).optional(),
        preferredModel: z.enum(["kimi", "deepseek", "glm", "minimax", "claude", "gpt", "qwen", "gpt-oss", "gemma", "idoictos"]).optional(),
        specialty: z.string().trim().max(64).nullable().optional(),
        budgetDaily: z.number().int().positive().max(1_000_000).nullable().optional(),
        status: z.enum(["active", "paused", "removed"]).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const actor = await meetingActor(input.token);
      requireMeetingHead(actor);
      const rows = await stQuery(sql`SELECT id, deptKey FROM st_dept_mates WHERE id = ${input.mateId} LIMIT 1`);
      const mate = rows[0];
      if (!mate) throw new TRPCError({ code: "NOT_FOUND", message: "同事位不存在" });
      if (actor.kind === "staff" && actor.deptKey !== String(mate.deptKey)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "无权管理其他部门班组" });
      }
      const db = getDb();
      await db.execute(
        sql`UPDATE st_dept_mates SET
              agentName = COALESCE(${input.agentName ?? null}, agentName),
              title = COALESCE(${input.title ?? null}, title),
              preferredModel = COALESCE(${input.preferredModel ?? null}, preferredModel),
              specialty = CASE WHEN ${input.specialty === undefined ? 1 : 0} = 1 THEN specialty ELSE ${input.specialty ?? null} END,
              budgetDaily = CASE WHEN ${input.budgetDaily === undefined ? 1 : 0} = 1 THEN budgetDaily ELSE ${input.budgetDaily ?? null} END,
              status = COALESCE(${input.status ?? null}, status)
            WHERE id = ${input.mateId}`,
      );
      return { ok: true };
    }),

  /** 发起协同任务：拆解草案（规则兜底确定性）→ draft，待人确认 */
  swarmCreate: publicQuery
    .input(
      tokenInput.extend({
        deptKey: z.string().trim().min(1).max(32).optional(),
        title: z.string().trim().min(1, "任务标题不能为空").max(128),
        instruction: z.string().trim().min(1, "任务指令不能为空").max(4000),
        budgetCap: z.number().int().positive().max(10_000_000).optional(),
        docIds: z.array(z.number().int().positive()).max(5, "附带资料最多 5 份").optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const actor = await meetingActor(input.token);
      requireMeetingHead(actor);
      const deptKey = actor.kind === "staff" ? actor.deptKey : input.deptKey;
      if (!deptKey) throw new TRPCError({ code: "BAD_REQUEST", message: "缺少部门参数" });
      const mates = await stQuery(
        sql`SELECT id, agentName, preferredModel, specialty FROM st_dept_mates
            WHERE deptKey = ${deptKey} AND status = 'active' ORDER BY id ASC`,
      );
      if (mates.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "请先在「班组」配置至少 1 位班组同事" });
      }
      // 迭代 38：附带资料校验（作用域：全局共享或本部门；须 ready）
      const docIds = [...new Set(input.docIds ?? [])];
      let docMaterial = "";
      if (docIds.length > 0) {
        const docRows = await stQuery(
          sql`SELECT id, title, textContent, dept_key, status FROM st_kb_docs
              WHERE id IN (${sql.join(docIds.map((d) => sql`${d}`), sql`, `)})`,
        );
        if (docRows.length !== docIds.length) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "附带资料不存在或已删除" });
        }
        for (const d of docRows) {
          if (d.dept_key != null && String(d.dept_key) !== deptKey) {
            throw new TRPCError({ code: "FORBIDDEN", message: "附带资料不属于本部门" });
          }
          if (String(d.status) !== "ready") {
            throw new TRPCError({ code: "BAD_REQUEST", message: `资料「${String(d.title)}」未就绪` });
          }
        }
        const parts = docRows.map((d) =>
          d.textContent == null || String(d.textContent).length === 0
            ? `【${clip(String(d.title), 60)}】（存档件，未解析正文）`
            : `【${clip(String(d.title), 60)}】\n${clip(String(d.textContent), 800)}`,
        );
        docMaterial = `\n\n【附带资料】\n${clip(parts.join("\n\n"), 2000)}`;
      }
      const db = getDb();
      const ins = await db.execute(
        sql`INSERT INTO st_swarm_tasks (deptKey, title, instruction, status, budgetCap, createdBy)
            VALUES (${deptKey}, ${input.title}, ${input.instruction}, 'draft', ${input.budgetCap ?? null}, ${actor.displayName})`,
      );
      const swarmId = Number((ins as unknown as [{ insertId: number }])[0]?.insertId ?? 0);
      let seq = 1;
      const seatIds: number[] = [];
      for (const m of mates) {
        const spec = m.specialty == null ? "" : String(m.specialty);
        const brief = `【协同任务】${input.title}\n总目标：${input.instruction}\n你的分工：请从「${spec || "通用协作"}」角度产出你负责的部分，结论先行、要点化，≤400字。${docMaterial}`;
        await db.execute(
          sql`INSERT INTO st_swarm_subtasks (swarmId, seq, seatType, seatId, seatName, model, specialty, brief)
              VALUES (${swarmId}, ${seq}, 'mate', ${Number(m.id)}, ${String(m.agentName)},
                      ${String(m.preferredModel)}, ${spec || null}, ${brief})`,
        );
        seatIds.push(Number(m.id));
        seq += 1;
      }
      await recordSwarmDocRefs(docIds, swarmId, seatIds, actor.displayName);
      return { swarmId, subtaskCount: mates.length, status: "draft", docCount: docIds.length };
    }),

  /** 确认草案与预算 → running（拍板红线①：确认后才执行） */
  swarmConfirm: publicQuery
    .input(tokenInput.extend({ swarmId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const actor = await meetingActor(input.token);
      requireMeetingHead(actor);
      const swarm = await loadSwarmOrThrow(input.swarmId);
      assertSwarmScope(actor, swarm);
      if (String(swarm.status) !== "draft") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "仅草案状态可确认执行" });
      }
      const db = getDb();
      await db.execute(sql`UPDATE st_swarm_tasks SET status = 'running' WHERE id = ${input.swarmId} AND status = 'draft'`);
      return { ok: true, status: "running" };
    }),

  /** 推进一轮：并行派发 queued 子任务（模型槽位路由 + 双预算帽 + 汇总拍板门） */
  swarmStep: publicQuery
    .input(tokenInput.extend({ swarmId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const actor = await meetingActor(input.token);
      requireMeetingHead(actor);
      const swarm = await loadSwarmOrThrow(input.swarmId);
      assertSwarmScope(actor, swarm);
      if (String(swarm.status) !== "running") {
        return { ok: true, status: String(swarm.status), ran: 0 };
      }
      const db = getDb();
      const budgetCap = swarm.budgetCap == null ? null : Number(swarm.budgetCap);
      let tokensUsed = Number(swarm.tokensUsed ?? 0);

      const queued = await stQuery(
        sql`SELECT id, seatType, seatId, seatName, model, brief, instructionExtra FROM st_swarm_subtasks
            WHERE swarmId = ${input.swarmId} AND status = 'queued' ORDER BY seq ASC LIMIT 4`,
      );
      let ran = 0;
      if (queued.length > 0) {
        if (budgetCap != null && tokensUsed >= budgetCap) {
          await db.execute(
            sql`UPDATE st_swarm_tasks SET status = 'paused', budgetBlocked = 1 WHERE id = ${input.swarmId}`,
          );
          return { ok: true, status: "paused", budgetBlocked: true, ran: 0 };
        }
        await db.execute(
          sql`UPDATE st_swarm_subtasks SET status = 'running', startedAt = NOW()
              WHERE swarmId = ${input.swarmId} AND status = 'queued' AND id IN (${sql.join(
                queued.map((q) => sql`${Number(q.id)}`),
                sql`, `,
              )})`,
        );
        const results = await Promise.all(
          queued.map(async (q) => {
            const seatType = String(q.seatType);
            let sysPrompt = "你是企业部门班组的数字员工，按分工产出结论先行、要点化的结果。";
            let mateId: number | null = null;
            if (seatType === "mate") {
              mateId = Number(q.seatId);
              const mRows = await stQuery(
                sql`SELECT agentName, title, specialty, budgetDaily, tokensToday, tokensDate, status, systemPrompt
                    FROM st_dept_mates WHERE id = ${mateId} LIMIT 1`,
              );
              const m = mRows[0];
              if (!m || String(m.status) !== "active") return { id: Number(q.id), skip: "seat_inactive" as const };
              const today = new Date().toISOString().slice(0, 10);
              const usedToday = String(m.tokensDate ?? "").slice(0, 10) === today ? Number(m.tokensToday) : 0;
              if (m.budgetDaily != null && usedToday >= Number(m.budgetDaily)) {
                return { id: Number(q.id), skip: "budget_daily" as const };
              }
              sysPrompt =
                m.systemPrompt == null
                  ? `你是${String(m.agentName)}，${String(m.title)}${m.specialty == null ? "" : `，专长${String(m.specialty)}`}。结论先行、要点化产出。`
                  : String(m.systemPrompt);
            } else {
              const aRows = await stQuery(
                sql`SELECT systemPrompt FROM st_agents WHERE id = ${Number(q.seatId)} LIMIT 1`,
              );
              if (aRows[0]) sysPrompt = String(aRows[0].systemPrompt ?? sysPrompt);
            }
            const extra = q.instructionExtra == null ? "" : `\n追加指令（人工插话）：${String(q.instructionExtra)}`;
            const reply = await llmReplyOrDegraded(
              [
                { role: "system", content: clip(sysPrompt, 2000) },
                { role: "user", content: clip(String(q.brief) + extra, 4000) },
              ],
              `分工产出（规则兜底）：\n${clip(String(q.brief), 300)}`,
              800,
              45_000,
              SWARM_MODEL_SLOT[String(q.model)] ?? "chat",
            );
            const used = Math.ceil((String(q.brief).length + extra.length + reply.content.length) / 2);
            return { id: Number(q.id), mateId, reply, used, skip: null };
          }),
        );
        for (const r of results) {
          if ("skip" in r && r.skip) {
            await db.execute(
              sql`UPDATE st_swarm_subtasks SET status = 'queued', startedAt = NULL WHERE id = ${r.id}`,
            );
            continue;
          }
          if (!("reply" in r) || !r.reply) continue;
          ran += 1;
          await db.execute(
            sql`UPDATE st_swarm_subtasks SET status = 'done', output = ${r.reply.content},
                  provider = ${r.reply.provider}, degraded = ${r.reply.degraded ? 1 : 0},
                  tokensUsed = ${r.used}, finishedAt = NOW()
                WHERE id = ${r.id}`,
          );
          tokensUsed += r.used;
          if (r.mateId != null) {
            await db.execute(
              sql`UPDATE st_dept_mates SET
                    tokensToday = IF(tokensDate = CURDATE(), tokensToday + ${r.used}, ${r.used}),
                    tokensDate = CURDATE()
                  WHERE id = ${r.mateId}`,
            );
          }
        }
        await db.execute(sql`UPDATE st_swarm_tasks SET tokensUsed = ${tokensUsed} WHERE id = ${input.swarmId}`);
      }

      // 全部子任务 done → lead 汇总 → await_review（拍板红线：未经拍板不会 done）
      const remain = await stQuery(
        sql`SELECT status, COUNT(*) AS c FROM st_swarm_subtasks WHERE swarmId = ${input.swarmId} GROUP BY status`,
      );
      const byStatus: Record<string, number> = {};
      for (const r of remain) byStatus[String(r.status)] = Number(r.c);
      const pending = (byStatus.queued ?? 0) + (byStatus.running ?? 0) + (byStatus.paused ?? 0);
      const doneCount = byStatus.done ?? 0;
      if (pending === 0 && doneCount > 0) {
        const leadRows = await stQuery(
          sql`SELECT id, name, systemPrompt FROM st_agents WHERE deptCode = ${String(swarm.deptKey)} AND status = 'active' ORDER BY id ASC LIMIT 1`,
        );
        const outs = await stQuery(
          sql`SELECT seatName, output FROM st_swarm_subtasks WHERE swarmId = ${input.swarmId} AND status = 'done' ORDER BY seq ASC`,
        );
        const material = outs.map((o) => `【${String(o.seatName)}】\n${clip(String(o.output ?? ""), 1200)}`).join("\n\n");
        const leadName = leadRows[0] ? String(leadRows[0].name) : "部门主理";
        const reply = await llmReplyOrDegraded(
          [
            {
              role: "system",
              content: clip(
                leadRows[0] ? String(leadRows[0].systemPrompt ?? "") : `你是${leadName}，负责汇总班组产出。`,
                1500,
              ),
            },
            {
              role: "user",
              content: `【汇总任务】${String(swarm.title)}\n总目标：${clip(String(swarm.instruction), 800)}\n\n以下是班组各同事的分工产出，请汇总为一份结论先行、可执行的汇总稿（≤600字）：\n\n${material}`,
            },
          ],
          `汇总（规则兜底）：共 ${outs.length} 份分工产出，详见各子任务。`,
          900,
          45_000,
          "brain",
        );
        const sumUsed = Math.ceil((material.length + reply.content.length) / 2);
        await db.execute(
          sql`UPDATE st_swarm_tasks SET status = 'await_review', summary = ${reply.content},
                summaryProvider = ${reply.provider}, summaryDegraded = ${reply.degraded ? 1 : 0},
                tokensUsed = tokensUsed + ${sumUsed}
              WHERE id = ${input.swarmId} AND status = 'running'`,
        );
        return { ok: true, status: "await_review", ran };
      }
      return { ok: true, status: "running", ran };
    }),

  /** 四权介入：插话 inject / 单点暂停 pause_one / 恢复 resume / 换人重派 reassign / 全局叫停 abort_all */
  swarmIntervene: publicQuery
    .input(
      tokenInput.extend({
        swarmId: z.number().int().positive(),
        action: z.enum(["inject", "pause_one", "resume", "reassign", "abort_all"]),
        subtaskId: z.number().int().positive().optional(),
        text: z.string().trim().max(2000).optional(),
        newSeatType: z.enum(["lead", "mate"]).optional(),
        newSeatId: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const actor = await meetingActor(input.token);
      requireMeetingHead(actor);
      const swarm = await loadSwarmOrThrow(input.swarmId);
      assertSwarmScope(actor, swarm);
      if (!["running", "paused"].includes(String(swarm.status))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "当前状态不可介入" });
      }
      const db = getDb();
      const deptKey = String(swarm.deptKey);
      let payload: Record<string, unknown> | null = null;

      if (input.action === "abort_all") {
        await db.execute(sql`UPDATE st_swarm_tasks SET status = 'cancelled' WHERE id = ${input.swarmId}`);
        await db.execute(
          sql`UPDATE st_swarm_subtasks SET status = 'cancelled', finishedAt = NOW()
              WHERE swarmId = ${input.swarmId} AND status IN ('queued','running','paused')`,
        );
      } else {
        if (!input.subtaskId) throw new TRPCError({ code: "BAD_REQUEST", message: "缺少子任务参数" });
        const subs = await stQuery(
          sql`SELECT id, swarmId, seatType, seatId, seatName, model, status, output FROM st_swarm_subtasks
              WHERE id = ${input.subtaskId} LIMIT 1`,
        );
        const sub = subs[0];
        if (!sub || Number(sub.swarmId) !== input.swarmId) {
          throw new TRPCError({ code: "NOT_FOUND", message: "子任务不存在" });
        }
        if (input.action === "inject") {
          if (!input.text) throw new TRPCError({ code: "BAD_REQUEST", message: "插话内容不能为空" });
          payload = { previousOutput: sub.output == null ? null : clip(String(sub.output), 2000) };
          await db.execute(
            sql`UPDATE st_swarm_subtasks SET
                  instructionExtra = CONCAT(COALESCE(instructionExtra, ''), ${"\n" + input.text}),
                  status = 'queued', startedAt = NULL, finishedAt = NULL
                WHERE id = ${input.subtaskId}`,
          );
          if (String(swarm.status) === "paused" && Number(swarm.budgetBlocked) !== 1) {
            await db.execute(sql`UPDATE st_swarm_tasks SET status = 'running' WHERE id = ${input.swarmId}`);
          }
        } else if (input.action === "pause_one") {
          await db.execute(
            sql`UPDATE st_swarm_subtasks SET status = 'paused' WHERE id = ${input.subtaskId} AND status IN ('queued','running')`,
          );
        } else if (input.action === "resume") {
          await db.execute(
            sql`UPDATE st_swarm_subtasks SET status = 'queued', startedAt = NULL WHERE id = ${input.subtaskId} AND status = 'paused'`,
          );
        } else if (input.action === "reassign") {
          if (!input.newSeatType) throw new TRPCError({ code: "BAD_REQUEST", message: "缺少新同事参数" });
          let seatId: number;
          let seatName: string;
          let model = "glm";
          let specialty: string | null = null;
          if (input.newSeatType === "lead") {
            const aRows = await stQuery(
              sql`SELECT id, name FROM st_agents WHERE deptCode = ${deptKey} AND status = 'active' ORDER BY id ASC LIMIT 1`,
            );
            if (!aRows[0]) throw new TRPCError({ code: "BAD_REQUEST", message: "该部门无主理智能体" });
            seatId = Number(aRows[0].id);
            seatName = String(aRows[0].name);
          } else {
            if (!input.newSeatId) throw new TRPCError({ code: "BAD_REQUEST", message: "缺少新同事参数" });
            const mRows = await stQuery(
              sql`SELECT id, agentName, preferredModel, specialty FROM st_dept_mates
                  WHERE id = ${input.newSeatId} AND deptKey = ${deptKey} AND status = 'active' LIMIT 1`,
            );
            if (!mRows[0]) throw new TRPCError({ code: "BAD_REQUEST", message: "新同事不存在或已停用" });
            seatId = Number(mRows[0].id);
            seatName = String(mRows[0].agentName);
            model = String(mRows[0].preferredModel);
            specialty = mRows[0].specialty == null ? null : String(mRows[0].specialty);
          }
          payload = {
            fromSeat: String(sub.seatName),
            toSeat: seatName,
            previousOutput: sub.output == null ? null : clip(String(sub.output), 2000),
          };
          await db.execute(
            sql`UPDATE st_swarm_subtasks SET seatType = ${input.newSeatType}, seatId = ${seatId},
                  seatName = ${seatName}, model = ${model}, specialty = ${specialty},
                  status = 'queued', output = NULL, provider = NULL, startedAt = NULL, finishedAt = NULL
                WHERE id = ${input.subtaskId}`,
          );
        }
      }
      await db.execute(
        sql`INSERT INTO st_swarm_interventions (swarmId, subtaskId, actor, action, payload)
            VALUES (${input.swarmId}, ${input.subtaskId ?? null}, ${actor.displayName}, ${input.action},
                    ${payload ? JSON.stringify(payload) : null})`,
      );
      return { ok: true };
    }),

  /** 追加预算（拍板红线②）：预算帽触发暂停后人工追加续跑 */
  swarmAddBudget: publicQuery
    .input(
      tokenInput.extend({
        swarmId: z.number().int().positive(),
        addTokens: z.number().int().positive().max(10_000_000),
      }),
    )
    .mutation(async ({ input }) => {
      const actor = await meetingActor(input.token);
      requireMeetingHead(actor);
      const swarm = await loadSwarmOrThrow(input.swarmId);
      assertSwarmScope(actor, swarm);
      const db = getDb();
      await db.execute(
        sql`UPDATE st_swarm_tasks SET
              budgetCap = COALESCE(budgetCap, 0) + ${input.addTokens},
              status = IF(budgetBlocked = 1 AND status = 'paused', 'running', status),
              budgetBlocked = 0
            WHERE id = ${input.swarmId}`,
      );
      await db.execute(
        sql`INSERT INTO st_swarm_interventions (swarmId, subtaskId, actor, action, payload)
            VALUES (${input.swarmId}, NULL, ${actor.displayName}, 'inject',
                    ${JSON.stringify({ budgetAdd: input.addTokens })})`,
      );
      return { ok: true };
    }),

  /** 汇总拍板（拍板红线③）：approve → done；reject → 打回 lead 修订 */
  swarmReview: publicQuery
    .input(
      tokenInput.extend({
        swarmId: z.number().int().positive(),
        action: z.enum(["approve", "reject"]),
        note: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const actor = await meetingActor(input.token);
      requireMeetingHead(actor);
      const swarm = await loadSwarmOrThrow(input.swarmId);
      assertSwarmScope(actor, swarm);
      if (String(swarm.status) !== "await_review") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "仅待拍板状态可拍板" });
      }
      const db = getDb();
      if (input.action === "approve") {
        await db.execute(sql`UPDATE st_swarm_tasks SET status = 'done' WHERE id = ${input.swarmId}`);
      } else {
        const leadRows = await stQuery(
          sql`SELECT id, name FROM st_agents WHERE deptCode = ${String(swarm.deptKey)} AND status = 'active' ORDER BY id ASC LIMIT 1`,
        );
        if (!leadRows[0]) throw new TRPCError({ code: "BAD_REQUEST", message: "该部门无主理智能体" });
        const seqRows = await stQuery(
          sql`SELECT COALESCE(MAX(seq), 0) AS m FROM st_swarm_subtasks WHERE swarmId = ${input.swarmId}`,
        );
        await db.execute(
          sql`INSERT INTO st_swarm_subtasks (swarmId, seq, seatType, seatId, seatName, model, specialty, brief, instructionExtra)
              VALUES (${input.swarmId}, ${Number(seqRows[0]?.m ?? 0) + 1}, 'lead', ${Number(leadRows[0].id)},
                      ${String(leadRows[0].name)}, 'kimi', '汇总修订',
                      ${`【修订任务】按拍板意见修订汇总稿：${String(swarm.title)}`},
                      ${input.note ?? "请重新修订汇总稿"})`,
        );
        await db.execute(sql`UPDATE st_swarm_tasks SET status = 'running' WHERE id = ${input.swarmId}`);
      }
      await db.execute(
        sql`INSERT INTO st_swarm_interventions (swarmId, subtaskId, actor, action, payload)
            VALUES (${input.swarmId}, NULL, ${actor.displayName}, ${input.action},
                    ${input.note ? JSON.stringify({ note: input.note }) : null})`,
      );
      return { ok: true, status: input.action === "approve" ? "done" : "running" };
    }),

  /** 协同任务列表（staff 仅本部门，admin 全部） */
  swarmList: publicQuery
    .input(
      tokenInput.extend({
        deptKey: z.string().trim().min(1).max(32).optional(),
        status: z.enum(["draft", "running", "paused", "await_review", "done", "cancelled"]).optional(),
      }),
    )
    .query(async ({ input }) => {
      const actor = await meetingActor(input.token);
      const deptKey = actor.kind === "staff" ? actor.deptKey : (input.deptKey ?? null);
      const rows = await stQuery(
        sql`SELECT s.id, s.deptKey, s.title, s.status, s.budgetCap, s.tokensUsed, s.budgetBlocked, s.createdBy, s.createdAt, s.updatedAt,
                   (SELECT COUNT(*) FROM st_swarm_subtasks t WHERE t.swarmId = s.id) AS subCount,
                   (SELECT COUNT(*) FROM st_swarm_subtasks t WHERE t.swarmId = s.id AND t.status = 'done') AS doneCount
            FROM st_swarm_tasks s
            WHERE (${deptKey} IS NULL OR s.deptKey = ${deptKey})
              AND (${input.status ?? null} IS NULL OR s.status = ${input.status ?? null})
            ORDER BY s.id DESC LIMIT 100`,
      );
      return rows.map((r) => ({
        id: Number(r.id),
        deptKey: String(r.deptKey),
        title: String(r.title),
        status: String(r.status),
        budgetCap: r.budgetCap == null ? null : Number(r.budgetCap),
        tokensUsed: Number(r.tokensUsed),
        budgetBlocked: Number(r.budgetBlocked) === 1,
        subCount: Number(r.subCount),
        doneCount: Number(r.doneCount),
        createdBy: String(r.createdBy),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    }),

  /** 作战室详情：任务 + 子任务 + 介入留痕 + 席位 */
  swarmDetail: publicQuery
    .input(tokenInput.extend({ swarmId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const actor = await meetingActor(input.token);
      const swarm = await loadSwarmOrThrow(input.swarmId);
      assertSwarmScope(actor, swarm);
      const subs = await stQuery(
        sql`SELECT id, seq, seatType, seatId, seatName, model, specialty, brief, instructionExtra,
                   status, output, provider, degraded, tokensUsed, startedAt, finishedAt
            FROM st_swarm_subtasks WHERE swarmId = ${input.swarmId} ORDER BY seq ASC`,
      );
      const ivs = await stQuery(
        sql`SELECT id, subtaskId, actor, action, payload, createdAt FROM st_swarm_interventions
            WHERE swarmId = ${input.swarmId} ORDER BY id ASC LIMIT 200`,
      );
      return {
        swarm: {
          id: Number(swarm.id),
          deptKey: String(swarm.deptKey),
          title: String(swarm.title),
          instruction: String(swarm.instruction),
          status: String(swarm.status),
          budgetCap: swarm.budgetCap == null ? null : Number(swarm.budgetCap),
          tokensUsed: Number(swarm.tokensUsed),
          budgetBlocked: Number(swarm.budgetBlocked) === 1,
          summary: swarm.summary == null ? null : String(swarm.summary),
          summaryProvider: swarm.summaryProvider == null ? null : String(swarm.summaryProvider),
          summaryDegraded: Number(swarm.summaryDegraded) === 1,
          createdBy: String(swarm.createdBy),
          createdAt: swarm.createdAt,
          updatedAt: swarm.updatedAt,
        },
        subtasks: subs.map((s) => ({
          id: Number(s.id),
          seq: Number(s.seq),
          seatType: String(s.seatType),
          seatId: Number(s.seatId),
          seatName: String(s.seatName),
          model: String(s.model),
          specialty: s.specialty == null ? null : String(s.specialty),
          brief: String(s.brief),
          instructionExtra: s.instructionExtra == null ? null : String(s.instructionExtra),
          status: String(s.status),
          output: s.output == null ? null : String(s.output),
          provider: s.provider == null ? null : String(s.provider),
          degraded: Number(s.degraded) === 1,
          tokensUsed: Number(s.tokensUsed),
          startedAt: s.startedAt,
          finishedAt: s.finishedAt,
        })),
        interventions: ivs.map((v) => ({
          id: Number(v.id),
          subtaskId: v.subtaskId == null ? null : Number(v.subtaskId),
          actor: String(v.actor),
          action: String(v.action),
          payload: v.payload == null ? null : String(typeof v.payload === "string" ? v.payload : JSON.stringify(v.payload)),
          createdAt: v.createdAt,
        })),
      };
    }),
});
