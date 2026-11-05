import { z } from "zod";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import {
  agents,
  recruitments,
  recruitmentApplications,
  agentHireRecords,
  tokenTransactions,
} from "@db/schema";
import { splitRate } from "./splitRules";

export const applicationsRouter = createRouter({
  /** 提交应征（需登录）：校验招募单 open + Agent 存在，创建 pending 应征。
   *  注：规范命名为 apply，但 tRPC v11 将 'apply' 列为保留键
   *  （与 Function.prototype.apply 冲突，客户端代理无法寻址），故命名为 submit。 */
  submit: authedQuery
    .input(
      z.object({
        recruitmentId: z.number().int().positive(),
        agentId: z.number().int().positive(),
        message: z.string().trim().min(2).max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [recruitment] = await db
        .select()
        .from(recruitments)
        .where(eq(recruitments.id, input.recruitmentId))
        .limit(1);
      if (!recruitment) {
        throw new TRPCError({ code: "NOT_FOUND", message: "招募单不存在" });
      }
      if (recruitment.status !== "open") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "该招募单已不在招募中，无法应征",
        });
      }
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .limit(1);
      if (!agent) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Agent 不存在" });
      }
      const [dup] = await db
        .select({ id: recruitmentApplications.id })
        .from(recruitmentApplications)
        .where(
          and(
            eq(recruitmentApplications.recruitmentId, input.recruitmentId),
            eq(recruitmentApplications.agentId, input.agentId),
            eq(recruitmentApplications.status, "pending"),
          ),
        )
        .limit(1);
      if (dup) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "该 Agent 已应征过此招募单，正在等待企业确认",
        });
      }
      const [{ id }] = await db
        .insert(recruitmentApplications)
        .values({
          recruitmentId: input.recruitmentId,
          agentId: input.agentId,
          applicantUserId: ctx.user.id,
          message: input.message,
          status: "pending",
        })
        .$returningId();
      const [application] = await db
        .select()
        .from(recruitmentApplications)
        .where(eq(recruitmentApplications.id, id))
        .limit(1);
      return application;
    }),

  /** 某招募单的应征列表（需登录，含 Agent 名称/评分/月薪） */
  listForRecruitment: authedQuery
    .input(z.object({ recruitmentId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db
        .select({
          application: recruitmentApplications,
          agentName: agents.name,
          agentCode: agents.code,
          agentAvatar: agents.avatar,
          agentAvgRating: agents.avgRating,
          agentMonthlyPrice: agents.monthlyPrice,
          agentStatus: agents.status,
        })
        .from(recruitmentApplications)
        .leftJoin(agents, eq(recruitmentApplications.agentId, agents.id))
        .where(eq(recruitmentApplications.recruitmentId, input.recruitmentId))
        .orderBy(desc(recruitmentApplications.createdAt));
      return rows.map((r) => ({
        ...r.application,
        agentName: r.agentName,
        agentCode: r.agentCode,
        agentAvatar: r.agentAvatar,
        agentAvgRating: r.agentAvgRating,
        agentMonthlyPrice: r.agentMonthlyPrice,
        agentStatus: r.agentStatus,
      }));
    }),

  /** 我提交的应征（需登录，含招募单与 Agent 摘要） */
  mine: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select({
        application: recruitmentApplications,
        agentName: agents.name,
        agentCode: agents.code,
        agentAvatar: agents.avatar,
        recruitmentTitle: recruitments.title,
        recruitmentStatus: recruitments.status,
        budgetMonthly: recruitments.budgetMonthly,
        periodMonths: recruitments.periodMonths,
      })
      .from(recruitmentApplications)
      .leftJoin(agents, eq(recruitmentApplications.agentId, agents.id))
      .leftJoin(
        recruitments,
        eq(recruitmentApplications.recruitmentId, recruitments.id),
      )
      .where(eq(recruitmentApplications.applicantUserId, ctx.user.id))
      .orderBy(desc(recruitmentApplications.createdAt));
    return rows.map((r) => ({
      ...r.application,
      agentName: r.agentName,
      agentCode: r.agentCode,
      agentAvatar: r.agentAvatar,
      recruitmentTitle: r.recruitmentTitle,
      recruitmentStatus: r.recruitmentStatus,
      budgetMonthly: r.budgetMonthly,
      periodMonths: r.periodMonths,
    }));
  }),

  /** 企业决定应征（需登录，仅招募发布人）：
   *  accept → 事务：应征 accepted + 自动签约（agent_hire_records active）+
   *           首月 hire_commission 流水（平台 15% / 老师傅 85%）+
   *           招募单 filled + 同单其余 pending 应征 rejected
   *  reject → 仅该应征 rejected */
  decide: authedQuery
    .input(
      z.object({
        applicationId: z.number().int().positive(),
        action: z.enum(["accept", "reject"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [application] = await db
        .select()
        .from(recruitmentApplications)
        .where(eq(recruitmentApplications.id, input.applicationId))
        .limit(1);
      if (!application) {
        throw new TRPCError({ code: "NOT_FOUND", message: "应征不存在" });
      }
      const [recruitment] = await db
        .select()
        .from(recruitments)
        .where(eq(recruitments.id, application.recruitmentId))
        .limit(1);
      if (!recruitment) {
        throw new TRPCError({ code: "NOT_FOUND", message: "招募单不存在" });
      }
      if (recruitment.createdByUserId !== ctx.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "仅招募发布企业可处理应征",
        });
      }
      if (application.status !== "pending") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "该应征已被处理",
        });
      }
      const now = new Date();

      if (input.action === "reject") {
        await db
          .update(recruitmentApplications)
          .set({ status: "rejected", decidedAt: now })
          .where(eq(recruitmentApplications.id, application.id));
        return { ok: true, status: "rejected" as const };
      }

      // accept：事务式签约闭环
      if (recruitment.status !== "open") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "该招募单已不在招募中，无法接受应征",
        });
      }
      const monthlyPrice = recruitment.budgetMonthly;
      const periodMonths = recruitment.periodMonths;
      const endsAt = new Date(now);
      endsAt.setMonth(endsAt.getMonth() + periodMonths);

      const result = await db.transaction(async (tx) => {
        // 1. 应征 → accepted
        await tx
          .update(recruitmentApplications)
          .set({ status: "accepted", decidedAt: now })
          .where(eq(recruitmentApplications.id, application.id));

        // 2. 自动创建智能合约（按招募预算与周期，active）
        const [{ id: hireId }] = await tx
          .insert(agentHireRecords)
          .values({
            agentId: application.agentId,
            enterpriseId: recruitment.enterpriseId,
            periodMonths,
            monthlyPrice,
            status: "active",
            startedAt: now,
            endsAt,
          })
          .$returningId();

        // 3. 首月佣金流水：st_split_rules 表驱动（默认平台 15% / 老师傅 85%）
        const platformBp = await splitRate("hire", "platform");
        const platformFee = Math.round((monthlyPrice * platformBp) / 10000);
        const masterShare = monthlyPrice - platformFee;
        const [{ id: txId }] = await tx
          .insert(tokenTransactions)
          .values({
            type: "hire_commission",
            amount: monthlyPrice,
            platformFee,
            masterShare,
            agentId: application.agentId,
            enterpriseId: recruitment.enterpriseId,
            hireRecordId: hireId,
            note: `招募应征签约首月佣金 · 招募单 #${recruitment.id} · 周期 ${periodMonths} 个月`,
          })
          .$returningId();

        // 4. 招募单 → filled
        await tx
          .update(recruitments)
          .set({ status: "filled" })
          .where(eq(recruitments.id, recruitment.id));

        // 5. 同招募单其余 pending 应征 → rejected
        await tx
          .update(recruitmentApplications)
          .set({ status: "rejected", decidedAt: now })
          .where(
            and(
              eq(recruitmentApplications.recruitmentId, recruitment.id),
              eq(recruitmentApplications.status, "pending"),
              ne(recruitmentApplications.id, application.id),
            ),
          );

        // 6. Agent 本周雇佣 +1（与 hire.create 一致）
        await tx
          .update(agents)
          .set({ weeklyHires: sql`${agents.weeklyHires} + 1` })
          .where(eq(agents.id, application.agentId));

        const [record] = await tx
          .select()
          .from(agentHireRecords)
          .where(eq(agentHireRecords.id, hireId))
          .limit(1);
        const [transaction] = await tx
          .select()
          .from(tokenTransactions)
          .where(eq(tokenTransactions.id, txId))
          .limit(1);
        return { record, transaction };
      });

      return {
        ok: true,
        status: "accepted" as const,
        record: result.record,
        transaction: result.transaction,
      };
    }),
});
