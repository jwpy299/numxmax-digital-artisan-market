/**
 * workbenchMarket —— 工作台市场上架 / 招募接口（工作台服务端，与文档对齐）。
 *
 * - 上架密钥生命周期：issuePublishKey（pk_+48hex 明文一次性，库只存 sha256）/
 *   myPublishKeys（元数据，不含 hash/明文）/ revokePublishKey。
 * - 上架两段式：publishSkillFromWorkbench / publishAgentFromWorkbench 提交 pending
 *   → certifyAgent（仅 admin）审核为 listed / rejected，不承诺即时生效。
 * - 招募两段式：hireAgentWithContract 事务校验 listed、hires+1、创建 pending 合同
 *   → decideHireContract（仅 owner/admin）审批为 active / rejected。
 */
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { wbListings, wbPublishKeys, wbContracts } from "@db/schema";
import {
  newCredential,
  newGeneEventId,
  sessionMe,
  sha256,
} from "./wbSession";

const PUBLISH_KEY_INVALID = "publishKey 无效或已过期";
const DEFAULT_KEY_EXPIRES_DAYS = 30;

/** 校验上架密钥：sha256 匹配 + 同企业 + 未吊销 + 未过期 + assetType 覆盖 */
async function verifyPublishKey(
  publishKey: string,
  factoryId: number,
  required: "skill" | "agent",
) {
  const db = getDb();
  const [key] = await db
    .select()
    .from(wbPublishKeys)
    .where(
      and(
        eq(wbPublishKeys.keyHash, sha256(publishKey)),
        eq(wbPublishKeys.factoryId, factoryId),
      ),
    )
    .limit(1);
  if (
    !key ||
    key.revokedAt ||
    key.expiresAt.getTime() <= Date.now() ||
    (key.assetType !== "both" && key.assetType !== required)
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: PUBLISH_KEY_INVALID });
  }
  return key;
}

export const workbenchMarketRouter = createRouter({
  /**
   * issuePublishKey（mutation，需要 token）。
   * 输入 { token, assetType: "skill"|"agent"|"both", expiresDays? }
   * 输出 { publishKey, keyId, assetType, expiresAt }；明文只在本响应出现一次。
   */
  issuePublishKey: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        assetType: z.enum(["skill", "agent", "both"]),
        expiresDays: z.number().int().positive().max(365).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { factory } = await sessionMe(input.token);
      const publishKey = newCredential("pk_");
      const days = input.expiresDays ?? DEFAULT_KEY_EXPIRES_DAYS;
      const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000);
      const [{ id: keyId }] = await db
        .insert(wbPublishKeys)
        .values({
          keyHash: sha256(publishKey),
          factoryId: factory.id,
          assetType: input.assetType,
          expiresAt,
        })
        .$returningId();
      return { publishKey, keyId, assetType: input.assetType, expiresAt };
    }),

  /** myPublishKeys（query，需要 token）：本企业密钥元数据，不含 hash / 明文 */
  myPublishKeys: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const db = getDb();
      const { factory } = await sessionMe(input.token);
      const rows = await db
        .select({
          keyId: wbPublishKeys.id,
          assetType: wbPublishKeys.assetType,
          expiresAt: wbPublishKeys.expiresAt,
          revokedAt: wbPublishKeys.revokedAt,
          createdAt: wbPublishKeys.createdAt,
        })
        .from(wbPublishKeys)
        .where(eq(wbPublishKeys.factoryId, factory.id))
        .orderBy(desc(wbPublishKeys.id));
      return rows.map((r) => ({
        ...r,
        status: r.revokedAt
          ? ("revoked" as const)
          : r.expiresAt.getTime() <= Date.now()
            ? ("expired" as const)
            : ("active" as const),
      }));
    }),

  /** revokePublishKey（mutation，需要 token）：吊销指定上架密钥 */
  revokePublishKey: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        keyId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { factory } = await sessionMe(input.token);
      const [key] = await db
        .select()
        .from(wbPublishKeys)
        .where(
          and(
            eq(wbPublishKeys.id, input.keyId),
            eq(wbPublishKeys.factoryId, factory.id),
          ),
        )
        .limit(1);
      if (!key) {
        throw new TRPCError({ code: "NOT_FOUND", message: "密钥不存在" });
      }
      if (!key.revokedAt) {
        await db
          .update(wbPublishKeys)
          .set({ revokedAt: new Date() })
          .where(eq(wbPublishKeys.id, key.id));
      }
      return { ok: true as const, keyId: key.id, status: "revoked" as const };
    }),

  /**
   * publishSkillFromWorkbench（mutation，需要 token + publishKey）。
   * 输入 title / category / description / delivery / pricingModel / price / accuracy? / operator?
   * 输出 { listingId, status: "pending", geneEventId }
   */
  publishSkillFromWorkbench: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        publishKey: z.string().trim().min(1),
        title: z.string().trim().min(2).max(128),
        category: z.string().trim().min(1).max(64),
        description: z.string().trim().min(2).max(4000),
        delivery: z.string().trim().min(1).max(128),
        pricingModel: z.string().trim().min(1).max(64),
        price: z.number().int().nonnegative(),
        accuracy: z.number().min(0).max(100).optional(),
        operator: z.string().trim().max(64).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { factory } = await sessionMe(input.token);
      await verifyPublishKey(input.publishKey, factory.id, "skill");
      const [{ id: listingId }] = await db
        .insert(wbListings)
        .values({
          factoryId: factory.id,
          type: "skill",
          title: input.title,
          category: input.category,
          description: input.description,
          delivery: input.delivery,
          pricingModel: input.pricingModel,
          price: input.price,
          accuracy: input.accuracy ?? null,
          operator: input.operator ?? null,
          status: "pending",
        })
        .$returningId();
      return { listingId, status: "pending" as const, geneEventId: newGeneEventId() };
    }),

  /**
   * publishAgentFromWorkbench（mutation，需要 token + publishKey）。
   * 输入 title / capabilities / employmentType / pricingModel / price / description / operator?
   * 输出 { agentId, status: "pending", geneEventId }
   */
  publishAgentFromWorkbench: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        publishKey: z.string().trim().min(1),
        title: z.string().trim().min(2).max(128),
        capabilities: z.array(z.string().trim().min(1).max(64)).min(1).max(32),
        employmentType: z.string().trim().min(1).max(64),
        pricingModel: z.string().trim().min(1).max(64),
        price: z.number().int().nonnegative(),
        description: z.string().trim().min(2).max(4000),
        operator: z.string().trim().max(64).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { factory } = await sessionMe(input.token);
      await verifyPublishKey(input.publishKey, factory.id, "agent");
      const [{ id: agentId }] = await db
        .insert(wbListings)
        .values({
          factoryId: factory.id,
          type: "agent",
          title: input.title,
          capabilities: input.capabilities,
          employmentType: input.employmentType,
          pricingModel: input.pricingModel,
          price: input.price,
          description: input.description,
          operator: input.operator ?? null,
          status: "pending",
        })
        .$returningId();
      return { agentId, status: "pending" as const, geneEventId: newGeneEventId() };
    }),

  /**
   * certifyAgent（mutation，仅 admin）：将 pending 上架审核为 listed / rejected。
   * 输入 { token, listingId, approve, reason? }
   */
  certifyAgent: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        listingId: z.number().int().positive(),
        approve: z.boolean(),
        reason: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { user, factory } = await sessionMe(input.token);
      if (user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅 admin 可审核上架" });
      }
      const [listing] = await db
        .select()
        .from(wbListings)
        .where(
          and(
            eq(wbListings.id, input.listingId),
            eq(wbListings.factoryId, factory.id),
          ),
        )
        .limit(1);
      if (!listing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "上架不存在" });
      }
      if (listing.status !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "该上架已被审核" });
      }
      const status = input.approve ? ("listed" as const) : ("rejected" as const);
      await db
        .update(wbListings)
        .set({ status, decidedBy: user.id, decidedAt: new Date() })
        .where(eq(wbListings.id, listing.id));
      return { ok: true as const, listingId: listing.id, status };
    }),

  /**
   * hireAgentWithContract（mutation，需要 token）。
   * 事务内校验目标为 listed → hires+1 并创建 pending 合同。
   * 输出 { contractId, hires, geneEventId }
   */
  hireAgentWithContract: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        listingId: z.number().int().positive(),
        roleScope: z.string().trim().min(1).max(128),
        workMode: z.string().trim().min(1).max(64),
        trialDays: z.number().int().positive().max(365).optional(),
        note: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { factory } = await sessionMe(input.token);
      return await db.transaction(async (tx) => {
        const [listing] = await tx
          .select()
          .from(wbListings)
          .where(eq(wbListings.id, input.listingId))
          .limit(1);
        if (!listing) {
          throw new TRPCError({ code: "NOT_FOUND", message: "上架不存在" });
        }
        if (listing.status !== "listed") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "目标未处于 listed 状态，无法招募",
          });
        }
        await tx
          .update(wbListings)
          .set({ hires: sql`${wbListings.hires} + 1` })
          .where(eq(wbListings.id, listing.id));
        const [{ id: contractId }] = await tx
          .insert(wbContracts)
          .values({
            factoryId: factory.id, // 雇主企业
            listingId: listing.id,
            roleScope: input.roleScope,
            workMode: input.workMode,
            trialDays: input.trialDays ?? null,
            note: input.note ?? null,
            status: "pending",
          })
          .$returningId();
        return {
          contractId,
          hires: listing.hires + 1,
          geneEventId: newGeneEventId(),
        };
      });
    }),

  /** myHireContracts（query，需要 token）：本企业合同列表（含上架标题） */
  myHireContracts: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const db = getDb();
      const { factory } = await sessionMe(input.token);
      const rows = await db
        .select({
          contract: wbContracts,
          listingTitle: wbListings.title,
          listingType: wbListings.type,
        })
        .from(wbContracts)
        .leftJoin(wbListings, eq(wbContracts.listingId, wbListings.id))
        .where(eq(wbContracts.factoryId, factory.id))
        .orderBy(desc(wbContracts.id));
      return rows.map((r) => ({
        ...r.contract,
        listingTitle: r.listingTitle,
        listingType: r.listingType,
      }));
    }),

  /**
   * decideHireContract（mutation，仅 owner/admin）：将 pending 合同审批为 active / rejected。
   * 输入 { token, contractId, approve, reason? }
   */
  decideHireContract: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        contractId: z.number().int().positive(),
        approve: z.boolean(),
        reason: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { user, factory } = await sessionMe(input.token);
      if (user.role !== "owner" && user.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "仅 owner/admin 可审批合同",
        });
      }
      const [contract] = await db
        .select()
        .from(wbContracts)
        .where(
          and(
            eq(wbContracts.id, input.contractId),
            eq(wbContracts.factoryId, factory.id),
          ),
        )
        .limit(1);
      if (!contract) {
        throw new TRPCError({ code: "NOT_FOUND", message: "合同不存在" });
      }
      if (contract.status !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "该合同已被审批" });
      }
      const status = input.approve ? ("active" as const) : ("rejected" as const);
      await db
        .update(wbContracts)
        .set({ status, decidedBy: user.id, decidedAt: new Date() })
        .where(eq(wbContracts.id, contract.id));
      return { ok: true as const, contractId: contract.id, status };
    }),

  /**
   * listListings（query，需要 token）—— 文档之外的补充查询（UI 必需）：
   * 返回本企业全部 listings（含 pending/listed/rejected），以及全平台 listed 条目（技能商城浏览用）。
   */
  listListings: publicQuery
    .input(z.object({ token: z.string().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const db = getDb();
      const mine = await db
        .select()
        .from(wbListings)
        .where(eq(wbListings.factoryId, factory.id))
        .orderBy(desc(wbListings.createdAt));
      const listed = await db
        .select()
        .from(wbListings)
        .where(eq(wbListings.status, "listed"))
        .orderBy(desc(wbListings.hires), desc(wbListings.createdAt));
      return { mine, listed };
    }),

  /**
   * forgePackage（mutation，需要 token）—— 技能工坊一键封装上架。
   * 输入 { token, masterName, experience, skillName? }。
   * 确定性从经验文本提炼技能卡（名称/分类/描述/价格建议），创建 publishKey 流程外的
   * 内部草稿并直接走 publish 两段式：写入 wb_listings（type=skill，status=pending），
   * 返回 pending 状态 + 草稿内容 + "已提交，等待审核上架"措辞。不绕过 certifyAgent 审核。
   */
  forgePackage: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        masterName: z.string().trim().min(2).max(64),
        experience: z.string().trim().min(10).max(4000),
        skillName: z.string().trim().min(2).max(128).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { factory } = await sessionMe(input.token);
      const draft = forgeSkillCard(input.masterName, input.experience, input.skillName);
      const [{ id: listingId }] = await db
        .insert(wbListings)
        .values({
          factoryId: factory.id,
          type: "skill",
          title: draft.name,
          category: draft.category,
          description: draft.description,
          delivery: draft.delivery,
          pricingModel: draft.pricingModel,
          price: draft.priceSuggested,
          accuracy: null,
          operator: `${input.masterName}（技能工坊封装）`,
          status: "pending",
        })
        .$returningId();
      return {
        listingId,
        status: "pending" as const,
        draft,
        geneEventId: newGeneEventId(),
        message:
          "已提交，等待审核上架（两段式：提交 pending + 平台人工确认，不即时生效）",
      };
    }),
});

// ─── forgePackage 确定性提炼 ─────────────────────────────────────────────────
/** 经验文本关键词 → 技能分类（顺序即优先级） */
const FORGE_CATEGORY_MAP: [string[], string][] = [
  [["焊"], "焊接工艺"],
  [["热处理", "淬火", "回火"], "热处理工艺"],
  [["振动", "动平衡"], "设备诊断"],
  [["质检", "检验", "测量", "计量"], "质量检测"],
  [["数控", "编程", "CNC", "cnc"], "数控工艺"],
  [["装配"], "装配工艺"],
  [["喷涂", "涂装"], "表面涂装"],
  [["冲压", "锻"], "冲压锻造"],
  [["巡检", "保养"], "设备运维"],
];

function forgeSkillCard(masterName: string, experience: string, skillName?: string) {
  // 分类：关键词命中（确定性）
  let category = "经验技能";
  for (const [keys, cat] of FORGE_CATEGORY_MAP) {
    if (keys.some((k) => experience.includes(k))) {
      category = cat;
      break;
    }
  }
  // 工龄提取（首个 "N 年" 命中；缺省 5 年）
  const yearsMatch = experience.match(/(\d{1,2})\s*年/);
  const years = yearsMatch ? Math.min(50, parseInt(yearsMatch[1], 10)) : 5;
  // 复杂度：由经验文本长度确定性分档 1-5
  const complexity = Math.min(5, 1 + Math.floor(experience.length / 120));
  // 价格建议（Token/次）：基准 80 + 工龄×10 + 复杂度×40，取整到 10，封顶 2000
  const priceSuggested = Math.min(
    2000,
    Math.round((80 + years * 10 + complexity * 40) / 10) * 10,
  );
  const name = skillName?.trim() || `${category}实战技能`;
  const brief = experience.length > 120 ? `${experience.slice(0, 120)}……` : experience;
  const description = `源自${masterName} ${years} 年一线经验，经技能工坊确定性提炼封装：${brief}`;
  return {
    name,
    category,
    description,
    priceSuggested,
    pricingModel: "per_call",
    delivery: "API 实时调用",
    masterName,
    years,
    complexity,
  };
}
