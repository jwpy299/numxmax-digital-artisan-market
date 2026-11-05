/**
 * mcpBridge —— M38「技能插件上总线」内部桥（S2 loopback/隧道专用）。
 *
 * 定位：lingshu-device-mcp（S3）把在册技能发布成 MCP 工具后，工具执行经此桥
 * 回到 S2 主栈——技能执行器/预算闸/记账纪律与语音链完全同一份，agentic 通道
 * 不是旁路，是同管线换个入口。
 *
 * 安全铁律：
 * - 内部令牌 MCP_INTERNAL_TOKEN（仅 env，时序安全比对，绝不打日志）；
 *   令牌缺失时路由整体不可用（503），绝不裸奔；
 * - skillCatalog/skillExec 仅可见集口径（loadVisibleSkills = 基础包 + 已雇佣已挂载，
 *   「雇佣即挂载」的诚实实现）；不可见技能一律 not_visible，绝不执行；
 * - 预算闸（SKILL_DAILY_BUDGET）与 st_skill_calls 记账由 execSkillDirect 内部继承；
 * - task 截断 4000 字；返回 brief + 产出物 24h 随机链接（投递纪律同语音链）。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { execSkillDirect, loadVisibleSkills } from "./voiceSkills";
import { listVoiceAgentRoster, runWorkbenchAgentTask } from "./agentBridge";
import { stQuery } from "./terminal";

/** P3 部门主官映射（落子时以在役花名册为准二次校验，主官缺位 → 取该部门任一在役，仍无 → 拒） */
const DEPT_CHIEF: Record<string, string> = {
  gm: "gm-advisor",
  finance: "lingsSuan",
  legal: "lingsHeng",
  ops: "lingsCe",
  tech: "lingsZhu",
};

/** 内部令牌时序安全校验（env-only；缺失/不等长/不符一律拒） */
function requireInternalToken(token: string): void {
  const expect = (process.env.MCP_INTERNAL_TOKEN ?? "").trim();
  if (!expect) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "mcpBridge 未配置内部令牌，通道关闭" });
  }
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(expect).digest();
  if (!timingSafeEqual(a, b)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "内部令牌无效" });
  }
}

const bridgeInput = z.object({
  token: z.string().trim().min(1),
  factoryId: z.number().int().positive(),
});

export const mcpBridgeRouter = createRouter({
  /** skillCatalog：该厂在册可用技能清单（MCP 面 tools/list 的数据源；无敏感字段） */
  skillCatalog: publicQuery.input(bridgeInput).query(async ({ input }) => {
    requireInternalToken(input.token);
    const visible = await loadVisibleSkills(input.factoryId);
    return {
      skills: visible.map((s) => ({
        skillKey: s.skillKey,
        name: s.name,
        description: s.description.slice(0, 120),
      })),
    };
  }),

  /** skillExec：技能直达执行（同执行器同预算同记账）；产出物 24h 链接一并返回 */
  skillExec: publicQuery
    .input(
      bridgeInput.extend({
        skillKey: z.string().trim().min(1).max(64),
        task: z.string().trim().min(1).max(4000),
      }),
    )
    .mutation(async ({ input }) => {
      requireInternalToken(input.token);
      const r = await execSkillDirect({
        factoryId: input.factoryId,
        skillKey: input.skillKey,
        task: input.task,
        actor: `mcp:${input.factoryId}`,
      });
      if (!r.ok && r.reason === "not_visible") {
        throw new TRPCError({ code: "FORBIDDEN", message: r.brief });
      }
      if (!r.ok && r.reason === "budget") {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: r.brief });
      }
      return {
        ok: r.ok,
        brief: r.brief,
        ...(r.artifactUrl ? { artifactUrl: r.artifactUrl, artifactTitle: r.artifactTitle } : {}),
      };
    }),

  /** deptAsk（mutation）：P3 部门插件——向某部门主官问询/交办（走工作台智能体管线，同语音派单同管线） */
  deptAsk: publicQuery
    .input(
      bridgeInput.extend({
        deptCode: z.enum(["gm", "finance", "legal", "ops", "tech"]),
        question: z.string().trim().min(2).max(2000),
        /** M44：bridge（默认，快）/ dsh（DSH 底座深度执行：多步+沙箱+工具） */
        runtime: z.enum(["bridge", "dsh"]).optional().default("bridge"),
      }),
    )
    .mutation(async ({ input }) => {
      requireInternalToken(input.token);
      const roster = await listVoiceAgentRoster();
      const chief = DEPT_CHIEF[input.deptCode];
      const pick =
        roster.find((a) => a.code === chief) ?? roster.find((a) => a.deptCode === input.deptCode);
      if (!pick) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `部门 ${input.deptCode} 当前无在役智能体` });
      }
      const run = await runWorkbenchAgentTask({
        agentCode: pick.code,
        task: input.question,
        username: `mcp:${input.factoryId}`,
        runtime: input.runtime,
        factoryId: input.factoryId,
      });
      if (!run) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "该部门智能体当前未启用" });
      return {
        ok: true as const,
        dept: input.deptCode,
        agent: { code: run.agentCode, name: run.agentName, title: run.agentTitle },
        reply: run.reply,
        ...(run.artifacts.length > 0 ? { artifacts: run.artifacts } : {}),
      };
    }),

  /** adminDigest（query，平台域，无 factoryId）：P4 超终插件——值守实况只读摘要（全 DB 源，绝不碰别端文件系统） */
  adminDigest: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      requireInternalToken(input.token);
      const [dagRows, gateRows, evoRows, callRows, devRows] = await Promise.all([
        stQuery(sql`SELECT id, goal, status, runtime, createdAt FROM st_dag_runs ORDER BY id DESC LIMIT 5`).catch(() => []),
        stQuery(sql`SELECT COUNT(*) AS c FROM st_gate_tickets WHERE used_at IS NULL AND expires_at > NOW()`).catch(() => []),
        stQuery(sql`SELECT COUNT(*) AS c FROM st_evo_proposals WHERE status = 'pending'`).catch(() => []),
        stQuery(sql`SELECT COUNT(*) AS c FROM st_skill_calls WHERE created_at >= CURDATE()`).catch(() => []),
        stQuery(sql`SELECT COUNT(*) AS c FROM st_device_plugins WHERE status = 'active'`).catch(() => []),
      ]);
      return {
        dagRecent: (dagRows as Array<Record<string, unknown>>).map((r) => ({
          id: Number(r.id),
          goal: String(r.goal).slice(0, 60),
          status: String(r.status),
          runtime: String(r.runtime ?? "bridge"),
          createdAt: String(r.createdAt ?? ""),
        })),
        gateTicketsOpen: Number((gateRows[0] as { c?: number } | undefined)?.c ?? 0),
        evoProposalsPending: Number((evoRows[0] as { c?: number } | undefined)?.c ?? 0),
        skillCallsToday: Number((callRows[0] as { c?: number } | undefined)?.c ?? 0),
        devicePluginsActive: Number((devRows[0] as { c?: number } | undefined)?.c ?? 0),
        ts: new Date().toISOString(),
      };
    }),

  /** deviceRead（mutation）：M41c MCP 面读数回源——via_edge 设备经边缘队列（中枢唯一执行口径），云直连同上 */
  deviceRead: publicQuery
    .input(
      bridgeInput.extend({
        pluginId: z.number().int().positive(),
        metricKey: z.string().trim().min(1).max(32).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      requireInternalToken(input.token);
      const { execReadMetric, loadPlugin } = await import("./devicePlugins");
      const row = await loadPlugin(input.pluginId, input.factoryId);
      const values = await execReadMetric(row, input.metricKey);
      return { ok: true as const, name: String(row.name), values, ts: new Date().toISOString() };
    }),
});
