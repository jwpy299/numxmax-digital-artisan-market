/**
 * Nebula Harness · 路由面（M65）—— 双运行时组织版的治理端点。
 *
 * - nebulaHarness.status   requireAdmin：三运行时健康（interactive/heavy/construction）+ 宪章指纹
 * - nebulaHarness.execute  requireAdmin：任务分级路由（interactive 默认；heavy 下行 factoryId；
 *                          construction 恒止步行提案闸——代码变更只走 evoArm + C 级双签）
 *
 * 红线：本路由是治理面（超终/Ops），不面向 C 端 APP；token 仅在请求体；
 * execute 交互级不落 st_llm_events 之外的任何业务表（纯转发 modelGateway 链）。
 */
import { timingSafeEqual } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createRouter, publicQuery } from "../middleware";
import { requireAdmin } from "../routers/terminal";
import { dispatchSignals } from "./dispatch";
import { recordProbeReport, runConveyor } from "./conveyor";
import { conveyorExecuteEnabled, executeConveyorActions } from "./executor";
import { computeLoopRing, DOMAIN_POLICIES, SCOPE_CEILING } from "./loop";
import {
  nebulaHarnessEvolution,
  nebulaHarnessExecute,
  nebulaHarnessRoute,
  nebulaHarnessRuns,
  nebulaHarnessStatus,
} from "./orchestrator";

export const nebulaHarnessRouter = createRouter({
  /** 状态面：三运行时 + 双运行时注册表 + 宪章指纹（布尔级，无密钥值） */
  status: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      return nebulaHarnessStatus();
    }),

  /** 统一入口：任务分级路由（construction 无 releaseId 恒为 proposal-gate 指引；
   *  带 releaseId 走 Codex 运行时真施工，仍 fail-closed：EVO_ARM_ENABLED=1 + draft 提案） */
  execute: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        text: z.string().trim().min(1, "任务文本不能为空").max(8000),
        tier: z.enum(["interactive", "heavy", "construction"]).default("interactive"),
        factoryId: z.number().int().positive().optional(),
        withCharter: z.boolean().optional(),
        releaseId: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      return nebulaHarnessExecute({
        text: input.text,
        tier: input.tier,
        factoryId: input.factoryId,
        withCharter: input.withCharter,
        releaseId: input.releaseId,
      });
    }),

  /** M69：auto 路由建议（纯函数口径，四端共用；不执行任务） */
  route: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      text: z.string().trim().min(1).max(8000),
    }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      return nebulaHarnessRoute(input.text);
    }),

  /** M69：运行台账（st_harness_runs 新→旧，元数据级） */
  runs: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      limit: z.number().int().min(1).max(100).default(20),
    }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      return nebulaHarnessRuns(input.limit);
    }),

  /** M69：自进化回路状态面（信号→提案→draft→施工四段灯） */
  evolution: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      return nebulaHarnessEvolution();
    }),

  /** M71：事件驱动调度环点火（信号聚集 → 自动立项 pending 咨询型提案；拍板权永在人手）。
   *  鉴权双腿：管理员 token（人工触发）或 HARNESS_DISPATCH_TOKEN 内部令牌
   *  （定时点火器 server-to-server 专用，不撒管理员凭据；恒定时间比较防时序侧信道）。 */
  dispatch: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .mutation(async ({ input }) => {
      const internal = process.env.HARNESS_DISPATCH_TOKEN?.trim() ?? "";
      const a = Buffer.from(input.token);
      const b = Buffer.from(internal);
      const okInternal = internal.length > 0 && a.length === b.length && timingSafeEqual(a, b);
      if (!okInternal) {
        await requireAdmin(input.token);
      }
      return dispatchSignals();
    }),

  /** M73：自进化闭环七段状态面（sense→propose→decide→construct→verify→release→observe）
   *  + 域/尺度自治天花板回显（超终 UI 渲染用；布尔/计数级，无密钥无正文） */
  loop: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const ring = await computeLoopRing();
      return {
        ring,
        policies: { domains: DOMAIN_POLICIES, scopeCeiling: SCOPE_CEILING },
      };
    }),

  /** M75：闭环输送带动作清单（四类候选装配 → advanceLoop 判定）。
   *  消费方：S3 nebula-conveyor 执行器（内部令牌）+ 超终 what-if 预览（管理员）。
   *  环身份显式传入（默认 enterprise×factory 本厂环）；本端点只读库返回动作，绝不执行。 */
  conveyor: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      domain: z.enum(["enterprise", "gov", "research", "education", "finance"]).default("enterprise"),
      scope: z.enum(["dept", "factory", "platform"]).default("factory"),
      evoOptOut: z.boolean().default(false),
      deptKey: z.string().trim().min(1).max(32).optional(), // M80 小环键
    }))
    .query(async ({ input }) => {
      const internal = process.env.HARNESS_DISPATCH_TOKEN?.trim() ?? "";
      const a = Buffer.from(input.token);
      const b = Buffer.from(internal);
      const okInternal = internal.length > 0 && a.length === b.length && timingSafeEqual(a, b);
      if (!okInternal) {
        await requireAdmin(input.token);
      }
      const result = await runConveyor({ domain: input.domain, scope: input.scope, evoOptOut: input.evoOptOut, deptKey: input.deptKey ?? null });
      // M78b 真执行（彭总双签开闸）：内部令牌 + EVO_CONVEYOR_EXECUTE=1 双闸；
      // 缺省 REPORT-ONLY（缺 env 或管理员预览一律不动地面，行为零变化）
      if (okInternal && conveyorExecuteEnabled() && result.ok) {
        const executed = await executeConveyorActions(result.actions);
        return { ...result, executed };
      }
      return result;
    }),

  /** M76：探针回写（observe 段数据源）。仅内部令牌——探针脚本专用，管理员无此业务；
   *  挂该通道最新 published 发布落 st_release_audit（probe:ok/probe:fail）。 */
  probeReport: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      channel: z.enum(["app_apk", "wb", "admin", "portal", "server"]),
      target: z.string().trim().min(1).max(64),
      ok: z.boolean(),
      detail: z.string().trim().max(300).optional(),
    }))
    .mutation(async ({ input }) => {
      const internal = process.env.HARNESS_DISPATCH_TOKEN?.trim() ?? "";
      const a = Buffer.from(input.token);
      const b = Buffer.from(internal);
      const okInternal = internal.length > 0 && a.length === b.length && timingSafeEqual(a, b);
      if (!okInternal) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "探针回写仅限内部令牌" });
      }
      return recordProbeReport({
        channel: input.channel, target: input.target, ok: input.ok, detail: input.detail,
      });
    }),
});
