/**
 * admin —— NumX Max 超级终端服务端路由（迭代 17 Stage 3，admin 构建变体）。
 *
 * 与门户 / 工作台共享同一 MySQL 库（统一数据源），本路由只读现有表；
 * 禁用语义所需的 wb_users.disabled / wb_factories.disabled 两列为 additive 加列，
 * 由 db/sync-admin.mts 幂等补齐（本文件通过 raw SQL 访问，未改 drizzle schema）。
 *
 * 鉴权约定（沿用工作台体系）：
 * - 所有 procedure 输入都携带 { token, ... }（token 只在请求体，绝不在 header）；
 * - 服务端按 wb_users.authToken 匹配并校验 role === 'admin'，否则 UNAUTHORIZED「需要管理员权限」；
 * - 管理后台登录入口仍走 agentic.authLogin，由前端校验 role==='admin'。
 */
import { probeDeep } from "../lib/probeDeep"; // 深健康探测共享单点（portal#42 票③）
import { z } from "zod";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import {
  agents,
  agentHireRecords,
  devAccounts,
  devListings,
  enterprises,
  recruitmentApplications,
  recruitments,
  tokenTransactions,
  wbFactories,
  wbListings,
  wbUsers,
} from "@db/schema";
import { hashPassword, resolveWbUserByToken} from "./wbSession";
import { invalidate } from "./perfCache";
import { ADMIN_DELEGATE_USERNAMES, requireHqAdmin, scopedCountExcludingTests } from "./terminal";
import { rawRows } from "../queries/rawRows"; // 共享件直引（SYNC_LOCK 同轨件——本地副本摘[A 堆对齐①]；OCR R9：直引 canonical 不背本地副本）
import { dbProbeTimed } from "../queries/healthProbe"; // P1-4：DB 自检共享件
import { parseDbUtc } from "./dbTime";
import { PLAN_TIERS } from "./billing";

const tokenInput = z.object({ token: z.string().trim().min(1) });

const pageInput = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});

const ADMIN_REQUIRED = "需要管理员权限";


/**
 * 管理员鉴权：token → wb_users.authToken 匹配 + role==='admin'；
 * disabled 列存在且为 1 时同样拒绝（列不存在则忽略，保持向后兼容）。
 * 迭代 39：委派回退——指定 COO/CMO 负责人账号（terminal.ADMIN_DELEGATE_USERNAMES）
 * 持 staff token 同样放行，displayName 标注「委派管理员」留痕。
 * M65：导出供回归闸直测（nt_ 踢出事故修复的集成验证），行为零变化。
 */
export async function requireAdmin(token: string) {
  const db = getDb();
  const user = await resolveWbUserByToken(db, token); // portal#86 必修：明文直读→双轨单点（指纹迁移行可读面封死）
  if (user && user.role === "admin") {
    try {
      const rows = rawRows(
        await db.execute(sql`SELECT disabled FROM wb_users WHERE id = ${user.id} LIMIT 1`),
      );
      if (rows[0] && Number(rows[0].disabled) === 1) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: ADMIN_REQUIRED });
      }
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      // disabled 列尚未由 sync-admin.mts 补齐：忽略，不阻断登录
    }
    return user;
  }
  const staffRows = rawRows(
    await db.execute(
      sql`SELECT id, username, displayName, role, disabled FROM st_staff_accounts
          WHERE authToken = ${token} AND username IN (${sql.join(
            ADMIN_DELEGATE_USERNAMES.map((u) => sql`${u}`),
            sql`, `,
          )})
          LIMIT 1`,
    ),
  );
  const staff = staffRows[0];
  if (staff && Number(staff.disabled) !== 1 && String(staff.role) === "head") {
    return {
      id: Number(staff.id),
      username: String(staff.username),
      displayName: `${String(staff.displayName)}（委派管理员）`,
      role: "admin",
      delegated: true,
    } as unknown as NonNullable<typeof user>; // 双轨单点后型含 undefined——委派/原生支窄化出（TS18048 同族面封死）
  }
  // M64 第三层回退：超终原生账号（st_admin_accounts，nt_ token）。
  // 缺本层曾致 nt_ 会话打开 admin.overview 即 401 → 前端全局清会话被踢回登录页（M65 事故修复）。
  try {
    const { findNativeAdminByToken } = await import("./adminAuth");
    const native = await findNativeAdminByToken(token);
    if (native && Number(native.disabled) !== 1) {
      return {
        id: Number(native.id),
        username: String(native.username),
        displayName: `${String(native.displayName)}（超终）`,
        role: "admin",
        delegated: true,
        adminOrigin: "native",
      } as unknown as NonNullable<typeof user>; // 双轨单点后型含 undefined——委派/原生支窄化出（TS18048 同族面封死）
    }
  } catch (err) {
    if (err instanceof TRPCError) throw err;
    // st_admin_accounts 未建表时静默跳过（迁移前行为零变化）
  }
  throw new TRPCError({ code: "UNAUTHORIZED", message: ADMIN_REQUIRED });
}

async function countOf(query: Promise<Array<{ count: number | string | bigint }>>) {
  const [row] = await query;
  return Number(row?.count ?? 0);
}

/** 批量取 wb_users.disabled（列缺失时返回空表，由调用方兜底为 0） */
async function fetchUserDisabled(ids: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (ids.length === 0) return map;
  try {
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT id, disabled FROM wb_users WHERE id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      ),
    );
    for (const r of rows) map.set(Number(r.id), Number(r.disabled ?? 0));
  } catch {
    // 列未初始化：全部视为未禁用
  }
  return map;
}

/** 批量取 wb_factories.disabled（同上兜底） */
async function fetchFactoryDisabled(ids: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (ids.length === 0) return map;
  try {
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT id, disabled FROM wb_factories WHERE id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      ),
    );
    for (const r of rows) map.set(Number(r.id), Number(r.disabled ?? 0));
  } catch {
    // 列未初始化：全部视为未禁用
  }
  return map;
}

const DISABLED_COLUMN_HINT =
  "禁用字段未初始化，请先在服务器执行 db/sync-admin.mts 后再操作";



export const adminRouter = createRouter({
  // ─── 总览 KPI ────────────────────────────────────────────────────────────
  /** intentSignals（query, admin）：意图信号面（P2-6 递归自优化内环 sense——彭总令 2026-10-05 路线 B；
   *  R2 票④ 方向修正：读 st_evo_signals 的 spirit_* kind（递归 loop 的 sense 聚合源——loop.ts 在吃），
   *  不读新建死表；spirit_miss/spirit_intent/radar_miss 等精灵系 kind 入面）。
   *  近 24h 按 kind+action 聚合＋近 20 条流；三读并行（R2 票①：Promise.all 单往返）；
   *  表/查询异常回落空面（不炸面板——R2 票③：happy+空面两路径有测试钉）。 */
  intentSignals: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    try {
      const [aggRes, feedRes, totalRes] = await Promise.all([
        // 票①：ok 判定走 JSON_UNQUOTE='false' 字符串比较（JSON 值 vs SQL 标量类型优先级不可靠）；票⑤：miss 类落 'miss' 防分组坍缩
        getDb().execute(
          sql`SELECT kind, COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.action')), CASE WHEN kind LIKE '%\\_miss' THEN 'miss' ELSE '' END) AS action,
                     COUNT(*) AS cnt, SUM(kind LIKE '%\\_miss' OR JSON_UNQUOTE(JSON_EXTRACT(payload,'$.ok'))='false') AS fails,
                     AVG(JSON_EXTRACT(payload,'$.latencyMs')) AS avgMs
              FROM st_evo_signals
              WHERE created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
                AND kind IN ('spirit_intent','spirit_miss','radar_miss')
              GROUP BY kind, action ORDER BY cnt DESC LIMIT 12`,
        ),
        getDb().execute(
          sql`SELECT id, actor, kind,
                     COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.action')), CASE WHEN kind LIKE '%\\_miss' THEN 'miss' ELSE '' END) AS action, -- 票⑤：miss 类无 action 字段——落 'miss' 防分组坍缩
                     CASE WHEN kind LIKE '%\\_miss' THEN 0 WHEN JSON_UNQUOTE(JSON_EXTRACT(payload,'$.ok'))='false' THEN 0 ELSE 1 END AS ok,
                     JSON_EXTRACT(payload,'$.latencyMs') AS latencyMs,
                     COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.target')), JSON_UNQUOTE(JSON_EXTRACT(payload,'$.message')), '') AS detail,
                     created_at AS createdAt
              FROM st_evo_signals
              WHERE kind IN ('spirit_intent','spirit_miss','radar_miss')
                AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
              ORDER BY id DESC LIMIT 20`, // R2 票②：feed 同 24h 窗（与聚合/空面闸语义一致）
        ),
        getDb().execute(
          sql`SELECT COUNT(*) AS total FROM st_evo_signals
              WHERE created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
                AND kind IN ('spirit_intent','spirit_miss','radar_miss')`,
        ),
      ]);
      const agg = rawRows(aggRes) as unknown as { kind: string; action: string; cnt: number; fails: number; avgMs: number | null }[];
      const feed = rawRows(feedRes);
      const totalRows = rawRows(totalRes) as unknown as { total: number }[];
      return { agg, feed, total24h: Number(totalRows[0]?.total ?? 0) }; // 总数独立查询（agg LIMIT 12 截断不低估）
    } catch (err) {
      console.error("[admin.intentSignals] 意图信号查询失败，回落空面:", err instanceof Error ? err.message : String(err)); // 票④：失败留痕（空面不等于无声）
      return { agg: [], feed: [], total24h: 0 }; // 表未建/查询异常 → 空面（不炸面板）
    }
  }),

  overview: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const db = getDb();

    const [
      userTotal,
      enterpriseUserTotal,
      personUserTotal,
      factoryTotal,
      agentTotal,
      agentStatusRows,
      hireOrderTotal,
      openRecruitmentTotal,
      pendingDevListings,
      pendingWbListings,
      tokenFlowRow,
    ] = await Promise.all([
      scopedCountExcludingTests('wb_users', 'username'),
      scopedCountExcludingTests('wb_users', 'username', 'enterprise'),
      scopedCountExcludingTests('wb_users', 'username', 'person'),
      scopedCountExcludingTests('wb_factories', 'enterpriseName'),
      countOf(db.select({ count: sql<number>`count(*)` }).from(agents)),
      db
        .select({ status: agents.status, count: sql<number>`count(*)` })
        .from(agents)
        .groupBy(agents.status),
      countOf(db.select({ count: sql<number>`count(*)` }).from(agentHireRecords)),
      countOf(
        db
          .select({ count: sql<number>`count(*)` })
          .from(recruitments)
          .where(eq(recruitments.status, "open")),
      ),
      countOf(
        db
          .select({ count: sql<number>`count(*)` })
          .from(devListings)
          .where(eq(devListings.status, "pending_review")),
      ),
      countOf(
        db
          .select({ count: sql<number>`count(*)` })
          .from(wbListings)
          .where(eq(wbListings.status, "pending")),
      ),
      db
        .select({
          total: sql<number | string | null>`coalesce(sum(amount), 0)`,
          platformFee: sql<number | string | null>`coalesce(sum(platformFee), 0)`,
        })
        .from(tokenTransactions),
    ]);

    const agentStatusDist: Record<string, number> = {};
    for (const row of agentStatusRows) agentStatusDist[row.status] = Number(row.count);

    return {
      userTotal,
      enterpriseUserTotal,
      personUserTotal,
      factoryTotal,
      agentTotal,
      agentStatusDist,
      hireOrderTotal,
      openRecruitmentTotal,
      pendingListingTotal: Number(pendingDevListings) + Number(pendingWbListings),
      tokenFlowTotal: Number(tokenFlowRow[0]?.total ?? 0),
      tokenPlatformFeeTotal: Number(tokenFlowRow[0]?.platformFee ?? 0),
    };
  }),

  // ─── 用户管理 ────────────────────────────────────────────────────────────
  usersList: publicQuery
    .input(
      tokenInput.extend({
        ...pageInput.shape,
        search: z.string().trim().max(64).optional(),
      }),
    )
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      const where = input.search
        ? or(
            like(wbUsers.username, `%${input.search}%`),
            like(wbUsers.phone, `%${input.search}%`),
            like(wbUsers.displayName, `%${input.search}%`),
          )
        : undefined;
      const [rows, total] = await Promise.all([
        db
          .select({
            id: wbUsers.id,
            username: wbUsers.username,
            phone: wbUsers.phone,
            displayName: wbUsers.displayName,
            kind: wbUsers.kind,
            role: wbUsers.role,
            factoryId: wbUsers.factoryId,
            createdAt: wbUsers.createdAt,
          })
          .from(wbUsers)
          .where(where)
          .orderBy(desc(wbUsers.id))
          .limit(input.pageSize)
          .offset((input.page - 1) * input.pageSize),
        countOf(db.select({ count: sql<number>`count(*)` }).from(wbUsers).where(where)),
      ]);
      const disabledMap = await fetchUserDisabled(rows.map((r) => r.id));
      return {
        total,
        page: input.page,
        pageSize: input.pageSize,
        items: rows.map((r) => ({ ...r, disabled: disabledMap.get(r.id) ?? 0 })),
      };
    }),

  userSetRole: publicQuery
    .input(
      tokenInput.extend({
        userId: z.number().int().positive(),
        role: z.enum(["admin", "owner", "member"]),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      if (admin.id === input.userId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "不能修改自己的角色" });
      }
      const db = getDb();
      await db.update(wbUsers).set({ role: input.role }).where(eq(wbUsers.id, input.userId));
      return { ok: true as const };
    }),

  userSetDisabled: publicQuery
    .input(
      tokenInput.extend({
        userId: z.number().int().positive(),
        disabled: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      if (admin.id === input.userId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "不能禁用自己的账号" });
      }
      const db = getDb();
      try {
        if (input.disabled) {
          // 禁用的同时清空 authToken，强制现有会话失效
          await db.execute(
            sql`UPDATE wb_users SET disabled = 1, authToken = NULL WHERE id = ${input.userId}`,
          );
        } else {
          await db.execute(
            sql`UPDATE wb_users SET disabled = 0 WHERE id = ${input.userId}`,
          );
        }
      } catch {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: DISABLED_COLUMN_HINT });
      }
      return { ok: true as const };
    }),

  userResetPassword: publicQuery
    .input(
      tokenInput.extend({
        userId: z.number().int().positive(),
        newPassword: z.string().min(8, "新密码至少 8 位").max(128),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      // 重置密码（scrypt salt:hash，与 agentic.ts 同一算法），并清空会话强制重登
      await db
        .update(wbUsers)
        .set({ passwordHash: hashPassword(input.newPassword), authToken: null })
        .where(eq(wbUsers.id, input.userId));
      return { ok: true as const };
    }),

  // ─── 企业管理 ────────────────────────────────────────────────────────────
  factoriesList: publicQuery
    .input(
      tokenInput.extend({
        ...pageInput.shape,
        search: z.string().trim().max(64).optional(),
      }),
    )
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      const where = input.search
        ? or(
            like(wbFactories.enterpriseName, `%${input.search}%`),
            like(wbFactories.industry, `%${input.search}%`),
          )
        : undefined;
      const [rows, total, memberCounts] = await Promise.all([
        db.select().from(wbFactories).where(where).orderBy(desc(wbFactories.id))
          .limit(input.pageSize).offset((input.page - 1) * input.pageSize),
        countOf(db.select({ count: sql<number>`count(*)` }).from(wbFactories).where(where)),
        db
          .select({ factoryId: wbUsers.factoryId, count: sql<number>`count(*)` })
          .from(wbUsers)
          .groupBy(wbUsers.factoryId),
      ]);
      const countMap = new Map(memberCounts.map((r) => [r.factoryId, Number(r.count)]));
      const disabledMap = await fetchFactoryDisabled(rows.map((r) => r.id));
      return {
        total,
        page: input.page,
        pageSize: input.pageSize,
        items: rows.map((f) => ({
          id: f.id,
          enterpriseName: f.enterpriseName,
          industry: f.industry,
          industryGroup: f.industryGroup,
          industryText: f.industryText,
          headcount: f.headcount,
          departments: f.departments,
          creditCode: f.creditCode,
          verifyStatus: f.verifyStatus,
          verifiedAt: f.verifiedAt,
          verifyPayload: f.verifyPayload,
          createdAt: f.createdAt,
          userCount: countMap.get(f.id) ?? 0,
          disabled: disabledMap.get(f.id) ?? 0,
        })),
      };
    }),

  // 迭代 90：人工核验企业（approve → verified，payload 记 manualBy/manualAt；reject → mismatch）。
  adminVerifyFactory: publicQuery
    .input(
      tokenInput.extend({
        factoryId: z.number().int().positive(),
        action: z.enum(["approve", "reject"]),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const db = getDb();
      const [factory] = await db
        .select({
          id: wbFactories.id,
          verifyPayload: wbFactories.verifyPayload,
        })
        .from(wbFactories)
        .where(eq(wbFactories.id, input.factoryId))
        .limit(1);
      if (!factory) {
        throw new TRPCError({ code: "NOT_FOUND", message: "企业不存在" });
      }
      if (input.action === "approve") {
        await db
          .update(wbFactories)
          .set({
            verifyStatus: "verified",
            verifiedAt: new Date(),
            verifyPayload: {
              ...(factory.verifyPayload ?? {}),
              manualBy: admin.displayName ?? admin.username,
              manualAt: new Date().toISOString(),
            },
          })
          .where(eq(wbFactories.id, input.factoryId));
      } else {
        await db
          .update(wbFactories)
          .set({ verifyStatus: "mismatch" })
          .where(eq(wbFactories.id, input.factoryId));
      }
      return { ok: true as const };
    }),

  factorySetDisabled: publicQuery
    .input(
      tokenInput.extend({
        factoryId: z.number().int().positive(),
        disabled: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      if (admin.factoryId === input.factoryId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "不能禁用当前管理员所属企业" });
      }
      const db = getDb();
      try {
        await db.execute(
          sql`UPDATE wb_factories SET disabled = ${input.disabled ? 1 : 0} WHERE id = ${input.factoryId}`,
        );
      } catch {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: DISABLED_COLUMN_HINT });
      }
      if (input.disabled) {
        // 禁用企业时清空旗下全部账号会话
        await db
          .update(wbUsers)
          .set({ authToken: null })
          .where(eq(wbUsers.factoryId, input.factoryId));
      }
      return { ok: true as const };
    }),

  // ─── 数字员工管理 ────────────────────────────────────────────────────────
  agentsList: publicQuery
    .input(
      tokenInput.extend({
        ...pageInput.shape,
        status: z.enum(["pending", "active", "suspended", "rejected"]).optional(),
        industryGroup: z.string().trim().max(32).optional(),
        search: z.string().trim().max(64).optional(),
      }),
    )
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      const conds = [
        input.status ? eq(agents.status, input.status) : undefined,
        input.industryGroup ? eq(agents.industryGroup, input.industryGroup) : undefined,
        input.search
          ? or(
              like(agents.name, `%${input.search}%`),
              like(agents.code, `%${input.search}%`),
              like(agents.slug, `%${input.search}%`),
            )
          : undefined,
      ].filter((c): c is NonNullable<typeof c> => Boolean(c));
      const where = conds.length > 0 ? and(...conds) : undefined;
      const [rows, total] = await Promise.all([
        db
          .select({
            id: agents.id,
            code: agents.code,
            name: agents.name,
            slug: agents.slug,
            industry: agents.industry,
            industryGroup: agents.industryGroup,
            status: agents.status,
            masterId: agents.masterId,
            monthlyPrice: agents.monthlyPrice,
            createdAt: agents.createdAt,
          })
          .from(agents)
          .where(where)
          .orderBy(desc(agents.id))
          .limit(input.pageSize)
          .offset((input.page - 1) * input.pageSize),
        countOf(db.select({ count: sql<number>`count(*)` }).from(agents).where(where)),
      ]);
      return { total, page: input.page, pageSize: input.pageSize, items: rows };
    }),

  agentSetStatus: publicQuery
    .input(
      tokenInput.extend({
        agentId: z.number().int().positive(),
        status: z.enum(["active", "suspended", "rejected"]),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      await db.update(agents).set({ status: input.status }).where(eq(agents.id, input.agentId));
      // iter85：上下架影响匠市列表/详情，失效 agents 缓存
      invalidate("agents:");
      return { ok: true as const };
    }),

  // ─── 招募单 / 应征审核 ───────────────────────────────────────────────────
  recruitmentsList: publicQuery
    .input(
      tokenInput.extend({
        ...pageInput.shape,
        status: z.enum(["open", "filled", "closed"]).optional(),
        search: z.string().trim().max(64).optional(),
      }),
    )
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      const conds = [
        input.status ? eq(recruitments.status, input.status) : undefined,
        input.search ? like(recruitments.title, `%${input.search}%`) : undefined,
      ].filter((c): c is NonNullable<typeof c> => Boolean(c));
      const where = conds.length > 0 ? and(...conds) : undefined;
      const [rows, total] = await Promise.all([
        db
          .select({
            id: recruitments.id,
            title: recruitments.title,
            industry: recruitments.industry,
            budgetMonthly: recruitments.budgetMonthly,
            periodMonths: recruitments.periodMonths,
            urgent: recruitments.urgent,
            status: recruitments.status,
            createdAt: recruitments.createdAt,
            enterpriseName: enterprises.name,
          })
          .from(recruitments)
          .leftJoin(enterprises, eq(recruitments.enterpriseId, enterprises.id))
          .where(where)
          .orderBy(desc(recruitments.id))
          .limit(input.pageSize)
          .offset((input.page - 1) * input.pageSize),
        countOf(db.select({ count: sql<number>`count(*)` }).from(recruitments).where(where)),
      ]);
      return { total, page: input.page, pageSize: input.pageSize, items: rows };
    }),

  recruitmentSetStatus: publicQuery
    .input(
      tokenInput.extend({
        recruitmentId: z.number().int().positive(),
        status: z.enum(["open", "closed"]),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      await db
        .update(recruitments)
        .set({ status: input.status })
        .where(eq(recruitments.id, input.recruitmentId));
      return { ok: true as const };
    }),

  applicationsList: publicQuery
    .input(
      tokenInput.extend({
        ...pageInput.shape,
        status: z.enum(["pending", "accepted", "rejected"]).optional(),
      }),
    )
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      const where = input.status
        ? eq(recruitmentApplications.status, input.status)
        : undefined;
      const [rows, total] = await Promise.all([
        db
          .select({
            id: recruitmentApplications.id,
            recruitmentId: recruitmentApplications.recruitmentId,
            message: recruitmentApplications.message,
            status: recruitmentApplications.status,
            decidedAt: recruitmentApplications.decidedAt,
            createdAt: recruitmentApplications.createdAt,
            recruitmentTitle: recruitments.title,
            agentName: agents.name,
            agentCode: agents.code,
          })
          .from(recruitmentApplications)
          .leftJoin(recruitments, eq(recruitmentApplications.recruitmentId, recruitments.id))
          .leftJoin(agents, eq(recruitmentApplications.agentId, agents.id))
          .where(where)
          .orderBy(desc(recruitmentApplications.id))
          .limit(input.pageSize)
          .offset((input.page - 1) * input.pageSize),
        countOf(
          db
            .select({ count: sql<number>`count(*)` })
            .from(recruitmentApplications)
            .where(where),
        ),
      ]);
      return { total, page: input.page, pageSize: input.pageSize, items: rows };
    }),

  applicationSetStatus: publicQuery
    .input(
      tokenInput.extend({
        applicationId: z.number().int().positive(),
        status: z.enum(["accepted", "rejected"]),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      await db
        .update(recruitmentApplications)
        .set({ status: input.status, decidedAt: new Date() })
        .where(eq(recruitmentApplications.id, input.applicationId));
      return { ok: true as const };
    }),

  // ─── 雇佣订单（只读）──────────────────────────────────────────────────────
  hireOrdersList: publicQuery
    .input(tokenInput.extend({ ...pageInput.shape }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      const [rows, total] = await Promise.all([
        db
          .select({
            id: agentHireRecords.id,
            periodMonths: agentHireRecords.periodMonths,
            monthlyPrice: agentHireRecords.monthlyPrice,
            status: agentHireRecords.status,
            tasksCompleted: agentHireRecords.tasksCompleted,
            startedAt: agentHireRecords.startedAt,
            endsAt: agentHireRecords.endsAt,
            createdAt: agentHireRecords.createdAt,
            agentName: agents.name,
            agentCode: agents.code,
            enterpriseName: enterprises.name,
          })
          .from(agentHireRecords)
          .leftJoin(agents, eq(agentHireRecords.agentId, agents.id))
          .leftJoin(enterprises, eq(agentHireRecords.enterpriseId, enterprises.id))
          .orderBy(desc(agentHireRecords.id))
          .limit(input.pageSize)
          .offset((input.page - 1) * input.pageSize),
        countOf(db.select({ count: sql<number>`count(*)` }).from(agentHireRecords)),
      ]);
      return { total, page: input.page, pageSize: input.pageSize, items: rows };
    }),

  // ─── Token 流水（只读 + 汇总）────────────────────────────────────────────
  tokenFlowsList: publicQuery
    .input(
      tokenInput.extend({
        ...pageInput.shape,
        type: z
          .enum([
            "hire_commission",
            "skill_call",
            "trial_skill_call",
            "trial_reward",
            "price_adjustment",
          ])
          .optional(),
      }),
    )
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      const where = input.type ? eq(tokenTransactions.type, input.type) : undefined;
      const [rows, total, summary] = await Promise.all([
        db
          .select({
            id: tokenTransactions.id,
            type: tokenTransactions.type,
            amount: tokenTransactions.amount,
            platformFee: tokenTransactions.platformFee,
            masterShare: tokenTransactions.masterShare,
            note: tokenTransactions.note,
            createdAt: tokenTransactions.createdAt,
            agentName: agents.name,
            enterpriseName: enterprises.name,
          })
          .from(tokenTransactions)
          .leftJoin(agents, eq(tokenTransactions.agentId, agents.id))
          .leftJoin(enterprises, eq(tokenTransactions.enterpriseId, enterprises.id))
          .where(where)
          .orderBy(desc(tokenTransactions.id))
          .limit(input.pageSize)
          .offset((input.page - 1) * input.pageSize),
        countOf(
          db.select({ count: sql<number>`count(*)` }).from(tokenTransactions).where(where),
        ),
        db
          .select({
            amount: sql<number | string | null>`coalesce(sum(amount), 0)`,
            platformFee: sql<number | string | null>`coalesce(sum(platformFee), 0)`,
          })
          .from(tokenTransactions)
          .where(where),
      ]);
      return {
        total,
        page: input.page,
        pageSize: input.pageSize,
        items: rows,
        summary: {
          amountTotal: Number(summary[0]?.amount ?? 0),
          platformFeeTotal: Number(summary[0]?.platformFee ?? 0),
        },
      };
    }),

  // ─── 开发者上架审核 ──────────────────────────────────────────────────────
  devListingsList: publicQuery
    .input(
      tokenInput.extend({
        ...pageInput.shape,
        status: z.enum(["pending_review", "listed", "rejected", "delisted"]).optional(),
        search: z.string().trim().max(64).optional(),
      }),
    )
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      const conds = [
        input.status ? eq(devListings.status, input.status) : undefined,
        input.search ? like(devListings.name, `%${input.search}%`) : undefined,
      ].filter((c): c is NonNullable<typeof c> => Boolean(c));
      const where = conds.length > 0 ? and(...conds) : undefined;
      const [rows, total] = await Promise.all([
        db
          .select({
            id: devListings.id,
            kind: devListings.kind,
            name: devListings.name,
            summary: devListings.summary,
            category: devListings.category,
            priceToken: devListings.priceToken,
            status: devListings.status,
            usageCount: devListings.usageCount,
            revenueToken: devListings.revenueToken,
            createdAt: devListings.createdAt,
            devUsername: devAccounts.username,
            devDisplayName: devAccounts.displayName,
          })
          .from(devListings)
          .leftJoin(devAccounts, eq(devListings.devId, devAccounts.id))
          .where(where)
          .orderBy(desc(devListings.id))
          .limit(input.pageSize)
          .offset((input.page - 1) * input.pageSize),
        countOf(db.select({ count: sql<number>`count(*)` }).from(devListings).where(where)),
      ]);
      return { total, page: input.page, pageSize: input.pageSize, items: rows };
    }),

  devListingSetStatus: publicQuery
    .input(
      tokenInput.extend({
        listingId: z.number().int().positive(),
        status: z.enum(["listed", "pending_review", "rejected"]),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      await db
        .update(devListings)
        .set(
          input.status === "listed"
            ? { status: input.status, listedAt: new Date() }
            : { status: input.status },
        )
        .where(eq(devListings.id, input.listingId));
      return { ok: true as const };
    }),

  // ─── 系统健康（门户 / 工作台 / 数据库）───────────────────────────────────
  systemHealth: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const portalUrl = process.env.PORTAL_URL ?? "https://downloads.example.invalid";
    const workbenchUrl = process.env.WORKBENCH_URL ?? "https://wb.example.invalid";

    const database = await dbProbeTimed(); // R24 票②：计时包装走 dbProbeTimed 单点（不再两处手写）

    // 两个公开 URL 并行探测，单个失败不拖垮整体
    const [portal, workbench] = await Promise.all([
      probeDeep(portalUrl),
      probeDeep(workbenchUrl),
    ]);
    return { portal, workbench, database };
  }),

  // ─── iter91 龙虾租户化 · 白名单审批 / tier 管理 / 军团总览 ────────────────
  /** clawWhitelistPending（query, admin）：全部 pending 白名单申请（带 factoryId + 企业名） */
  clawWhitelistPending: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT w.id, w.factory_id AS factoryId, w.domain, w.status,
                   w.submitted_by AS submittedBy, w.created_at AS createdAt,
                   f.enterpriseName
            FROM st_claw_domain_whitelist w
            LEFT JOIN wb_factories f ON f.id = w.factory_id
            WHERE w.status = 'pending'
            ORDER BY w.id ASC LIMIT 100`,
      ),
    );
    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        factoryId: r.factoryId === null || r.factoryId === undefined ? null : Number(r.factoryId),
        enterpriseName: r.enterpriseName ? String(r.enterpriseName) : null,
        domain: String(r.domain),
        status: String(r.status),
        submittedBy: r.submittedBy ? String(r.submittedBy) : null,
        createdAt: r.createdAt ? String(r.createdAt) : null,
      })),
    };
  }),

  /** clawWhitelistApprove（mutation, admin）：批准/驳回白名单申请，留痕 approved_by=admin 名 */
  clawWhitelistApprove: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        id: z.number().int().positive(),
        approve: z.boolean(),
        reason: z.string().trim().max(200).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const name = `admin:${String(admin.username)}`;
      const next = input.approve ? "approved" : "rejected";
      await getDb().execute(
        sql`UPDATE st_claw_domain_whitelist
            SET status = ${next}, approved_by = ${name}, approved_at = NOW()
            WHERE id = ${input.id} AND status = 'pending'`,
      );
      const rows = rawRows(
        await getDb().execute(
          sql`SELECT status FROM st_claw_domain_whitelist WHERE id = ${input.id} LIMIT 1`,
        ),
      );
      if (!rows[0] || String(rows[0].status) !== next) {
        throw new TRPCError({ code: "CONFLICT", message: "该申请已处理或不存在，请刷新列表" });
      }
      return { ok: true as const, id: input.id, status: next, message: input.approve ? "已批准，域名即时生效" : `已驳回${input.reason ? `（${input.reason}）` : ""}` };
    }),

  /** clawTierSet（mutation, admin）：设定企业龙虾分级（upsert），并把对应 tier-upgrade 待办单置 done */
  clawTierSet: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        factoryId: z.number().int().positive(),
        tier: z.enum(["l0", "l1", "l2", "l3"]),
        note: z.string().trim().max(255).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const name = `admin:${String(admin.username)}`;
      await getDb().execute(
        sql`INSERT INTO st_factory_claw_tier (factory_id, tier, note, opened_by, opened_at)
            VALUES (${input.factoryId}, ${input.tier}, ${input.note ?? null}, ${name}, NOW())
            ON DUPLICATE KEY UPDATE tier = VALUES(tier), note = VALUES(note), opened_by = VALUES(opened_by)`,
      );
      // 对应升舱申请单闭环：pending → done
      await getDb().execute(
        sql`UPDATE st_claw_operations
            SET status = 'done', approved_by = ${name}, approved_at = NOW(), finished_at = NOW(),
                reply = ${`平台已开通 ${input.tier}`}
            WHERE factory_id = ${input.factoryId} AND task = ${`tier-upgrade:${input.tier}`}
              AND status = 'pending' AND approval_level = 'l3_platform'`,
      );
      return { ok: true as const, factoryId: input.factoryId, tier: input.tier };
    }),

  /** clawTierList（query, admin）：全部企业分级（含未开通企业默认 l0，join wb_factories 名称） */
  clawTierList: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT f.id AS factoryId, f.enterpriseName, f.industryGroup,
                   t.tier, t.note, t.opened_by AS openedBy, t.opened_at AS openedAt, t.updated_at AS updatedAt
            FROM wb_factories f
            LEFT JOIN st_factory_claw_tier t ON t.factory_id = f.id
            ORDER BY f.id ASC LIMIT 500`,
      ),
    );
    return {
      items: rows.map((r) => ({
        factoryId: Number(r.factoryId),
        enterpriseName: String(r.enterpriseName),
        industryGroup: r.industryGroup ? String(r.industryGroup) : null,
        tier: r.tier ? String(r.tier) : "l0",
        note: r.note ? String(r.note) : null,
        openedBy: r.openedBy ? String(r.openedBy) : null,
        openedAt: r.openedAt ? String(r.openedAt) : null,
        updatedAt: r.updatedAt ? String(r.updatedAt) : null,
      })),
    };
  }),

  /** corpsList（query, admin）：全平台熊猫军团总览（join wb_factories 名称） */
  corpsList: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT c.id, c.factory_id AS factoryId, f.enterpriseName, c.name, c.industry,
                   c.status, c.member_count AS memberCount, c.train_pass_rate AS trainPassRate,
                   c.created_at AS createdAt, c.graduated_at AS graduatedAt, c.deployed_at AS deployedAt
            FROM st_corps c
            LEFT JOIN wb_factories f ON f.id = c.factory_id
            ORDER BY c.id DESC LIMIT 200`,
      ),
    );
    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        factoryId: Number(r.factoryId),
        enterpriseName: r.enterpriseName ? String(r.enterpriseName) : null,
        name: String(r.name),
        industry: String(r.industry),
        status: String(r.status),
        memberCount: Number(r.memberCount),
        trainPassRate: r.trainPassRate === null || r.trainPassRate === undefined ? null : Number(r.trainPassRate),
        createdAt: r.createdAt ? String(r.createdAt) : null,
        graduatedAt: r.graduatedAt ? String(r.graduatedAt) : null,
        deployedAt: r.deployedAt ? String(r.deployedAt) : null,
      })),
    };
  }),

  // ─── iter92 计费套餐管理 ─────────────────────────────────────────────────
  /** planSet（mutation, admin）：档位映射 basic=3/200、pro=8/1000、flagship=20/5000；
   *  upsert + expire_at=NOW()+days，status='active' */
  planSet: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      factoryId: z.number().int().positive(),
      planCode: z.enum(["basic", "pro", "flagship"]),
      days: z.number().int().min(1).max(3650),
    }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const tier = PLAN_TIERS[input.planCode];
      const expireAt = new Date(Date.now() + input.days * 24 * 3600 * 1000)
        .toISOString().slice(0, 19).replace("T", " ");
      await getDb().execute(
        sql`INSERT INTO st_factory_plan (factory_id, plan_code, seat_limit, llm_daily_limit, status, expire_at)
            VALUES (${input.factoryId}, ${input.planCode}, ${tier.seatLimit}, ${tier.llmDailyLimit}, 'active', ${expireAt})
            ON DUPLICATE KEY UPDATE plan_code = VALUES(plan_code), seat_limit = VALUES(seat_limit),
              llm_daily_limit = VALUES(llm_daily_limit), status = 'active', expire_at = VALUES(expire_at)`,
      );
      return {
        ok: true as const,
        factoryId: input.factoryId,
        planCode: input.planCode,
        seatLimit: tier.seatLimit,
        llmDailyLimit: tier.llmDailyLimit,
        status: "active" as const,
        expireAt,
      };
    }),

  /** sandboxMonitor（query, admin·iter97）：全平台沙箱训练监考大盘（跨厂聚合，厂名掩码匿名） */
  sandboxMonitor: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const factories = rawRows(
      await getDb().execute(
        sql`SELECT s.factory_id AS factoryId,
                   COUNT(*) AS taskTotal,
                   SUM(CASE WHEN s.status='done' THEN 1 ELSE 0 END) AS doneTotal,
                   SUM(CASE WHEN s.status='failed' THEN 1 ELSE 0 END) AS failedTotal,
                   SUM(s.pass) AS passTotal,
                   MAX(s.created_at) AS lastAt
            FROM st_sandbox_tasks s GROUP BY s.factory_id ORDER BY taskTotal DESC LIMIT 200`,
      ),
    );
    const grads = rawRows(
      await getDb().execute(
        sql`SELECT factory_id AS factoryId, COUNT(*) AS graduatedSkills FROM st_sandbox_skills WHERE graduated = 1 GROUP BY factory_id`,
      ),
    );
    const gradMap = new Map(grads.map((g) => [Number(g.factoryId), Number(g.graduatedSkills)]));
    const items = factories.map((f) => {
      const fid = Number(f.factoryId);
      const taskTotal = Number(f.taskTotal ?? 0);
      const passTotal = Number(f.passTotal ?? 0);
      return {
        factoryRef: `厂#${fid}`, // 监考视图掩码匿名，不暴露企业名
        taskTotal,
        doneTotal: Number(f.doneTotal ?? 0),
        failedTotal: Number(f.failedTotal ?? 0),
        passRate: taskTotal > 0 ? Math.round((passTotal / taskTotal) * 1000) / 10 : 0,
        graduatedSkills: gradMap.get(fid) ?? 0,
        lastAt: f.lastAt ?? null,
        alert: Number(f.failedTotal ?? 0) >= 3 ? '连续失败需关注' : (taskTotal >= 10 && passTotal / taskTotal < 0.6 ? '通过率偏低' : null),
      };
    });
    return { items, factoryCount: items.length };
  }),

  /** planList（query, admin）：全厂套餐 + 今日用量（join wb_factories；过期动态视为 past_due，不写库） */
  planList: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT f.id AS factoryId, f.enterpriseName, f.industryGroup,
                   p.plan_code AS planCode, p.seat_limit AS seatLimit, p.llm_daily_limit AS llmDailyLimit,
                   p.status, p.expire_at AS expireAt, p.updated_at AS updatedAt,
                   COALESCE(u.calls, 0) AS llmUsedToday
            FROM wb_factories f
            LEFT JOIN st_factory_plan p ON p.factory_id = f.id
            LEFT JOIN st_llm_usage_factory_daily u ON u.factory_id = f.id AND u.day = CURDATE()
            ORDER BY f.id ASC LIMIT 500`,
      ),
    );
    const now = Date.now();
    return {
      items: rows.map((r) => {
        const hasPlan = r.planCode !== null && r.planCode !== undefined;
        let status = hasPlan ? String(r.status) : null;
        if (hasPlan && status === "active" && r.expireAt) {
          const exp = parseDbUtc(r.expireAt);
          if (Number.isFinite(exp) && exp < now) status = "past_due"; // 动态判定，不写库
        }
        return {
          factoryId: Number(r.factoryId),
          enterpriseName: String(r.enterpriseName),
          industryGroup: r.industryGroup ? String(r.industryGroup) : null,
          planCode: hasPlan ? String(r.planCode) : null,
          seatLimit: hasPlan ? Number(r.seatLimit) : null,
          llmDailyLimit: hasPlan ? Number(r.llmDailyLimit) : null,
          llmUsedToday: Number(r.llmUsedToday),
          status,
          expireAt: r.expireAt ? String(r.expireAt) : null,
          updatedAt: r.updatedAt ? String(r.updatedAt) : null,
        };
      }),
    };
  }),

  // ─── iter92 告警日志 ─────────────────────────────────────────────────────
  /** alertLog（query, admin）：近 100 条告警（st_alert_log 倒序） */
  alertLog: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT id, level, event, payload, sent_ok AS sentOk, created_at AS createdAt
            FROM st_alert_log ORDER BY id DESC LIMIT 100`,
      ),
    );
    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        level: String(r.level),
        event: String(r.event),
        payload: r.payload ? String(r.payload) : null,
        sentOk: Number(r.sentOk) === 1,
        createdAt: r.createdAt ? String(r.createdAt) : null,
      })),
    };
  }),

  // ─── iter92 技能市场审核 ─────────────────────────────────────────────────
  /** marketPending（query, 本厂闸）：待审核技能（含来源厂，仅平台 HQ 可见——跨厂隔离验收修复） */
  marketPending: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireHqAdmin(input.token);
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT m.id, m.skill_key AS skillKey, m.title, m.industry, m.description,
                   m.source_factory_id AS sourceFactoryId, f.enterpriseName AS sourceEnterpriseName,
                   m.price_tokens AS priceTokens, m.status, m.created_at AS createdAt
            FROM st_skill_market m
            LEFT JOIN wb_factories f ON f.id = m.source_factory_id
            WHERE m.status = 'pending'
            ORDER BY m.id ASC LIMIT 200`,
      ),
    );
    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        skillKey: String(r.skillKey),
        title: String(r.title),
        industry: String(r.industry),
        description: r.description ? String(r.description) : null,
        sourceFactoryId: Number(r.sourceFactoryId),
        sourceEnterpriseName: r.sourceEnterpriseName ? String(r.sourceEnterpriseName) : null,
        priceTokens: Number(r.priceTokens),
        status: String(r.status),
        createdAt: r.createdAt ? String(r.createdAt) : null,
      })),
    };
  }),

  /** marketApprove（mutation, 本厂闸）：approve=true → listed（listed_at=NOW()）；false → rejected（平台审核权仅 HQ——跨厂隔离验收修复） */
  marketApprove: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      id: z.number().int().positive(),
      approve: z.boolean(),
    }))
    .mutation(async ({ input }) => {
      await requireHqAdmin(input.token);
      const next = input.approve ? "listed" : "rejected";
      await getDb().execute(
        input.approve
          ? sql`UPDATE st_skill_market SET status = 'listed', listed_at = NOW()
                WHERE id = ${input.id} AND status = 'pending'`
          : sql`UPDATE st_skill_market SET status = 'rejected'
                WHERE id = ${input.id} AND status = 'pending'`,
      );
      return { ok: true as const, id: input.id, status: next };
    }),
});
