/**
 * skillMarket / corpsBoard —— iter92 技能市场 + 行业战绩榜。
 *
 * 契约：
 * - market.list {token} → {items:[listed 技能]}（来源匿名化为「某{industry}企业」，不返回 source_factory_id）
 * - market.my {token} → {published:[...], purchased:[...]}（本厂发布与已购；已购来源同样匿名）
 * - market.publish {token, skillKey, title, description, priceTokens} → 前置：本厂 st_sandbox_skills.graduated=1；status=pending
 * - market.purchase {token, skillId} → listed 才可购；INSERT IGNORE + 本厂 enabled ex 成员 duty 追加「｜市场:skill_key」
 * - corpsBoard.industry {token} → {industry, corpsCount, avgPassRate, totalTasks, myRank, bands:[...]}
 *   （本厂 industryGroup 内聚合匿名，绝不暴露他厂名称/id）
 *
 * 安全红线：factory_id 强制过滤；market.list / 已购来源脱敏；战绩榜仅聚合+序号排名。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { stQuery } from "./terminal";
import { rawRows } from "../queries/rawRows"; // R7-c153-④：行解包同引（getDb 本文件既有导入——不重引）
import { isNoSuchTable, isBadFieldErr, infraUnavailable500 } from "../auth/identity"; // R7-c153-④：谓词+政策点同引
import { sessionMe } from "./wbSession";
import { requireWbHead } from "./claw";
import { recordFitness } from "./fitnessUtil";
import { getDb } from "../queries/connection";
import { buildSkillMetas, executorKindOf, type SkillMarketMeta } from "./skillStats";

/** 技能市场表未建提示单源（R7-c155-⑤）：list 主查+回落支同引（sync-iter92.mts 名一改双处漂移面封死） */
const MARKET_TABLES_HINT = "技能市场数据表未初始化，请先在服务器执行 db/sync-iter92.mts 后再操作";

/** 技能市场族查询兜底（R7-c156-⑤ bug low）：my/publish/purchase 等本族语句同引——412 不再指错 sync-terminal.mts
 *  （TERMINAL_TABLES_HINT 不建 st_skill_market——同表异提示=运维空跑面封死） */
const marketQuery = (statement: ReturnType<typeof sql>) => stQuery(statement, MARKET_TABLES_HINT);

/**
 * iter99 真实扣费：市场购买走企业钱包（enterprises.tokenBalance，enterpriseId=factoryId 对齐）。
 * - 原子扣款：UPDATE ... WHERE tokenBalance >= price，0 行受影响 = 余额不足拒绝；
 * - 流水：st_token_ledger 买卖双方各一行（买方 purchase 全额支出，卖方 skill_sale 80% 分成，平台 20% 计量费）；
 * - 重复购买（alreadyPurchased）不再扣款；自家工厂技能不可自购。
 */
const PLATFORM_FEE_RATE = 0.2;

/** 来源匿名化：「某{industry}企业」 */
function anonSource(industry: string): string {
  return `某${industry}企业`;
}

export const marketRouter = createRouter({
  /** market.list（query, wb）：已上架技能（listed），来源企业匿名 */
  list: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      // M82 超市四分类（彭总架构图 2026-08-25）：personal/enterprise/industry/general
      marketClass: z.enum(["personal", "enterprise", "industry", "general"]).optional(),
    }))
    .query(async ({ input }) => {
      await sessionMe(input.token);
      let rows;
      try {
        // R7-c153-④：本查询带 1054 回落判别消费面——直读不经 stQuery 掩码（掩码后 isBadFieldErr 判无处下嘴=回落死面）；
        //  判别走 cause 链谓词单源（裸 message 正则在 drizzle 包装层永不中=老判法死代码）；缺表 412/余故障政策点掩码
        rows = rawRows(await getDb().execute(
          sql`SELECT id, skill_key AS skillKey, title, industry, description,
                     price_tokens AS priceTokens, listed_at AS listedAt, market_class AS marketClass
              FROM st_skill_market WHERE status = 'listed'
              ${input.marketClass ? sql`AND market_class = ${input.marketClass}` : sql``}
              ORDER BY listed_at DESC, id DESC LIMIT 100`,
        ));
      } catch (e) {
        if (isNoSuchTable(e)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: MARKET_TABLES_HINT });
        // market_class 列未上（旧环境）→ 回退旧查询不带过滤
        if (!isBadFieldErr(e)) infraUnavailable500("[routers/skillMarket] list 查验失败", e);
        rows = await stQuery( // R7-c154-③/R7-c156-⑤ security low：回落查询同样受守卫（回落自身故障不再裸泄 raw——
          //  1146→412/余→掩码 500 政策点；本族提示直呼 stQuery 带参——marketQuery 系单参包装，带提示须直呼）
          sql`SELECT id, skill_key AS skillKey, title, industry, description,
                     price_tokens AS priceTokens, listed_at AS listedAt
              FROM st_skill_market WHERE status = 'listed'
              ORDER BY listed_at DESC, id DESC LIMIT 100`,
          MARKET_TABLES_HINT,
        );
      }
      const items = rows.map((r) => ({
        id: Number(r.id),
        skillKey: String(r.skillKey),
        title: String(r.title),
        industry: String(r.industry),
        description: r.description ? String(r.description) : null,
        priceTokens: Number(r.priceTokens),
        source: anonSource(String(r.industry)),
        marketClass: r.marketClass ? String(r.marketClass) : null, // M82
        listedAt: r.listedAt ? String(r.listedAt) : null,
      }));
      // Harness H1 技能真实化审计：附加 executorKind/badge/realSuccessRate
      // （真实成功率 = 近 90 天 st_skill_calls，样本不足 5 次为 null；失败静默不阻断列表）
      let metas: SkillMarketMeta[];
      try {
        metas = await buildSkillMetas(
          items.map((it) => ({ rateKey: it.skillKey, executorKind: executorKindOf(it.skillKey) })),
        );
      } catch {
        metas = items.map(() => ({ executorKind: null, badge: "generative" as const, realSuccessRate: null }));
      }
      return {
        items: items.map((it, i) => ({
          ...it,
          ...(metas[i] ?? { executorKind: null, badge: "generative" as const, realSuccessRate: null }),
        })),
      };
    }),

  /** market.my（query, wb）：本厂发布（全状态）+ 已购（来源匿名） */
  my: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const fid = factory.id;
      const pub = await marketQuery(
        sql`SELECT id, skill_key AS skillKey, title, industry, description,
                   price_tokens AS priceTokens, status, created_at AS createdAt, listed_at AS listedAt
            FROM st_skill_market WHERE source_factory_id = ${fid}
            ORDER BY id DESC LIMIT 100`,
      );
      const pur = await marketQuery(
        sql`SELECT p.id AS purchaseId, p.created_at AS purchasedAt,
                   m.id AS skillId, m.skill_key AS skillKey, m.title, m.industry, m.description,
                   m.price_tokens AS priceTokens
            FROM st_skill_purchases p
            JOIN st_skill_market m ON m.id = p.skill_id
            WHERE p.factory_id = ${fid}
            ORDER BY p.id DESC LIMIT 100`,
      );
      return {
        published: pub.map((r) => ({
          id: Number(r.id),
          skillKey: String(r.skillKey),
          title: String(r.title),
          industry: String(r.industry),
          description: r.description ? String(r.description) : null,
          priceTokens: Number(r.priceTokens),
          status: String(r.status),
          createdAt: r.createdAt ? String(r.createdAt) : null,
          listedAt: r.listedAt ? String(r.listedAt) : null,
        })),
        purchased: pur.map((r) => ({
          purchaseId: Number(r.purchaseId),
          skillId: Number(r.skillId),
          skillKey: String(r.skillKey),
          title: String(r.title),
          industry: String(r.industry),
          description: r.description ? String(r.description) : null,
          priceTokens: Number(r.priceTokens),
          source: anonSource(String(r.industry)),
          purchasedAt: r.purchasedAt ? String(r.purchasedAt) : null,
        })),
      };
    }),

  /** market.publish（mutation, wb owner）：前置=本厂该技能已 graduated；落 pending 待平台审核 */
  publish: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      skillKey: z.string().trim().min(1).max(64),
      title: z.string().trim().min(2).max(128),
      description: z.string().trim().max(2000).optional(),
      priceTokens: z.number().int().min(0).max(1_000_000).default(0),
    }))
    .mutation(async ({ input }) => {
      const { factory } = await requireWbHead(input.token);
      const fid = factory.id;
      // 前置：该技能本厂已在训练场毕业
      const sk = await stQuery(
        sql`SELECT graduated FROM st_sandbox_skills
            WHERE factory_id = ${fid} AND skill_key = ${input.skillKey} LIMIT 1`,
      );
      if (!sk[0] || Number(sk[0].graduated) !== 1) {
        throw new TRPCError({ code: "FORBIDDEN", message: "该技能尚未在训练场毕业（graduated=1），不能发布到技能市场" });
      }
      // 幂等：同厂同技能已有 pending/listed 记录不重复发布
      const dup = await marketQuery(
        sql`SELECT id, status FROM st_skill_market
            WHERE source_factory_id = ${fid} AND skill_key = ${input.skillKey}
              AND status IN ('pending','listed') LIMIT 1`,
      );
      if (dup[0]) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `该技能已发布过（当前状态 ${String(dup[0].status)}），请勿重复提交`,
        });
      }
      const industry = String(factory.industryGroup ?? factory.industry ?? "通用");
      // M82：上架即继承技能库四类归属（st_skills.market_class → 市场行；无则 general）
      let mclass = "general";
      try {
        const sr = await stQuery(
          sql`SELECT market_class FROM st_skills WHERE skill_key = ${input.skillKey} LIMIT 1`,
        );
        if (sr[0]?.market_class) mclass = String(sr[0].market_class);
      } catch { /* 列缺席静默落 general */ }
      const ins = await marketQuery(
        sql`INSERT INTO st_skill_market (skill_key, title, industry, description, source_factory_id, price_tokens, status, market_class)
            VALUES (${input.skillKey}, ${input.title}, ${industry}, ${input.description ?? null},
                    ${fid}, ${input.priceTokens}, 'pending', ${mclass})`,
      );
      const id = Number((ins[0] as { insertId?: number } | undefined)?.insertId ?? 0);
      return { ok: true as const, id, status: "pending" as const, message: "已提交平台审核，批准后上架" };
    }),

  /** market.purchase（mutation, wb owner）：listed 才可购；INSERT IGNORE + 挂载本厂军团 */
  purchase: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      skillId: z.number().int().positive(),
    }))
    .mutation(async ({ input }) => {
      const { factory } = await requireWbHead(input.token);
      const fid = factory.id;
      const rows = await marketQuery(
        sql`SELECT id, skill_key AS skillKey, status, price_tokens AS priceTokens,
                   source_factory_id AS sourceFactoryId
            FROM st_skill_market WHERE id = ${input.skillId} LIMIT 1`,
      );
      const m = rows[0];
      if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "技能不存在" });
      if (String(m.status) !== "listed") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `技能当前状态 ${String(m.status)}，仅 listed 可购买` });
      }
      const skillKey = String(m.skillKey);
      const price = Math.max(0, Number(m.priceTokens ?? 0));
      const sellerFid = Number(m.sourceFactoryId ?? 0);
      if (sellerFid === fid) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "这是本厂自己发布的技能，无需购买" });
      }
      const existed = await marketQuery( // R7-c159-②：st_skill_purchases 系本族表——同引 marketQuery（412 不再指错 sync-terminal.mts）
        sql`SELECT id FROM st_skill_purchases WHERE skill_id = ${input.skillId} AND factory_id = ${fid} LIMIT 1`,
      );
      const alreadyPurchased = !!existed[0];
      let charged = 0;
      let balanceAfter: number | null = null;
      if (!alreadyPurchased) {
        // iter99 真实扣费：原子扣款（余额不足 0 行受影响 → 明确拒绝，不产生任何记录）
        if (price > 0) {
          const debit = await getDb().execute(
            sql`UPDATE enterprises SET tokenBalance = tokenBalance - ${price}
                WHERE id = ${fid} AND tokenBalance >= ${price}`,
          );
          const affected = Number(
            ((debit as unknown as Array<{ affectedRows?: number | string }>)[0] as
              | { affectedRows?: number | string }
              | undefined)?.affectedRows ?? 0,
          );
          if (affected === 0) {
            const bal = await stQuery(
              sql`SELECT tokenBalance AS b FROM enterprises WHERE id = ${fid} LIMIT 1`,
            );
            const cur = bal[0] ? Number(bal[0].b) : 0;
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Token 余额不足：需 ${price}，当前 ${cur}。请到「Token 充值」先充值。`,
            });
          }
          charged = price;
          const balRows = await stQuery(
            sql`SELECT tokenBalance AS b FROM enterprises WHERE id = ${fid} LIMIT 1`,
          );
          balanceAfter = balRows[0] ? Number(balRows[0].b) : null;
          // 买方流水（支出）
          await stQuery(
            sql`INSERT INTO st_token_ledger (factory_id, delta, balance_after, kind, ref, note)
                VALUES (${fid}, ${-price}, ${balanceAfter ?? 0}, 'purchase', ${`skill:${input.skillId}`},
                        ${`购买技能 ${skillKey}`.slice(0, 255)})`,
          );
          // 卖方分成（80%）+ 卖方流水（入账）；平台 20% 计量费只记流水口径不转账
          const sellerShare = Math.floor(price * (1 - PLATFORM_FEE_RATE));
          if (sellerShare > 0 && sellerFid > 0) {
            await getDb().execute(
              sql`INSERT INTO enterprises (id, name, industry, tokenBalance)
                  VALUES (${sellerFid}, ${`企业#${sellerFid}`}, '工业制造', ${sellerShare})
                  ON DUPLICATE KEY UPDATE tokenBalance = tokenBalance + ${sellerShare}`,
            );
            const sb = await stQuery(
              sql`SELECT tokenBalance AS b FROM enterprises WHERE id = ${sellerFid} LIMIT 1`,
            );
            await stQuery(
              sql`INSERT INTO st_token_ledger (factory_id, delta, balance_after, kind, ref, note)
                  VALUES (${sellerFid}, ${sellerShare}, ${sb[0] ? Number(sb[0].b) : 0}, 'skill_sale',
                          ${`skill:${input.skillId}`},
                          ${`售出技能 ${skillKey}（80% 分成，平台计量费 20%）`.slice(0, 255)})`,
            );
          }
        }
        await marketQuery( // R7-c159-②：同上——本族表归本族包装
          sql`INSERT IGNORE INTO st_skill_purchases (skill_id, factory_id) VALUES (${input.skillId}, ${fid})`,
        );
      }
      // 挂载：本厂 enabled 的 ex 成员 duty 追加「｜市场:skill_key」（防重复追加）
      const mountTag = `｜市场:${skillKey}`;
      await stQuery(
        sql`UPDATE st_panda_members
            SET duty = CONCAT(IFNULL(duty, ''), ${mountTag})
            WHERE factory_id = ${fid} AND role = 'ex' AND enabled = 1
              AND (duty IS NULL OR duty NOT LIKE ${`%${mountTag}%`})`,
      );
      // iter96 适应度回写：技能购买成功 → success=true, skillKey=所购技能
      await recordFitness(fid, skillKey, true);
      return { ok: true as const, skillId: input.skillId, skillKey, alreadyPurchased, charged, balanceAfter };
    }),
});

export const corpsBoardRouter = createRouter({
  /** corpsBoard.industry（query, wb）：本厂行业战绩榜（聚合匿名，无他厂名称/id） */
  industry: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const fid = factory.id;
      const industry = String(factory.industryGroup ?? factory.industry ?? "");
      const rows = await stQuery(
        sql`SELECT c.id AS corpsId, c.factory_id AS factoryId, c.train_pass_rate AS trainPassRate
            FROM st_corps c
            JOIN wb_factories f ON f.id = c.factory_id
            WHERE COALESCE(f.industryGroup, f.industry) = ${industry}
            LIMIT 500`,
      );
      const corpsCount = rows.length;
      const rates = rows.map((r) =>
        r.trainPassRate === null || r.trainPassRate === undefined ? null : Number(r.trainPassRate),
      );
      const valid = rates.filter((v): v is number => v !== null);
      const avgPassRate = valid.length > 0
        ? Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 100) / 100
        : 0;
      // myRank：按 train_pass_rate 降序（未训练/null 排最后），本厂名次（1 起，无军团为 null）
      const sorted = rows
        .map((r, i) => ({ factoryId: Number(r.factoryId), rate: rates[i] }))
        .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
      const myIdx = sorted.findIndex((r) => r.factoryId === fid);
      const myRank = myIdx >= 0 ? myIdx + 1 : null;
      // 分桶（匿名计数）
      let excellent = 0;
      let good = 0;
      let poor = 0;
      for (const rate of rates) {
        if (rate !== null && rate >= 95) excellent += 1;
        else if (rate !== null && rate >= 80) good += 1;
        else poor += 1;
      }
      // totalTasks：该行业全部 corps 的 st_corps_training 总数
      let totalTasks = 0;
      const corpsIds = rows.map((r) => Number(r.corpsId));
      if (corpsIds.length > 0) {
        const tt = await stQuery(
          sql`SELECT COUNT(*) AS c FROM st_corps_training
              WHERE corps_id IN (${sql.join(corpsIds.map((id) => sql`${id}`), sql`, `)})`,
        );
        totalTasks = Number(tt[0]?.c ?? 0);
      }
      return {
        industry,
        corpsCount,
        avgPassRate,
        totalTasks,
        myRank,
        bands: [
          { label: "优秀(≥95)", count: excellent },
          { label: "良好(80-95)", count: good },
          { label: "待提升(<80)", count: poor },
        ],
      };
    }),
});
