/**
 * developer —— 开发者生态：独立开发者注册 / 登录 / 作品上架 / 收益台账。
 *
 * 鉴权约定（与 wb 体系一致）：
 * - 所有 procedure 均为 publicQuery 声明，框架层无自动鉴权；
 *   token 仅在请求体字段传递，由 devMe(token) 显式校验。
 * - 密码哈希沿用 wb 用户相同的 scrypt 方案（salt:hash hex，node crypto）。
 * - authToken 为 48 hex，登录时重颁并覆盖（单点有效）。
 * - 管理端审核复用工作台管理会话：sessionMe(token) + role==='admin'
 *   （与 workbenchMarket.certifyAgent 相同的管理鉴权路径）。
 */
import { z } from "zod";
import { authTokenHash, authTokenPlaintextGuard } from "../auth/revocation"; // P3-6 落库哈希单点
import { INFRA_UNAVAILABLE_MESSAGE } from "../auth/identity"; // 掩面话术仓单点
import { logQueryErrorThrottled } from "../queries/rawRows"; // 惰性迁移失败留痕
import { randomBytes } from "node:crypto";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import {
  devAccounts,
  devListings,
  devEarnings,
  type DevAccount,
} from "@db/schema";
import { hashPassword, sessionMe, verifyPassword } from "./wbSession";

/** 业务层显式鉴权：按 authToken 查开发者账户（token 在请求体字段） */
async function devMe(token: string): Promise<DevAccount> {
  const db = getDb();
  const fp = authTokenHash(token); // P3-6 双轨读面（第四 token 族 dev_accounts 同纪律）：or 形单查双形（hash 支/明文支同索引面——并发迁移竞态同命中；明文支限非指纹形态=pass-the-hash 面封死；dev 存量 48hex 不误伤）
  let account: DevAccount | undefined;
  try {
    [account] = await db
      .select()
      .from(devAccounts)
      .where(or(eq(devAccounts.authToken, fp), and(eq(devAccounts.authToken, token), authTokenPlaintextGuard())))
      .limit(1);
  } catch (e) {
    // 掩面（原始 DrizzleQueryError message 内嵌全 SQL+绑定参数=明文 token 透客户端面封死——rawRows.test/sanitizeQueryError 文档钉的形态；
    //  无 errorFormatter，tRPC 默认逐字回——resolveWbUserByToken/identity authenticateAdmin 同口径）
    logQueryErrorThrottled("[developer] devMe 取行失败（infra/schema 漂移）", e);
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: INFRA_UNAVAILABLE_MESSAGE });
  }
  if (account && account.authToken === token) {
    void db.update(devAccounts).set({ authToken: fp }).where(and(eq(devAccounts.id, account.id), eq(devAccounts.authToken, token)))
      .catch((e: unknown) => logQueryErrorThrottled("[developer] authToken 惰性迁移失败", e)); // 迁移败不炸鉴权（命中明文支才迁——指纹支命中不白写）
  }
  if (!account || account.status !== "active") {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "token 无效或已过期" });
  }
  return account;
}

/** 管理端鉴权：复用工作台管理会话（nebula_auth 管理 token），role 必须为 admin */
async function requireAdmin(token: string) {
  const { user } = await sessionMe(token);
  if (user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "仅 admin 可执行该操作" });
  }
  return user;
}

/** 账户对外视图（不含 passwordHash / authToken） */
function accountView(a: DevAccount) {
  return {
    id: a.id,
    username: a.username,
    displayName: a.displayName,
    contact: a.contact,
    status: a.status,
    createdAt: a.createdAt,
  };
}

export const developerRouter = createRouter({
  /** register（public）：用户名查重 → 创建 active 账户 */
  register: publicQuery
    .input(
      z.object({
        username: z
          .string()
          .trim()
          .min(3)
          .max(64)
          .regex(/^[a-zA-Z0-9_]+$/, "用户名仅限字母/数字/下划线"),
        displayName: z.string().trim().min(1).max(64),
        password: z.string().min(6).max(128),
        contact: z.string().trim().max(128).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [dup] = await db
        .select({ id: devAccounts.id })
        .from(devAccounts)
        .where(eq(devAccounts.username, input.username))
        .limit(1);
      if (dup) {
        throw new TRPCError({ code: "CONFLICT", message: "用户名已被注册" });
      }
      await db.insert(devAccounts).values({
        username: input.username,
        passwordHash: hashPassword(input.password),
        displayName: input.displayName,
        contact: input.contact ?? null,
        status: "active",
      });
      return { ok: true as const };
    }),

  /** login（public）：scrypt 校验 + status active → 重颁 48hex authToken */
  login: publicQuery
    .input(
      z.object({
        username: z.string().trim().min(1).max(64),
        password: z.string().min(1).max(128),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [account] = await db
        .select()
        .from(devAccounts)
        .where(eq(devAccounts.username, input.username))
        .limit(1);
      if (
        !account ||
        account.status !== "active" ||
        !verifyPassword(input.password, account.passwordHash)
      ) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "用户名或密码错误",
        });
      }
      const token = randomBytes(24).toString("hex");
      await db
        .update(devAccounts)
        .set({ authToken: authTokenHash(token) }) // P3-6：落库只存指纹（返回面照发明文——bearer 语义不变）
        .where(eq(devAccounts.id, account.id));
      return {
        token,
        account: {
          id: account.id,
          username: account.username,
          displayName: account.displayName,
        },
      };
    }),

  /** me（query，需要 token）：账户 + 聚合统计 */
  me: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const db = getDb();
      const account = await devMe(input.token);
      const [stats] = await db
        .select({
          listingCount: sql<number>`count(*)`,
          totalRevenueToken: sql<number>`coalesce(sum(${devListings.revenueToken}), 0)`,
          totalUsage: sql<number>`coalesce(sum(${devListings.usageCount}), 0)`,
        })
        .from(devListings)
        .where(eq(devListings.devId, account.id));
      return {
        account: accountView(account),
        stats: {
          listingCount: Number(stats?.listingCount ?? 0),
          totalRevenueToken: Number(stats?.totalRevenueToken ?? 0),
          totalUsage: Number(stats?.totalUsage ?? 0),
        },
      };
    }),

  /** uploadListing（mutation，需要 token）：插入 status=pending_review */
  uploadListing: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        kind: z.enum(["agent", "skill"]),
        name: z.string().trim().min(2).max(64),
        summary: z.string().trim().max(256).optional(),
        category: z.string().trim().max(32).optional(),
        priceToken: z.number().int().min(0).max(1_000_000),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const account = await devMe(input.token);
      const [{ id }] = await db
        .insert(devListings)
        .values({
          devId: account.id,
          kind: input.kind,
          name: input.name,
          summary: input.summary ?? null,
          category: input.category ?? null,
          priceToken: input.priceToken,
          status: "pending_review",
        })
        .$returningId();
      return { ok: true as const, id };
    }),

  /** myListings（query，需要 token）：本人全部上架，createdAt desc */
  myListings: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const db = getDb();
      const account = await devMe(input.token);
      return db
        .select()
        .from(devListings)
        .where(eq(devListings.devId, account.id))
        .orderBy(desc(devListings.createdAt));
    }),

  /** myEarnings（query，需要 token）：收益总额 + 最近 100 条流水（关联作品名） */
  myEarnings: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const db = getDb();
      const account = await devMe(input.token);
      const [agg] = await db
        .select({
          total: sql<number>`coalesce(sum(${devEarnings.amountToken}), 0)`,
        })
        .from(devEarnings)
        .where(eq(devEarnings.devId, account.id));
      const rows = await db
        .select({
          id: devEarnings.id,
          listingId: devEarnings.listingId,
          listingName: devListings.name,
          amountToken: devEarnings.amountToken,
          source: devEarnings.source,
          note: devEarnings.note,
          createdAt: devEarnings.createdAt,
        })
        .from(devEarnings)
        .leftJoin(devListings, eq(devEarnings.listingId, devListings.id))
        .where(eq(devEarnings.devId, account.id))
        .orderBy(desc(devEarnings.createdAt))
        .limit(100);
      return { total: Number(agg?.total ?? 0), rows };
    }),

  /**
   * adminListings（query，管理鉴权）：
   * 待审队列（pending_review 全部）+ 最近 50 条全部状态上架（含开发者 displayName）
   */
  adminListings: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      const baseSelect = {
        listing: devListings,
        devName: devAccounts.displayName,
        devUsername: devAccounts.username,
      };
      const pending = await db
        .select(baseSelect)
        .from(devListings)
        .leftJoin(devAccounts, eq(devListings.devId, devAccounts.id))
        .where(eq(devListings.status, "pending_review"))
        .orderBy(desc(devListings.createdAt));
      const recent = await db
        .select(baseSelect)
        .from(devListings)
        .leftJoin(devAccounts, eq(devListings.devId, devAccounts.id))
        .orderBy(desc(devListings.createdAt))
        .limit(50);
      const shape = (r: {
        listing: typeof devListings.$inferSelect;
        devName: string | null;
        devUsername: string | null;
      }) => ({ ...r.listing, devName: r.devName, devUsername: r.devUsername });
      return {
        pending: pending.map(shape),
        recent: recent.map(shape),
      };
    }),

  /**
   * adminReviewListing（mutation，管理鉴权）：
   * approve → status='listed' + listedAt=now；reject → status='rejected'
   */
  adminReviewListing: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        listingId: z.number().int().positive(),
        action: z.enum(["approve", "reject"]),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      const [listing] = await db
        .select({ id: devListings.id, status: devListings.status })
        .from(devListings)
        .where(eq(devListings.id, input.listingId))
        .limit(1);
      if (!listing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "上架作品不存在" });
      }
      if (listing.status !== "pending_review") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "仅待审核（pending_review）状态可执行审核",
        });
      }
      if (input.action === "approve") {
        await db
          .update(devListings)
          .set({ status: "listed", listedAt: new Date() })
          .where(
            and(
              eq(devListings.id, input.listingId),
              eq(devListings.status, "pending_review"),
            ),
          );
      } else {
        await db
          .update(devListings)
          .set({ status: "rejected" })
          .where(
            and(
              eq(devListings.id, input.listingId),
              eq(devListings.status, "pending_review"),
            ),
          );
      }
      return { ok: true as const };
    }),
});
