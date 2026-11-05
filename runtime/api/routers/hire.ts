import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import {
  agents,
  enterprises,
  agentHireRecords,
  reviews,
  tokenTransactions } from "@db/schema";
import { invalidate } from "./perfCache";
import { requireWbRole, sessionMe, resolveWbUserByToken} from "./wbSession";
import { rawRows } from "./terminal";
import { splitRate } from "./splitRules";
import { settleReferralBonus } from "./referral";
import { debitForPurchase, creditMaster, noteEnterpriseDebit, debitUser, getUserTokenBalance } from "./tokenLedger";
import { applyOccupationPack } from "./skillPacks";

/** @deprecated #19 起费率以 st_split_rules 表为准（splitRate('hire','platform')）；此常量仅为兼容旧引用保留 */
export const HIRE_COMMISSION_RATE = 0.15; // 平台抽佣 15%（历史默认，见 splitRules.ts）

/** M22 F1：C 级动作（签订雇佣合约）仅企业负责人（admin，owner→admin 归一） */
const HIRE_CREATE_DENIED = "仅老板可雇佣";
/** 跨企业一律 FORBIDDEN 通用文案，不泄露目标企业/记录存在性 */
const HIRE_ENTERPRISE_MISMATCH = "仅可操作本企业雇佣";
const HIRE_LIST_MISMATCH = "仅可查看本企业数字员工";

async function recomputeAgentRating(agentId: number, newRating: number) {
  // iter85：评分/下架风险写 agents，失效匠市缓存
  invalidate("agents:");
  const db = getDb();
  const [agent] = await db
    .select({
      avgRating: agents.avgRating,
      ratingCount: agents.ratingCount,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent) return;
  // 增量更新：在历史评分基数上并入新评价
  const avg =
    (agent.avgRating * agent.ratingCount + newRating) / (agent.ratingCount + 1);
  // 连续低分（最近 3 条评价均 < 3）→ 标记下架风险
  const recent = await db
    .select({ rating: reviews.rating })
    .from(reviews)
    .where(eq(reviews.agentId, agentId))
    .orderBy(desc(reviews.createdAt))
    .limit(3);
  const delistRisk = recent.length >= 3 && recent.every((r) => r.rating < 3);
  await db
    .update(agents)
    .set({
      avgRating: Math.round(avg * 100) / 100,
      ratingCount: agent.ratingCount + 1,
      delistRisk,
    })
    .where(eq(agents.id, agentId));
}

export const hireRouter = createRouter({
  /**
   * 签订智能合约雇佣：生成雇佣记录 + 首月佣金流水（平台 15%）。
   * M22 F1 鉴权收口：token 必传（请求体字段）；仅 admin（owner→admin 归一）可雇佣；
   * enterpriseId 必须等于 caller 企业，否则 FORBIDDEN（不泄露跨企业存在性）。
   */
  create: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        agentId: z.number().int().positive(),
        enterpriseId: z.number().int().positive(),
        periodMonths: z.number().int().min(1).max(36),
        monthlyPrice: z.number().int().min(0).optional(), // 缺省取 Agent 当前月薪
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      // 守卫先于一切业务查询：token 无效 UNAUTHORIZED；非 admin FORBIDDEN
      const { factory } = await requireWbRole(input.token, ["admin"], HIRE_CREATE_DENIED);
      if (input.enterpriseId !== factory.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: HIRE_ENTERPRISE_MISMATCH });
      }
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .limit(1);
      if (!agent) throw new Error(`Agent ${input.agentId} 不存在`);
      if (agent.status !== "active") throw new Error("该工匠当前不可雇佣");
      let [enterprise] = await db
        .select()
        .from(enterprises)
        .where(eq(enterprises.id, input.enterpriseId))
        .limit(1);
      if (!enterprise) {
        // M44 雇佣侧懒建账：enterprises（超市/账本域）与 wb_factories（工作台域）双表——
        // 注册只落 wb_factories，首次雇佣时若 enterprises 缺行则照 wb_factories 补齐
        // （同 id 同名字，tokenBalance 0 起；M34 扣账链路从 0 余额开始照常工作）。
        const fb = await db.execute(
          sql`SELECT id, enterpriseName, industry FROM wb_factories WHERE id = ${input.enterpriseId} LIMIT 1`,
        );
        const frow = (Array.isArray(fb) && Array.isArray(fb[0]) ? fb[0] : []) as Array<Record<string, unknown>>;
        if (frow.length === 0) throw new Error(`企业 ${input.enterpriseId} 不存在`);
        await db.execute(
          sql`INSERT INTO enterprises (id, name, industry, tokenBalance)
              VALUES (${input.enterpriseId}, ${String(frow[0]!.enterpriseName)}, ${String(frow[0]!.industry ?? "通用")}, 0)
              ON DUPLICATE KEY UPDATE name = VALUES(name)`,
        );
        [enterprise] = await db
          .select()
          .from(enterprises)
          .where(eq(enterprises.id, input.enterpriseId))
          .limit(1);
      }
      if (!enterprise) throw new Error(`企业 ${input.enterpriseId} 不存在`);

      const monthlyPrice = input.monthlyPrice ?? agent.monthlyPrice;

      // M45 支付闭环：先原子扣企业钱包（余额不足人话拒），再建单；
      // 建单后供给侧大师钱包真实入账 85%（平台 15% 为差额沉淀）。
      // 任一中段失败 → 企业钱包回补（绝不钱货两空）。
      const { balanceAfter } = await debitForPurchase({
        factoryId: input.enterpriseId,
        amount: monthlyPrice,
        packKey: `hire:${input.agentId}`,
      });

      const startedAt = new Date();
      const endsAt = new Date(startedAt);
      endsAt.setMonth(endsAt.getMonth() + input.periodMonths);

      let hireId: number;
      try {
        const [ins] = await db
          .insert(agentHireRecords)
          .values({
            agentId: input.agentId,
            enterpriseId: input.enterpriseId,
            periodMonths: input.periodMonths,
            monthlyPrice,
            status: "active",
            startedAt,
            endsAt,
          })
          .$returningId();
        hireId = ins.id;
        // M54：租用即带基础技能包——按岗位实时配装（失败不阻断雇佣主链）
        void applyOccupationPack(String(agent.code ?? "")).catch(() => {});
      } catch (e) {
        // 建单失败 → 回补企业钱包（原子增量）
        await db.execute(
          sql`UPDATE enterprises SET tokenBalance = tokenBalance + ${monthlyPrice} WHERE id = ${input.enterpriseId}`,
        );
        throw e;
      }

      await noteEnterpriseDebit({
        factoryId: input.enterpriseId,
        amount: monthlyPrice,
        balanceAfter,
        bizType: "hire_debit",
        refId: `hire:${hireId}`,
        note: `雇佣 ${agent.name} 首月`,
      });

      // 首月佣金流水：平台/供给侧按 st_split_rules 表驱动（默认 15%/85%）
      const platformBp = await splitRate("hire", "platform");
      const platformFee = Math.round((monthlyPrice * platformBp) / 10000);
      const masterShare = monthlyPrice - platformFee;
      const [{ id: txId }] = await db
        .insert(tokenTransactions)
        .values({
          type: "hire_commission",
          amount: monthlyPrice,
          platformFee,
          masterShare,
          agentId: input.agentId,
          enterpriseId: input.enterpriseId,
          hireRecordId: hireId,
          note: `智能合约首月佣金 · 周期 ${input.periodMonths} 个月`,
        })
        .$returningId();

      // M45：供给侧真实入账（大师 85% 到 masters.tokenBalance + 流水台账）
      await creditMaster({
        masterId: Number(agent.masterId),
        amount: masterShare,
        bizType: "hire_credit",
        refId: `hire:${hireId}`,
        note: `${agent.name} 首月分账（平台已扣 ${platformFee}）`,
      });

      // #19 推荐返佣（fire-and-forget）：该企业的首笔雇佣单 → 推荐人计提 5%（从平台抽成出）
      void settleReferralBonus({
        factoryId: input.enterpriseId,
        orderRef: `hire:${hireId}`,
        amount: monthlyPrice,
      }).catch(() => {});

      await db
        .update(agents)
        .set({ weeklyHires: sql`${agents.weeklyHires} + 1` })
        .where(eq(agents.id, input.agentId));

      // iter85：雇佣写入影响榜单/详情，失效 agents 缓存
      invalidate("agents:");

      const [record] = await db
        .select()
        .from(agentHireRecords)
        .where(eq(agentHireRecords.id, hireId))
        .limit(1);
      const [tx] = await db
        .select()
        .from(tokenTransactions)
        .where(eq(tokenTransactions.id, txId))
        .limit(1);
      return { record, transaction: tx };
    }),

  /**
   * 我的数字员工（按企业）。
   * M22 F1 鉴权收口：token 必传；admin/manager/staff 均可看本企业（不挑角色）；
   * enterpriseId 必须等于 caller 企业，否则 FORBIDDEN（不泄露跨企业存在性）。
   */
  list: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        enterpriseId: z.number().int().positive(),
        status: z
          .enum(["trial", "active", "expired", "cancelled"])
          .optional(),
      }),
    )
    .query(async ({ input }) => {
      const db = getDb();
      const { factory } = await sessionMe(input.token);
      if (input.enterpriseId !== factory.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: HIRE_LIST_MISMATCH });
      }
      const conds = [eq(agentHireRecords.enterpriseId, input.enterpriseId)];
      if (input.status) conds.push(eq(agentHireRecords.status, input.status));
      const rows = await db
        .select({ hire: agentHireRecords, agent: agents })
        .from(agentHireRecords)
        .leftJoin(agents, eq(agentHireRecords.agentId, agents.id))
        .where(and(...conds))
        .orderBy(desc(agentHireRecords.createdAt));
      return rows.map((r) => ({ ...r.hire, agent: r.agent }));
    }),

  /** 解约（验收战役 P1 修复：补鉴权——原无 token 校验，匿名可解约任意企业雇佣单；与 create 同闸 admin，且仅限本厂单） */
  cancel: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        hireRecordId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { factory } = await requireWbRole(input.token, ["admin"], HIRE_CREATE_DENIED);
      const [record] = await db
        .select()
        .from(agentHireRecords)
        .where(eq(agentHireRecords.id, input.hireRecordId))
        .limit(1);
      if (!record) throw new Error("雇佣记录不存在");
      if (Number(record.enterpriseId) !== factory.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: HIRE_ENTERPRISE_MISMATCH });
      }
      if (record.status !== "active" && record.status !== "trial") {
        throw new Error(`当前状态（${record.status}）不可解约`);
      }
      await db
        .update(agentHireRecords)
        .set({ status: "cancelled", endsAt: new Date() })
        .where(eq(agentHireRecords.id, input.hireRecordId));
      return { ok: true, status: "cancelled" as const };
    }),

  /** 提交评价 → 更新 Agent avg_rating / 下架风险（验收战役 P1 修复：补鉴权——原无 token 校验，匿名可刷任意 Agent 评分；须本厂成员） */
  review: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        hireRecordId: z.number().int().positive(),
        rating: z.number().int().min(1).max(5),
        content: z.string().trim().min(1).max(500),
        employerTitle: z.string().trim().max(64).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { factory } = await sessionMe(input.token);
      const [record] = await db
        .select()
        .from(agentHireRecords)
        .where(eq(agentHireRecords.id, input.hireRecordId))
        .limit(1);
      if (!record) throw new Error("雇佣记录不存在");
      if (Number(record.enterpriseId) !== factory.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: HIRE_ENTERPRISE_MISMATCH });
      }

      const hireMonths = Math.max(
        1,
        Math.round(
          (Date.now() - record.startedAt.getTime()) / (30 * 86400_000),
        ),
      );
      const [{ id: reviewId }] = await db
        .insert(reviews)
        .values({
          agentId: record.agentId,
          enterpriseId: record.enterpriseId,
          hireRecordId: record.id,
          rating: input.rating,
          content: input.content,
          employerTitle: input.employerTitle,
          hireMonths,
        })
        .$returningId();
      await db
        .update(agentHireRecords)
        .set({ rating: input.rating, review: input.content })
        .where(eq(agentHireRecords.id, record.id));
      await recomputeAgentRating(record.agentId, input.rating);

      const [review] = await db
        .select()
        .from(reviews)
        .where(eq(reviews.id, reviewId))
        .limit(1);
      const [agent] = await db
        .select({
          avgRating: agents.avgRating,
          ratingCount: agents.ratingCount,
          delistRisk: agents.delistRisk,
        })
        .from(agents)
        .where(eq(agents.id, record.agentId))
        .limit(1);
      return { review, agent };
    }),

  /**
   * personalCreate（mutation）：个人版雇佣——个人词元钱包支付，数字员工销售团队人人可雇。
   * 个人影子企业懒建账（id 高位带 9e9+userId，与 factory 同 id 段零碰撞）；
   * 支付走个人词元钱包（wb_users.tokenBalance，原子防透支），供给侧大师 85% 分账照旧；
   * 落单即配装岗位基础技能包。余额不足人话拒，失败回补绝不钱货两空。
   */
  personalCreate: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        agentId: z.number().int().positive(),
        periodMonths: z.number().int().min(1).max(36),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const user = await resolveWbUserByToken(db, input.token); // portal#86 必修：明文直读→双轨单点（指纹迁移行可读面封死）
      if (!user) throw new TRPCError({ code: "UNAUTHORIZED", message: "token 无效或已过期" });

      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .limit(1);
      if (!agent) throw new Error(`Agent ${input.agentId} 不存在`);
      if (agent.status !== "active") throw new Error("该数字员工当前不可雇佣");

      // 个人影子企业（账本域承载点；高位带避免与 factory 同 id 段碰撞）
      const shadowId = 9_000_000_000 + user.id;
      const shadowName = `个人空间·${String(user.displayName ?? user.username).slice(0, 24)}`;
      await db.execute(
        sql`INSERT INTO enterprises (id, name, industry, tokenBalance)
            VALUES (${shadowId}, ${shadowName}, '个人', 0)
            ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      );

      const monthlyPrice = agent.monthlyPrice;
      const bal = await getUserTokenBalance(user.id);
      if (bal < monthlyPrice) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `词元不足：该数字员工月薪 ${monthlyPrice} 词元，你的钱包现有 ${bal}。请先充值词元。`,
        });
      }
      const pay = await debitUser({
        userId: user.id,
        amount: monthlyPrice,
        bizType: "personal_hire",
        refId: `agent:${input.agentId}`,
        note: `个人雇佣 ${agent.name} 首月`,
      });
      if (!pay.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "扣减词元失败（余额变动），请重试" });
      }

      const startedAt = new Date();
      const endsAt = new Date(startedAt);
      endsAt.setMonth(endsAt.getMonth() + input.periodMonths);
      let hireId = 0;
      try {
        const [ins] = await db
          .insert(agentHireRecords)
          .values({
            agentId: input.agentId,
            enterpriseId: shadowId,
            periodMonths: input.periodMonths,
            monthlyPrice,
            status: "active",
            startedAt,
            endsAt,
          })
          .$returningId();
        hireId = ins.id;
      } catch (e) {
        // 建单失败 → 个人钱包回补（绝不钱货两空）
        await db.execute(
          sql`UPDATE wb_users SET tokenBalance = tokenBalance + ${monthlyPrice} WHERE id = ${user.id}`,
        );
        throw e;
      }

      // 供给侧大师 85% 分账（与企业雇佣同管线）
      if (agent.masterId) {
        await creditMaster({
          masterId: agent.masterId,
          amount: Math.floor(monthlyPrice * 0.85),
          bizType: "hire_income",
          refId: `hire:${hireId}`,
          note: `${agent.name} 被个人雇佣（${input.periodMonths} 个月）`,
        });
      }
      // M54：落单即配装岗位基础技能包
      void applyOccupationPack(String(agent.code ?? "")).catch(() => {});

      invalidate("market");
      return {
        ok: true as const,
        hireId,
        shadowEnterpriseId: shadowId,
        monthlyPrice,
        tokenBalanceAfter: pay.balanceAfter,
      };
    }),

  /** myPersonalHires（query）：我的个人雇佣清单（影子企业域） */
  myPersonalHires: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const db = getDb();
      const user = await resolveWbUserByToken(db, input.token); // portal#86 必修：明文直读→双轨单点（指纹迁移行可读面封死）
      if (!user) throw new TRPCError({ code: "UNAUTHORIZED", message: "token 无效或已过期" });
      const shadowId = 9_000_000_000 + user.id;
      const rows = rawRows(
        await db.execute(
          sql`SELECT h.id, h.agentId, h.monthlyPrice, h.status, h.startedAt, h.endsAt,
                     a.name AS agentName, a.code AS agentCode
              FROM agent_hire_records h JOIN agents a ON a.id = h.agentId
              WHERE h.enterpriseId = ${shadowId} ORDER BY h.id DESC LIMIT 50`,
        ).catch(() => [[]]),
      );
      return { items: rows };
    }),
});
