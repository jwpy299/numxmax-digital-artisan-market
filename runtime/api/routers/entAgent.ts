/**
 * entAgent —— 企业版造人工坊+企业店铺（2026-08-27 彭总令）。
 *
 * 口径：
 * - 造人：行业模板 + 喂经验（SOP/话术/工单引用）+ 挂本厂自定义部门（x_ 码）；
 * - 上架闸：实习达标（同个人版口径）+ industry 类必过合规审（法务牙齿）；
 * - 厂牌连坐：员工评分<3.0 → strike+1，≥3 次曝光档降 limited（全厂降曝光）；
 * - factoryId 服务端会话口径，跨厂永不可见；企业角色 admin/manager 才可操作。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { effectiveRoleOf, sessionMe } from "./wbSession";
import { complianceCheck } from "../harness/autonomy";
import { AVATAR_PRESETS, TEMPLATE_ACCESSORIES, generateAvatar } from "./avatarService";
import { rawRows } from "../queries/rawRows"; // 战区④批A-lite：私有副本退役→canonical 叶单源

const tokenInput = { token: z.string().trim().min(1) };


// ─── 厂牌纯规则（可测） ─────────────────────────────────────────────────────
export const BRAND = {
  STRIKE_SCORE: 3.0,
  STRIKE_LIMIT: 3,
  TEMPLATES: ["cs", "sales", "finance", "inspect", "custom"] as const,
};
export type EntTemplate = (typeof BRAND.TEMPLATES)[number];

export function isValidTemplate(t: string): t is EntTemplate {
  return (BRAND.TEMPLATES as readonly string[]).includes(t);
}
export function exposureAfterStrike(strikes: number): "normal" | "limited" {
  return strikes >= BRAND.STRIKE_LIMIT ? "limited" : "normal";
}
/** industry 类上架是否需合规审（enterprise 职能类免审但仍过关键词牙齿） */
export function needsComplianceReview(marketClass: string): boolean {
  return marketClass === "industry";
}

async function requireEntAdmin(token: string) {
  const session = await sessionMe(token);
  const role = await effectiveRoleOf(session.user);
  if (role !== "admin" && role !== "manager") {
    throw new TRPCError({ code: "FORBIDDEN", message: "仅企业管理员可操作造人工坊" });
  }
  return session;
}

export const entAgentRouter = createRouter({
  /** 造人工坊列表（本厂全部员工+厂牌） */
  myWorkshop: publicQuery.input(z.object(tokenInput)).query(async ({ input }) => {
    const session = await sessionMe(input.token);
    const db = getDb();
    const agents = rawRows(
      await db.execute(
        sql`SELECT id, name, template, market_class AS marketClass, dept_code AS deptCode, status,
                   hire_score AS hireScore, list_price AS listPrice, compliance_state AS complianceState, listed_at AS listedAt
            FROM st_ent_agents WHERE factory_id=${session.factory.id} ORDER BY id DESC`,
      ),
    );
    const brand = rawRows(
      await db.execute(sql`SELECT brand_score AS brandScore, listed_count AS listedCount, strike_count AS strikeCount, exposure_tier AS exposureTier FROM st_factory_brand WHERE factory_id=${session.factory.id} LIMIT 1`),
    );
    // v176 续约倒计时（企业工作台优化③：北极星 C 校验的前置预警）——本厂合约 7 天内到期的列出
    let renewals: { id: number; agentName: string; daysLeft: number; endsAt: string }[] = [];
    try {
      renewals = rawRows(
        await db.execute(
          sql`SELECT r.id, a.name AS agentName, TIMESTAMPDIFF(DAY, NOW(), r.endsAt) AS daysLeft, DATE_FORMAT(r.endsAt, '%m-%d') AS endsAt
              FROM agent_hire_records r JOIN agents a ON a.id = r.agentId
              WHERE r.enterpriseId=${session.factory.id} AND r.status IN ('trial','active') AND r.endsAt <= DATE_ADD(NOW(), INTERVAL 7 DAY)
              ORDER BY r.endsAt ASC LIMIT 5`,
        ),
      ) as typeof renewals;
    } catch { /* 表缺失静默 */ }
    // v176 本厂 vs 全城（企业工作台优化①）：本城点亮总量做参照系
    let cityRef: { city: string | null; enterprises: number } | null = null;
    try {
      const fac = rawRows(await db.execute(sql`SELECT city FROM wb_factories WHERE id=${session.factory.id} LIMIT 1`))[0];
      const city = fac?.city ? String(fac.city) : null;
      if (city) {
        const c = rawRows(await db.execute(sql`SELECT COUNT(*) AS c FROM wb_factories WHERE disabled=0 AND city=${city}`))[0];
        cityRef = { city, enterprises: Number(c?.c ?? 0) };
      }
    } catch { /* 静默 */ }
    return { agents, brand: brand[0] ?? null, renewals, cityRef };
  }),

  /** 造人（模板+名称；经验随后喂） */
  craft: publicQuery
    .input(z.object({
      ...tokenInput,
      name: z.string().trim().min(2).max(16),
      template: z.string().trim(),
      marketClass: z.enum(["enterprise", "industry"]).default("industry"),
      deptCode: z.string().trim().toLowerCase().optional(),
    }))
    .mutation(async ({ input }) => {
      const session = await requireEntAdmin(input.token);
      if (!isValidTemplate(input.template)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `模板须为 ${BRAND.TEMPLATES.join("/")} 之一` });
      }
      if (input.deptCode) {
        const dept = rawRows(
          await getDb().execute(sql`SELECT dept_code FROM st_dept_consoles WHERE factory_id=${session.factory.id} AND dept_code=${input.deptCode} AND dept_code LIKE 'x\\_%' LIMIT 1`),
        );
        if (!dept[0]) throw new TRPCError({ code: "NOT_FOUND", message: "本厂无此自定义部门（先在编制里创建）" });
      }
      const ins = await getDb().execute(
        sql`INSERT INTO st_ent_agents (factory_id, name, template, market_class, dept_code)
            VALUES (${session.factory.id}, ${input.name}, ${input.template}, ${input.marketClass}, ${input.deptCode ?? null})`,
      );
      const first = Array.isArray(ins) ? (ins as unknown[])[0] : ins;
      const agentId = Number((first as { insertId?: number })?.insertId ?? 0);
      // v152 企业分身形象：厂牌琥珀皮 + 职业配饰（模板即穿）
      void generateAvatar(`ea-${agentId}`, {
        ...AVATAR_PRESETS.ent_amber,
        accessories: TEMPLATE_ACCESSORIES[input.template] ?? [],
      });
      return { ok: true as const, agentId };
    }),

  /** 喂经验（SOP/话术/工单引用挂入分身记忆源） */
  feedExperience: publicQuery
    .input(z.object({ ...tokenInput, agentId: z.number().int().positive(), refs: z.array(z.string().max(128)).max(20) }))
    .mutation(async ({ input }) => {
      const session = await requireEntAdmin(input.token);
      const own = rawRows(await getDb().execute(sql`SELECT id FROM st_ent_agents WHERE id=${input.agentId} AND factory_id=${session.factory.id} LIMIT 1`));
      if (!own[0]) throw new TRPCError({ code: "NOT_FOUND", message: "员工不存在或非本厂" });
      await getDb().execute(sql`UPDATE st_ent_agents SET experience_refs=${JSON.stringify(input.refs)} WHERE id=${input.agentId}`);
      return { ok: true as const, count: input.refs.length };
    }),

  /** 上架申请（实习达标+industry 合规审+关键词牙齿） */
  applyListing: publicQuery
    .input(z.object({ ...tokenInput, agentId: z.number().int().positive(), price: z.number().int().min(1).max(1000000) }))
    .mutation(async ({ input }) => {
      const session = await requireEntAdmin(input.token);
      const db = getDb();
      const a = rawRows(
        await db.execute(sql`SELECT id, name, template, market_class AS mc, status, hire_score AS score FROM st_ent_agents WHERE id=${input.agentId} AND factory_id=${session.factory.id} LIMIT 1`),
      )[0];
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "员工不存在或非本厂" });
      // 关键词牙齿（G4 复用：资金/数据/对外文案命中即拒）
      const verdict = complianceCheck(`${String(a.template)} ${String(a.name)}`);
      if (!verdict.pass) {
        throw new TRPCError({ code: "FORBIDDEN", message: `合规拦截（${verdict.hits.map((h) => h.reason).join("、")}）` });
      }
      const intern = rawRows(await db.execute(sql`SELECT COUNT(*) AS c FROM st_delivery_acceptances WHERE task_ref=${`ea:${input.agentId}`}`));
      const internTasks = Number(intern[0]?.c ?? 0);
      if (internTasks < 10 || (a.score != null && Number(a.score) < 4.2)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `未达上架标准：需实习单≥10 且评分≥4.2（当前 ${internTasks} 单/${a.score ?? "暂无评分"}）` });
      }
      // industry 类必须合规审 approved 才放行
      if (needsComplianceReview(String(a.mc))) {
        const cur = rawRows(await db.execute(sql`SELECT compliance_state AS cs FROM st_ent_agents WHERE id=${input.agentId} LIMIT 1`));
        if (String(cur[0]?.cs) !== "approved") {
          await db.execute(sql`UPDATE st_ent_agents SET compliance_state='pending' WHERE id=${input.agentId}`);
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "行业方案类须法务合规审通过后方可上架（已提交审核）" });
        }
      }
      await db.execute(sql`UPDATE st_ent_agents SET status='listed', list_price=${input.price}, listed_at=NOW() WHERE id=${input.agentId}`);
      await db.execute(
        sql`INSERT INTO st_factory_brand (factory_id, listed_count) VALUES (${session.factory.id}, 1)
            ON DUPLICATE KEY UPDATE listed_count=listed_count+1`,
      );
      return { ok: true as const, status: "listed" as const };
    }),

  /** 厂牌连坐评估（环/手动）：低评员工记 strike，达限降曝光 */
  evaluateBrand: publicQuery.input(z.object(tokenInput)).mutation(async ({ input }) => {
    const session = await requireEntAdmin(input.token);
    const db = getDb();
    const bad = rawRows(
      await db.execute(sql`SELECT COUNT(*) AS c FROM st_ent_agents WHERE factory_id=${session.factory.id} AND status='listed' AND hire_score < ${BRAND.STRIKE_SCORE} AND hire_score IS NOT NULL`),
    );
    const strikes = Number(bad[0]?.c ?? 0);
    const tier = exposureAfterStrike(strikes);
    await db.execute(
      sql`INSERT INTO st_factory_brand (factory_id, strike_count, exposure_tier) VALUES (${session.factory.id}, ${strikes}, ${tier})
          ON DUPLICATE KEY UPDATE strike_count=${strikes}, exposure_tier=${tier}`,
    );
    return { ok: true as const, strikes, exposureTier: tier };
  }),
});
