/**
 * showroomPortal —— 展厅发布接口（工作台服务端，与文档对齐）。
 *
 * 状态机：learning → pending_confirm → published / rejected（两段式，不承诺即时生效）。
 * - status：{ factoryId, enterpriseName, publication, learning, ready }（learning 含 score/metrics）
 * - requestPublication：达标 → pending_confirm；未达标正常返回
 *   { ok:false, status:"learning", score, metrics, missing, thresholds, message }（非异常）
 * - confirmPublication：仅 pending_confirm 可调用，真实生成 wb_showroom_products
 *   （从本企业 listed listings 拷贝），输出 { ok:true, status:"published", productCount }
 * - rejectPublication：仅 pending_confirm 可调用 → rejected
 */
import { z } from "zod";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import {
  tokenTransactions,
  wbFactories,
  wbListings,
  wbShowroom,
  wbShowroomProducts,
  wbUsers,
} from "@db/schema";
import {
  WB_THRESHOLDS,
  scoreLearning,
  sessionMe,
  type WbLearningMetrics,
} from "./wbSession";

const tokenInput = z.object({ token: z.string().trim().min(1) });

/** 计算企业学习指标（确定性）：成员数 / 部门数 / listed 上架数 */
async function computeMetrics(factoryId: number, deptCount: number) {
  const db = getDb();
  const [members] = await db
    .select({ c: count() })
    .from(wbUsers)
    .where(eq(wbUsers.factoryId, factoryId));
  const [listed] = await db
    .select({ c: count() })
    .from(wbListings)
    .where(and(eq(wbListings.factoryId, factoryId), eq(wbListings.status, "listed")));
  const metrics: WbLearningMetrics = {
    memberCount: members.c,
    departmentCount: deptCount,
    listedCount: listed.c,
  };
  return { metrics, ...scoreLearning(metrics) };
}

/** 确保 wb_showroom 行存在（默认 learning），并回写最新 score/metrics/thresholds */
async function ensureShowroom(
  factoryId: number,
  score: number,
  metrics: WbLearningMetrics,
) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(wbShowroom)
    .where(eq(wbShowroom.factoryId, factoryId))
    .limit(1);
  if (!row) {
    await db.insert(wbShowroom).values({
      factoryId,
      status: "learning",
      score,
      metrics,
      thresholds: { ...WB_THRESHOLDS },
    });
    const [created] = await db
      .select()
      .from(wbShowroom)
      .where(eq(wbShowroom.factoryId, factoryId))
      .limit(1);
    return created;
  }
  await db
    .update(wbShowroom)
    .set({ score, metrics, thresholds: { ...WB_THRESHOLDS } })
    .where(eq(wbShowroom.factoryId, factoryId));
  return { ...row, score, metrics, thresholds: { ...WB_THRESHOLDS } };
}

export const showroomPortalRouter = createRouter({
  /**
   * status（query，需要 token）：
   * 输出 { factoryId, enterpriseName, publication, learning, ready }
   */
  status: publicQuery.input(tokenInput).query(async ({ input }) => {
    const { factory } = await sessionMe(input.token);
    const { metrics, score, ready, missing } = await computeMetrics(
      factory.id,
      factory.departments.length,
    );
    const showroom = await ensureShowroom(factory.id, score, metrics);
    return {
      factoryId: factory.id,
      enterpriseName: factory.enterpriseName,
      publication: {
        status: showroom.status,
        score: showroom.score,
        requestedAt: showroom.requestedAt,
        decidedAt: showroom.decidedAt,
        productCount: showroom.productCount,
      },
      learning: {
        score,
        metrics,
        thresholds: { ...WB_THRESHOLDS },
        missing,
      },
      ready,
    };
  }),

  /**
   * requestPublication（mutation，需要 token）。
   * 达标 → pending_confirm；未达标 → { ok:false, status:"learning", score, metrics,
   * missing, thresholds, message }（正常返回，非异常）。
   */
  requestPublication: publicQuery.input(tokenInput).mutation(async ({ input }) => {
    const { factory } = await sessionMe(input.token);
    const { metrics, score, ready, missing } = await computeMetrics(
      factory.id,
      factory.departments.length,
    );
    const showroom = await ensureShowroom(factory.id, score, metrics);
    const thresholds = { ...WB_THRESHOLDS };

    if (showroom.status === "pending_confirm") {
      return {
        ok: true as const,
        status: "pending_confirm" as const,
        score,
        metrics,
        thresholds,
        message: "已申请发布，等待人工确认",
      };
    }
    if (showroom.status === "published") {
      return {
        ok: true as const,
        status: "published" as const,
        score,
        metrics,
        thresholds,
        message: "展厅已发布",
      };
    }
    if (!ready) {
      return {
        ok: false as const,
        status: "learning" as const,
        score,
        metrics,
        missing,
        thresholds,
        message: `组织学习未达标（score ${score} / 阈值 ${thresholds.readyScore}），请补齐后再申请`,
      };
    }
    const db = getDb();
    await db
      .update(wbShowroom)
      .set({ status: "pending_confirm", requestedAt: new Date() })
      .where(eq(wbShowroom.factoryId, factory.id));
    return {
      ok: true as const,
      status: "pending_confirm" as const,
      score,
      metrics,
      thresholds,
      message: "已达标，申请发布成功，等待人工确认",
    };
  }),

  /**
   * confirmPublication（mutation，需要 token）。
   * 仅 pending_confirm 可调用；真实生成展厅商品（从 listed listings 拷贝）。
   * 输出 { ok:true, status:"published", productCount }
   */
  confirmPublication: publicQuery.input(tokenInput).mutation(async ({ input }) => {
    const db = getDb();
    const { factory } = await sessionMe(input.token);
    const [showroom] = await db
      .select()
      .from(wbShowroom)
      .where(eq(wbShowroom.factoryId, factory.id))
      .limit(1);
    if (!showroom || showroom.status !== "pending_confirm") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "仅 pending_confirm 状态可确认发布",
      });
    }
    const listed = await db
      .select()
      .from(wbListings)
      .where(and(eq(wbListings.factoryId, factory.id), eq(wbListings.status, "listed")));
    const now = new Date();
    await db.transaction(async (tx) => {
      // 重新生成：清空旧商品后从 listed listings 真实拷贝
      await tx
        .delete(wbShowroomProducts)
        .where(eq(wbShowroomProducts.factoryId, factory.id));
      for (const l of listed) {
        await tx.insert(wbShowroomProducts).values({
          factoryId: factory.id,
          title: l.title,
          category: l.category ?? (l.type === "agent" ? "智能体" : "技能"),
          price: l.price,
        });
      }
      await tx
        .update(wbShowroom)
        .set({ status: "published", decidedAt: now, productCount: listed.length })
        .where(eq(wbShowroom.factoryId, factory.id));
    });
    return {
      ok: true as const,
      status: "published" as const,
      productCount: listed.length,
    };
  }),

  /**
   * rejectPublication（mutation，需要 token）。
   * 仅 pending_confirm 可调用 → rejected。
   */
  rejectPublication: publicQuery.input(tokenInput).mutation(async ({ input }) => {
    const db = getDb();
    const { factory } = await sessionMe(input.token);
    const [showroom] = await db
      .select()
      .from(wbShowroom)
      .where(eq(wbShowroom.factoryId, factory.id))
      .limit(1);
    if (!showroom || showroom.status !== "pending_confirm") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "仅 pending_confirm 状态可拒绝发布",
      });
    }
    await db
      .update(wbShowroom)
      .set({ status: "rejected", decidedAt: new Date() })
      .where(eq(wbShowroom.factoryId, factory.id));
    return { ok: true as const, status: "rejected" as const };
  }),

  /**
   * metrics（query，公开展厅实时指标，无需 token）—— 输入 { factoryId }。
   * 全部确定性派生：capacity/yieldRate/availability 由企业真实学习指标（成员/部门/
   * listed 上架数）按固定公式计算；gatewayHeartbeat 由 factoryId + 当前分钟确定性派生；
   * tokenRevenue 优先聚合主匠市 token_transactions 流水（enterpriseId 对齐 factoryId，
   * 未命中则确定性测算），并注明口径来源。endorsedBy 固定 "决策基因链"。
   */
  metrics: publicQuery
    .input(z.object({ factoryId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [factory] = await db
        .select()
        .from(wbFactories)
        .where(eq(wbFactories.id, input.factoryId))
        .limit(1);
      if (!factory) {
        throw new TRPCError({ code: "NOT_FOUND", message: "企业不存在" });
      }
      const { metrics, score, ready } = await computeMetrics(
        factory.id,
        factory.departments.length,
      );

      // 产能指数 / 良率 / 可接单状态（确定性公式，同输入同输出）
      const capacity = Math.min(
        100,
        52 +
          metrics.departmentCount * 6 +
          metrics.memberCount * 4 +
          metrics.listedCount * 8,
      );
      const yieldRate =
        Math.round(
          (93 + ((factory.id * 7) % 5) + Math.min(metrics.listedCount, 3) * 0.4) * 10,
        ) / 10;
      const availability = ready ? "可接单" : "预约排产";

      // 网关心跳：分钟对齐后按 factoryId 确定性回拨（同分钟内稳定）
      const gatewayHeartbeat = new Date(
        Math.floor(Date.now() / 60000) * 60000 - (factory.id % 45) * 1000,
      );

      // Token 收益：优先聚合主匠市 token 流水（enterpriseId 对齐 factoryId）
      const sinceLastMonth = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const [agg] = await db
        .select({
          total: sql<number>`COALESCE(SUM(${tokenTransactions.amount}), 0)`,
          txCount: count(),
        })
        .from(tokenTransactions)
        .where(eq(tokenTransactions.enterpriseId, factory.id));
      const [aggMonth] = await db
        .select({
          amount: sql<number>`COALESCE(SUM(${tokenTransactions.amount}), 0)`,
          unsettled: sql<number>`COALESCE(SUM(${tokenTransactions.masterShare}), 0)`,
        })
        .from(tokenTransactions)
        .where(
          and(
            eq(tokenTransactions.enterpriseId, factory.id),
            gte(tokenTransactions.createdAt, sinceLastMonth),
          ),
        );
      let tokenRevenue: {
        total: number;
        lastMonth: number;
        unsettled: number;
        source: string;
        note: string;
      };
      if (agg.txCount > 0) {
        tokenRevenue = {
          total: Number(agg.total),
          lastMonth: Number(aggMonth.amount),
          unsettled: Number(aggMonth.unsettled),
          source: "token_transactions",
          note: "聚合主匠市 token 流水（enterpriseId 对齐 factoryId）；unsettled=近 30 天老师傅分成待结算。",
        };
      } else {
        // 确定性测算（无关联流水时）：同 factory 同学习指标结果稳定
        const total =
          ((factory.id * 137) % 5000) + metrics.listedCount * 12800 + score * 36;
        const lastMonth = Math.round(total * 0.22);
        tokenRevenue = {
          total,
          lastMonth,
          unsettled: Math.round(lastMonth * 0.85),
          source: "deterministic",
          note: "未关联到 token 流水，按企业画像确定性测算，仅作展厅展示参考。",
        };
      }

      return {
        factoryId: factory.id,
        enterpriseName: factory.enterpriseName,
        capacity,
        yieldRate,
        availability,
        gatewayHeartbeat,
        endorsedBy: "决策基因链" as const,
        tokenRevenue,
      };
    }),
});
