import { z } from "zod";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { recruitments, enterprises } from "@db/schema";

async function withEnterprise(where?: SQL) {
  const db = getDb();
  const rows = await db
    .select({
      recruitment: recruitments,
      enterpriseName: enterprises.name,
      enterpriseIndustry: enterprises.industry,
    })
    .from(recruitments)
    .leftJoin(enterprises, eq(recruitments.enterpriseId, enterprises.id))
    .where(where)
    .orderBy(desc(recruitments.createdAt));
  return rows.map((r) => ({
    ...r.recruitment,
    enterpriseName: r.enterpriseName,
    enterpriseIndustry: r.enterpriseIndustry,
  }));
}

export const recruitmentsRouter = createRouter({
  /** 发布招募单（需登录，记录 createdByUserId；默认归属示范企业华辰精工） */
  create: authedQuery
    .input(
      z.object({
        title: z.string().trim().min(2).max(128),
        industry: z.string().trim().min(2).max(64),
        capabilityTags: z.array(z.string().trim().min(1).max(32)).min(1).max(8),
        description: z.string().trim().min(10).max(2000),
        budgetMonthly: z.number().int().min(100).max(1_000_000),
        periodMonths: z.number().int().min(1).max(36),
        urgent: z.boolean().default(false),
        enterpriseId: z.number().int().positive().default(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [enterprise] = await db
        .select()
        .from(enterprises)
        .where(eq(enterprises.id, input.enterpriseId))
        .limit(1);
      if (!enterprise) throw new TRPCError({ code: "BAD_REQUEST", message: "企业不存在" });
      const [{ id }] = await db
        .insert(recruitments)
        .values({
          enterpriseId: input.enterpriseId,
          createdByUserId: ctx.user.id,
          title: input.title,
          industry: input.industry,
          capabilityTags: input.capabilityTags,
          description: input.description,
          budgetMonthly: input.budgetMonthly,
          periodMonths: input.periodMonths,
          urgent: input.urgent,
          status: "open",
        })
        .$returningId();
      const [recruitment] = await db
        .select()
        .from(recruitments)
        .where(eq(recruitments.id, id))
        .limit(1);
      return recruitment;
    }),

  /** 招募大厅（公开，支持行业/状态筛选） */
  list: publicQuery
    .input(
      z
        .object({
          industry: z.string().trim().max(64).optional(),
          status: z.enum(["open", "filled", "closed"]).optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const conds = [];
      if (input?.industry) conds.push(eq(recruitments.industry, input.industry));
      if (input?.status) conds.push(eq(recruitments.status, input.status));
      return withEnterprise(conds.length ? and(...conds) : undefined);
    }),

  /** 我发布的招募单（需登录） */
  mine: authedQuery.query(async ({ ctx }) => {
    return withEnterprise(eq(recruitments.createdByUserId, ctx.user.id));
  }),

  /** 关闭招募单（需登录，仅发布人可操作；open/filled → closed） */
  close: authedQuery
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [rec] = await db
        .select()
        .from(recruitments)
        .where(eq(recruitments.id, input.id))
        .limit(1);
      if (!rec) throw new TRPCError({ code: "NOT_FOUND", message: "招募单不存在" });
      if (rec.createdByUserId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅发布人可关闭该招募单" });
      }
      if (rec.status === "closed") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "该招募单已关闭" });
      }
      await db
        .update(recruitments)
        .set({ status: "closed" })
        .where(eq(recruitments.id, input.id));
      return { ok: true, status: "closed" as const };
    }),
});
