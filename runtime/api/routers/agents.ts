import { z } from "zod";
import { randomBytes } from "node:crypto";
import { and, desc, eq, gte, lte, like, or, sql, type SQL } from "drizzle-orm";
import { createRouter, publicQuery, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import {
  agents,
  masters,
  skills,
  reviews,
  enterprises,
  agentHireRecords,
  agentMemories,
  wbEvoIdentities,
} from "@db/schema";
import { applyRecommendOrder, loadRecommendSlots } from "./opsRecommend";
import { buildSkillMetas, badgeOfKind, type SkillMarketMeta } from "./skillStats";
import { cached, invalidate } from "./perfCache";

type SQLWrapper = SQL | undefined;

const sortEnum = z
  .enum(["recommended", "rating", "priceAsc", "priceDesc", "tasks", "newest"])
  .default("recommended");

async function agentCards(where?: SQLWrapper) {
  const db = getDb();
  const rows = await db
    .select({
      agent: agents,
      masterName: masters.name,
      masterSignature: masters.signature,
      masterReputation: masters.reputation,
    })
    .from(agents)
    .leftJoin(masters, eq(agents.masterId, masters.id))
    .where(where);
  // iter96 诚信整改：tasksCompleted/successRate/memoryCount 不再展示种子营销数，
  // 一律用运行时真实值：tasksCompleted=该 Agent 全部技能真实调用次数之和；
  // memoryCount=真实工作记忆条目数；successRate 无真实成功样本时置 0（前端显示「待验证」）。
  const tcRows = await db.execute(
    sql`SELECT agentId AS agentId, COALESCE(SUM(callCount),0) AS tc FROM skills GROUP BY agentId`,
  );
  const memRows = await db.execute(
    sql`SELECT agentId AS agentId, COUNT(*) AS mc FROM agent_memories GROUP BY agentId`,
  );
  const tcMap = new Map<number, number>();
  const mcMap = new Map<number, number>();
  const tcList = ((tcRows as unknown as Array<Array<{ agentId: number | string; tc: number | string }>>)[0]) ?? [];
  const mcList = ((memRows as unknown as Array<Array<{ agentId: number | string; mc: number | string }>>)[0]) ?? [];
  for (const r of tcList) tcMap.set(Number(r.agentId), Number(r.tc));
  for (const r of mcList) mcMap.set(Number(r.agentId), Number(r.mc));
  // v2026-09-05 脱假补刀：weeklyHires 改真口径（近 7 天真实雇佣单数，无单归零）
  const hireRows = await db.execute(
    sql`SELECT agentId AS agentId, COUNT(*) AS hc FROM agent_hire_records
        WHERE createdAt > NOW() - INTERVAL 7 DAY GROUP BY agentId`,
  ).catch(() => null);
  const hcMap = new Map<number, number>();
  const hcList = ((hireRows as unknown as Array<Array<{ agentId: number | string; hc: number | string }>> | null)?.[0]) ?? [];
  for (const r of hcList) hcMap.set(Number(r.agentId), Number(r.hc));
  return rows.map((r) => {
    const realTasks = tcMap.get(r.agent.id) ?? 0;
    return {
      ...r.agent,
      tasksCompleted: realTasks,
      // 真实成功样本暂未按 Agent 维度采集（适应度回写暂为工作台维度）：
      // 有真实完成量但无成功率口径 → 置 0，由前端如实显示「待验证」，绝不沿用种子假数
      successRate: 0,
      weeklyHires: hcMap.get(r.agent.id) ?? 0,
      capabilityTier: capabilityTierOf(r.agent.id),
      // 自我介绍里的种子战绩一并清（「已完成 N 次任务，成功率 X%」→ 真实口径文案）
      introText: typeof (r.agent as { introText?: unknown }).introText === "string"
        ? String((r.agent as { introText: string }).introText)
            .replace(/已完成\s*[\d.]+\s*次任务[，,]?\s*成功率\s*[\d.]+%[。.]?/g, "战绩真实累计中，欢迎来当第一位验收老板。")
        : (r.agent as { introText?: unknown }).introText,
      memoryCount: mcMap.get(r.agent.id) ?? 0,
      masterName: r.masterName,
      masterSignature: r.masterSignature,
      masterReputation: r.masterReputation,
    };
  });
}

/** v2026-09-05 技能三档明示（彭总令：真技能/假技能梳理落地）——
 *  审计定档（数字匠市-全员真实技能审计.md）：
 *  tool=工具级（真技能，工具链闭环产出真工件）；advice=咨询级（方案/文本真实，不动系统）；
 *  device=设备级（接了设备才是真诊断/真控制）。买前明示，不许含糊。 */
const TIER_TOOL_IDS = new Set([90008, 90024, 90025, 90026, 90027, 90028, 90029, 90030, 90031, 90032, 90033, 90034]);
const TIER_DEVICE_IDS = new Set([1, 2, 3, 4, 5, 6]);
export function capabilityTierOf(agentId: number): { tier: "tool" | "advice" | "device"; label: string } {
  if (TIER_TOOL_IDS.has(agentId)) return { tier: "tool", label: "工具级·真出工件" };
  if (TIER_DEVICE_IDS.has(agentId)) return { tier: "device", label: "设备级·接设备后真诊断" };
  return { tier: "advice", label: "咨询级·出方案建议" };
}

export const agentsRouter = createRouter({
  /** 上架 Agent（需登录）：slug 唯一 + 自动编号 ART-XXXX，status=pending 待审核；
   *  可同时勾选/新建初始技能；老师傅署名自动匹配或新建 master */
  create: authedQuery
    .input(
      z.object({
        name: z.string().trim().min(1).max(64),
        industry: z.string().trim().min(2).max(64),
        capabilityTags: z.array(z.string().trim().min(1).max(32)).min(1).max(8),
        masterSignature: z.string().trim().min(2).max(128), // 如 "陈国栋 · 32年数控经验"
        intro: z.string().trim().min(10).max(1000),
        monthlyPrice: z.number().int().min(100).max(1_000_000),
        avatar: z.enum([
          "/avatar-zhenheng.png",
          "/avatar-tingtao.png",
          "/avatar-chimou.png",
          "/avatar-hengzhun.png",
          "/avatar-celu.png",
          "/avatar-xunxian.png",
        ]),
        initialSkills: z
          .array(
            z.object({
              name: z.string().trim().min(2).max(128),
              type: z.enum(["V", "U"]),
              complexity: z.number().int().min(1).max(5),
              pricePerCall: z.number().int().min(1).max(100_000),
              description: z.string().trim().max(255).optional(),
            }),
          )
          .max(8)
          .default([]),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();

      // slug：ASCII 化（中文名回退 "agent"）+ 随机后缀，冲突时重试
      const ascii = input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const base = ascii || "agent";
      let slug = "";
      for (let i = 0; i < 10; i++) {
        const candidate = `${base}-${randomBytes(2).toString("hex")}`;
        const [dup] = await db
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.slug, candidate))
          .limit(1);
        if (!dup) {
          slug = candidate;
          break;
        }
      }
      if (!slug) slug = `${base}-${randomBytes(4).toString("hex")}`;

      // code：ART-XXXX 取当前最大编号 +1
      const rows = await db.select({ code: agents.code }).from(agents);
      const maxNum = rows.reduce((m, r) => {
        const n = Number(r.code.replace(/^ART-/, ""));
        return Number.isFinite(n) ? Math.max(m, n) : m;
      }, 0);
      const code = `ART-${String(maxNum + 1).padStart(4, "0")}`;

      // 老师傅：按署名匹配，否则解析署名新建（"张三 · 20年经验"）
      let [master] = await db
        .select()
        .from(masters)
        .where(eq(masters.signature, input.masterSignature))
        .limit(1);
      if (!master) {
        const masterName = input.masterSignature.split("·")[0]?.trim() || input.masterSignature;
        const years = Number(input.masterSignature.match(/(\d+)\s*年/)?.[1]) || 20;
        const [{ id: masterId }] = await db
          .insert(masters)
          .values({
            name: masterName.slice(0, 64),
            signature: input.masterSignature,
            specialty: input.industry,
            yearsExperience: years,
            reputation: 80,
          })
          .$returningId();
        const [created] = await db
          .select()
          .from(masters)
          .where(eq(masters.id, masterId))
          .limit(1);
        master = created;
      }

      const [{ id: agentId }] = await db
        .insert(agents)
        .values({
          slug,
          code,
          name: input.name,
          avatar: input.avatar,
          industry: input.industry,
          capabilityTags: input.capabilityTags,
          masterId: master.id,
          status: "pending", // 待审核
          monthlyPrice: input.monthlyPrice,
          suggestedPrice: input.monthlyPrice,
          skillCount: input.initialSkills.length,
          weeklyHireTrend: [0, 0, 0, 0, 0, 0, 0],
          recommended: false,
          certified: false,
          listedAt: new Date(),
        })
        .$returningId();

      // 简介 → 首条工作记忆（agents 表无简介列）
      await db.insert(agentMemories).values({
        agentId,
        category: "工匠简介",
        summary: input.intro,
      });

      // 初始技能
      for (const s of input.initialSkills) {
        await db.insert(skills).values({
          agentId,
          name: s.name,
          type: s.type,
          complexity: s.complexity,
          pricePerCall: s.pricePerCall,
          description: s.description ?? null,
        });
      }

      // iter85：新 agent 上架（pending）影响 facets/审核列表口径，失效 agents 缓存
      invalidate("agents:");

      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);
      return { agent, master };
    }),

  /** 匠市列表：搜索 / 行业 / 能力 / 价格区间 / 排序 */
  list: publicQuery
    .input(
      z
        .object({
          search: z.string().trim().max(64).optional(),
          industry: z.string().trim().max(64).optional(),
          industryGroup: z.string().trim().max(32).optional(),
          capabilities: z.array(z.string().max(32)).max(8).optional(),
          minPrice: z.number().int().min(0).optional(),
          maxPrice: z.number().int().min(0).optional(),
          status: z.enum(["pending", "active", "suspended"]).optional(),
          sort: sortEnum,
          limit: z.number().int().min(1).max(100).default(50),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const opts = input ?? { sort: "recommended" as const, limit: 50 };
      // iter85：公开匠市列表无租户差异，整查询缓存 30s；hire/admin 改 agent 时按 "agents:" 前缀失效
      return cached(`agents:list:${JSON.stringify(opts)}`, 30_000, async () => {
      const conds = [];
      // 匠市公共列表默认只展示 active；pending/rejected/suspended 不对外可见
      conds.push(eq(agents.status, opts.status ?? "active"));
      if (opts.industry) conds.push(eq(agents.industry, opts.industry));
      if (opts.industryGroup)
        conds.push(eq(agents.industryGroup, opts.industryGroup));
      if (opts.minPrice != null) conds.push(gte(agents.monthlyPrice, opts.minPrice));
      if (opts.maxPrice != null) conds.push(lte(agents.monthlyPrice, opts.maxPrice));
      if (opts.search) {
        const kw = `%${opts.search}%`;
        conds.push(
          or(
            like(agents.name, kw),
            like(agents.industry, kw),
            like(agents.code, kw),
            sql`JSON_SEARCH(${agents.capabilityTags}, 'one', ${`%${opts.search}%`}) IS NOT NULL`,
          ),
        );
      }
      let rows = await agentCards(conds.length ? and(...conds) : undefined);
      if (opts.capabilities?.length) {
        const caps = opts.capabilities;
        rows = rows.filter((r) =>
          caps.some((c) => r.capabilityTags.some((t) => t.includes(c))),
        );
      }
      switch (opts.sort) {
        case "rating":
          rows.sort((a, b) => b.avgRating - a.avgRating);
          break;
        case "priceAsc":
          rows.sort((a, b) => a.monthlyPrice - b.monthlyPrice);
          break;
        case "priceDesc":
          rows.sort((a, b) => b.monthlyPrice - a.monthlyPrice);
          break;
        case "tasks":
          rows.sort((a, b) => b.tasksCompleted - a.tasksCompleted);
          break;
        case "newest":
          rows.sort((a, b) => b.listedAt.getTime() - a.listedAt.getTime());
          break;
        default:
          rows.sort(
            (a, b) =>
              Number(b.recommended) - Number(a.recommended) ||
              b.avgRating - a.avgRating ||
              b.tasksCompleted - a.tasksCompleted,
          );
      }
      // 迭代 35 批次B：推荐位运营（portal_agents）只影响排序不滤除条目
      rows = applyRecommendOrder(rows, await loadRecommendSlots("portal_agents"), (r) => String(r.id));
      return { total: rows.length, items: rows.slice(0, opts.limit) };
      });
    }),

  /** Agent 详情：档案 + 技能 + 评价分布 + 评价列表 + 雇佣历史 + 记忆 + 价格 */
  detail: publicQuery
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }) => {
      // iter85：详情为公开只读聚合，缓存 60s；评价/雇佣写入经 hire/review 的 invalidate("agents:") 失效
      return cached(`agents:detail:${input.id}`, 60_000, async () => {
      const db = getDb();
      const [row] = await db
        .select({ agent: agents, master: masters })
        .from(agents)
        .leftJoin(masters, eq(agents.masterId, masters.id))
        .where(eq(agents.id, input.id))
        .limit(1);
      if (!row) throw new Error(`Agent ${input.id} 不存在`);

      const [skillRows, reviewRows, hireRows, memoryRows, distRows, identityRows] =
        await Promise.all([
          db
            .select()
            .from(skills)
            .where(eq(skills.agentId, input.id))
            .orderBy(desc(skills.callCount)),
          db
            .select({
              review: reviews,
              enterpriseName: enterprises.name,
              enterpriseIndustry: enterprises.industry,
            })
            .from(reviews)
            .leftJoin(enterprises, eq(reviews.enterpriseId, enterprises.id))
            .where(eq(reviews.agentId, input.id))
            .orderBy(desc(reviews.createdAt))
            .limit(50),
          db
            .select({
              hire: agentHireRecords,
              enterpriseName: enterprises.name,
              enterpriseIndustry: enterprises.industry,
            })
            .from(agentHireRecords)
            .leftJoin(
              enterprises,
              eq(agentHireRecords.enterpriseId, enterprises.id),
            )
            .where(eq(agentHireRecords.agentId, input.id))
            .orderBy(desc(agentHireRecords.createdAt))
            .limit(50),
          db
            .select()
            .from(agentMemories)
            .where(eq(agentMemories.agentId, input.id))
            .orderBy(desc(agentMemories.createdAt))
            .limit(20),
          db
            .select({ rating: reviews.rating, count: sql<number>`count(*)` })
            .from(reviews)
            .where(eq(reviews.agentId, input.id))
            .groupBy(reviews.rating),
          // 数字员工链上身份卡（wb_evo_identities 按 agentId LEFT 关联，可空）
          db
            .select({
              did: wbEvoIdentities.did,
              issuedAt: wbEvoIdentities.createdAt,
            })
            .from(wbEvoIdentities)
            .where(eq(wbEvoIdentities.agentId, input.id))
            .limit(1),
        ]);

      const distTotal = distRows.reduce((a, d) => a + Number(d.count), 0);
      const distribution = [5, 4, 3, 2, 1].map((star) => {
        const hit = distRows.find((d) => d.rating === star);
        const count = hit ? Number(hit.count) : 0;
        return {
          star,
          count,
          pct: distTotal ? Math.round((count / distTotal) * 100) : 0,
        };
      });

      // v2026-09-05 脱假：无真实成交史不伪造 30 天走势——平直钉在当前价，
      // changePct=0，前端文案「开市首价·走势待真实成交积累」
      const history = (() => {
        const today = new Date();
        return Array.from({ length: 30 }, (_, i) => {
          const d = new Date(today.getTime() - (29 - i) * 86400_000);
          return { date: d.toISOString().slice(0, 10), price: row.agent.monthlyPrice };
        });
      })();
      const changePct = 0;

      // Harness H1 技能真实化审计：匠市 V/U 技能附加 executorKind/badge/realSuccessRate。
      // executorKind 取 skills.executorKind 列（sync-h1 同名继承 st_skills，无映射为 'generic'）；
      // 真实成功率按 st_skill_calls.skill_key = `agent_skill_${id}` 近 90 天口径，样本不足为 null。
      // 失败静默不阻断详情（metas 缺省时徽标按 executorKind 列值仍可得，成功率为 null）。
      let skillMetas: SkillMarketMeta[];
      try {
        skillMetas = await buildSkillMetas(
          skillRows.map((s) => ({
            rateKey: `agent_skill_${s.id}`,
            executorKind: s.executorKind ?? null,
          })),
        );
      } catch {
        skillMetas = skillRows.map((s) => ({
          executorKind: (s.executorKind ?? null) as SkillMarketMeta["executorKind"],
          badge: badgeOfKind((s.executorKind ?? null) as SkillMarketMeta["executorKind"]),
          realSuccessRate: null,
        }));
      }

      // iter96 诚信整改：详情页统计同样改用运行时真实值
      const realTasks = skillRows.reduce((a, s) => a + Number(s.callCount ?? 0), 0);
      const memCountRows = await db.execute(
        sql`SELECT COUNT(*) AS mc FROM agent_memories WHERE agentId = ${input.id}`,
      );
      const memCountList = ((memCountRows as unknown as Array<Array<{ mc: number | string }>>)[0]) ?? [];
      const realMem = Number(memCountList[0]?.mc ?? 0);
      const agent = {
        ...row.agent,
        tasksCompleted: realTasks,
        successRate: 0, // 无按 Agent 维度成功样本 → 前端显示「待验证」
        memoryCount: realMem,
      };

      return {
        agent,
        master: row.master,
        identity: identityRows[0] ?? null,
        skills: skillRows.map((s, i) => ({
          ...s,
          // Harness H1：徽标 + 真实成功率（前端不再展示种子 successRate=98）
          ...(skillMetas[i] ?? { executorKind: null, badge: "generative" as const, realSuccessRate: null }),
        })),
        reviews: reviewRows.map((r) => ({
          ...r.review,
          enterpriseName: r.enterpriseName,
          enterpriseIndustry: r.enterpriseIndustry,
        })),
        ratingDistribution: distribution,
        hireHistory: hireRows.map((r) => ({
          ...r.hire,
          enterpriseName: r.enterpriseName,
          enterpriseIndustry: r.enterpriseIndustry,
        })),
        memories: memoryRows,
        pricing: {
          history,
          changePct,
          suggestedPrice: row.agent.suggestedPrice,
          masterAdjustment: row.agent.monthlyPrice - row.agent.suggestedPrice,
        },
      };
      });
    }),

  /** 本周雇佣榜 Top N */
  leaderboard: publicQuery
    .input(
      z.object({ limit: z.number().int().min(1).max(20).default(5) }).optional(),
    )
    .query(async ({ input }) => {
      // iter85：本周雇佣榜公开只读，缓存 60s
      return cached(`agents:leaderboard:${input?.limit ?? 5}`, 60_000, async () => {
      const db = getDb();
      const rows = await db
        .select({ agent: agents, masterSignature: masters.signature })
        .from(agents)
        .leftJoin(masters, eq(agents.masterId, masters.id))
        // 波一钉：榜单只出在架（对齐 wb 仓 PR#21——双仓同源同闸，pending 候补不上墙）
        .where(eq(agents.status, "active"))
        .orderBy(desc(agents.weeklyHires))
        .limit(input?.limit ?? 5);
      return rows.map((r, i) => ({
        rank: i + 1,
        ...r.agent,
        masterSignature: r.masterSignature,
      }));
      });
    }),

  /** 匠市推荐 */
  recommended: publicQuery.query(async () => {
    // iter85：公开推荐位，缓存 60s
    return cached("agents:recommended", 60_000, async () => {
    const db = getDb();
    const rows = await db
      .select({ agent: agents, masterSignature: masters.signature })
      .from(agents)
      .leftJoin(masters, eq(agents.masterId, masters.id))
      .where(and(eq(agents.recommended, true), eq(agents.status, "active")))
      .orderBy(desc(agents.avgRating));
    return rows.map((r) => ({ ...r.agent, masterSignature: r.masterSignature }));
    });
  }),

  /** 相关推荐（详情页"雇主们还雇佣了"）：同行业优先，其次高评分 */
  related: publicQuery
    .input(
      z.object({
        id: z.number().int().positive(),
        limit: z.number().int().min(1).max(12).default(4),
      }),
    )
    .query(async ({ input }) => {
      // iter85：相关推荐公开只读，缓存 60s
      return cached(`agents:related:${input.id}:${input.limit}`, 60_000, async () => {
      const db = getDb();
      const [self] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, input.id))
        .limit(1);
      if (!self) throw new Error(`Agent ${input.id} 不存在`);
      const rows = await agentCards(
        and(eq(agents.status, "active"), sql`${agents.id} <> ${input.id}`),
      );
      rows.sort((a, b) => {
        const sameA = a.industry === self.industry ? 1 : 0;
        const sameB = b.industry === self.industry ? 1 : 0;
        return sameB - sameA || b.avgRating - a.avgRating;
      });
      return rows.slice(0, input.limit);
      });
    }),

  /** 行业与能力标签字典（筛选项用） */
  facets: publicQuery.query(async () => {
    // iter85：筛选字典公开只读，缓存 60s
    return cached("agents:facets", 60_000, async () => {
    const rows = await agentCards(eq(agents.status, "active"));
    const industries = [...new Set(rows.map((r) => r.industry))];
    const capabilities = [...new Set(rows.flatMap((r) => r.capabilityTags))];
    const prices = rows.map((r) => r.monthlyPrice);
    // 行业大类分组统计（全行业覆盖矩阵用）
    const groupCounts = new Map<string, number>();
    for (const r of rows) {
      const g = r.industryGroup || "工业制造";
      groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1);
    }
    const groups = [...groupCounts.entries()].map(([group, count]) => ({
      group,
      count,
    }));
    return {
      industries,
      capabilities,
      minPrice: prices.length ? Math.min(...prices) : 0,
      maxPrice: prices.length ? Math.max(...prices) : 0,
      groups,
    };
    });
  }),

  /** 搜索建议（输入实时联想） */
  suggest: publicQuery
    .input(z.object({ keyword: z.string().trim().min(1).max(64) }))
    .query(async ({ input }) => {
      const db = getDb();
      const kw = `%${input.keyword}%`;
      const rows = await db
        .select({
          id: agents.id,
          name: agents.name,
          code: agents.code,
          capabilityTags: agents.capabilityTags,
        })
        .from(agents)
        .where(
          or(
            like(agents.name, kw),
            like(agents.industry, kw),
            sql`JSON_SEARCH(${agents.capabilityTags}, 'one', ${`%${input.keyword}%`}) IS NOT NULL`,
          ),
        )
        .limit(4);
      return rows.map((r) => ({
        ...r,
        matchedSkill:
          r.capabilityTags.find((t) => t.includes(input.keyword)) ?? null,
      }));
    }),
});
