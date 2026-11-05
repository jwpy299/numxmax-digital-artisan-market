/**
 * nebulaLink —— 匠市 ⇄ 工作台 两段式 SSO 桥接接口（工作台服务端，与文档对齐）。
 *
 * - createWorkbenchTicket：签发一次性 ticket（st_+48hex，明文仅本次返回，库只存 sha256，TTL 300s）；
 *   entryUrl 用 /wb/bridge 前缀（同部署承载工作台 SPA），形如 /wb/bridge?ticket=<urlencoded ticket>。
 * - consumeWorkbenchTicket：原子核销防重放；任何失败统一 BAD_REQUEST「ticket 无效或已过期」；
 *   成功后重颁 nt_ token 覆盖 wb_users.authToken（旧 token 失效）。
 * - bridgeStatus：桥接能力自检（无输入）。
 */
import { z } from "zod";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { wbTickets, wbUsers, wbFactories } from "@db/schema";
import {
  WB_DEFAULT_SOURCE,
  WB_TARGETS,
  WB_TICKET_TTL_SECONDS,
  newCredential,
  reissueToken,
  sessionMe,
  sha256,
} from "./wbSession";

const TICKET_INVALID_MESSAGE = "ticket 无效或已过期";

export const nebulaLinkRouter = createRouter({
  /**
   * createWorkbenchTicket（mutation，需要 token）。
   * 输入 { token, target?（白名单，默认 /dept）, source?（默认 craftsman-market） }
   * 输出 { ticket, entryUrl, target, expiresAt, factoryId, enterpriseName }
   */
  createWorkbenchTicket: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        target: z.enum(WB_TARGETS).optional(),
        source: z.string().trim().min(1).max(64).default(WB_DEFAULT_SOURCE),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { user, factory } = await sessionMe(input.token);
      const target = input.target ?? "/dept";
      const ticket = newCredential("st_");
      const expiresAt = new Date(Date.now() + WB_TICKET_TTL_SECONDS * 1000);
      // 库只存 sha256，明文仅本响应返回一次
      await db.insert(wbTickets).values({
        ticketHash: sha256(ticket),
        userId: user.id,
        factoryId: factory.id,
        target,
        source: input.source,
        expiresAt,
      });
      return {
        ticket,
        entryUrl: `/wb/bridge?ticket=${encodeURIComponent(ticket)}`,
        target,
        expiresAt,
        factoryId: factory.id,
        enterpriseName: factory.enterpriseName,
      };
    }),

  /**
   * consumeWorkbenchTicket（mutation，ticket 即凭据）。
   * 原子核销一次性 ticket（UPDATE ... WHERE consumedAt IS NULL AND expiresAt > NOW()），
   * 任何失败（不存在 / 已用 / 过期）统一返回「ticket 无效或已过期」。
   * 成功后重颁 nt_ token 并覆盖 wb_users.authToken。
   */
  consumeWorkbenchTicket: publicQuery
    .input(z.object({ ticket: z.string().trim().min(1) }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const ticketHash = sha256(input.ticket);
      // 原子核销：仅当未消费且未过期时置 consumedAt，防重放
      const [header] = (await db
        .update(wbTickets)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(wbTickets.ticketHash, ticketHash),
            isNull(wbTickets.consumedAt),
            gt(wbTickets.expiresAt, sql`CURRENT_TIMESTAMP`),
          ),
        )) as unknown as [{ affectedRows: number }];
      if (!header || header.affectedRows !== 1) {
        throw new TRPCError({ code: "BAD_REQUEST", message: TICKET_INVALID_MESSAGE });
      }
      const [ticketRow] = await db
        .select()
        .from(wbTickets)
        .where(eq(wbTickets.ticketHash, ticketHash))
        .limit(1);
      if (!ticketRow) {
        throw new TRPCError({ code: "BAD_REQUEST", message: TICKET_INVALID_MESSAGE });
      }
      const [user] = await db
        .select()
        .from(wbUsers)
        .where(eq(wbUsers.id, ticketRow.userId))
        .limit(1);
      if (!user) {
        throw new TRPCError({ code: "BAD_REQUEST", message: TICKET_INVALID_MESSAGE });
      }
      const [factory] = await db
        .select()
        .from(wbFactories)
        .where(eq(wbFactories.id, user.factoryId))
        .limit(1);
      if (!factory) {
        throw new TRPCError({ code: "BAD_REQUEST", message: TICKET_INVALID_MESSAGE });
      }
      // 重颁 nt_ token，覆盖 authToken（旧 token 立即失效，单点有效）
      const token = await reissueToken(user.id);
      return {
        token,
        username: user.username,
        displayName: user.displayName,
        enterpriseName: factory.enterpriseName,
        factoryId: factory.id,
        role: user.role,
        target: ticketRow.target,
        profileSummary: {
          industry: factory.industry,
          industryText: factory.industryText,
          headcount: factory.headcount,
          deptCount: factory.departments.length,
          departments: factory.departments,
          painPoints: factory.painPoints,
        },
      };
    }),

  /**
   * bridgeStatus（query，无输入）：桥接能力自检（文档表 5-4 当前核实值）。
   */
  bridgeStatus: publicQuery.query(() => ({
    source: WB_DEFAULT_SOURCE,
    supportedTargets: [...WB_TARGETS],
    ticketTtlSeconds: WB_TICKET_TTL_SECONDS,
    requiresLogin: true,
  })),
});
