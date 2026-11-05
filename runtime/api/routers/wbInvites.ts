/**
 * wbInvites —— M16 组织邀请（一次性邀请码，iv_+48hex）。
 *
 * 纪律（与 wb_tickets/wb_publish_keys 同构）：
 * - 明文邀请码仅 create 响应返回一次、accept/peek 入参携带；库中只存 sha256，绝不落盘/输出明文或 codeHash；
 * - 已登录接口 token 在请求体（框架层无自动鉴权，业务层 requireWbRole/sessionMe 校验）；
 * - peek / accept 为设计内公开口：凭码即权柄（码即一次性密钥），无效/过期/已用/吊销统一 valid:false，不泄露原因。
 */
import { z } from "zod";
import { authTokenHash } from "../auth/revocation"; // portal#86 必修：指纹写单点同引
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { wbInvites, wbUsers, wbFactories, wbDeptHeads, type WbInvite } from "@db/schema";
import {
  effectiveRoleOf,
  hashPassword,
  newCredential,
  requireDeptScope, requireWbRole,
  sessionInfo,
  sessionMe,
  sha256,
  resolveWbUserByToken,
} from "./wbSession"; // portal#86 必修：双轨解析单点同引
import { recordCareerEvent } from "./wbCareer";

const INVITE_INVALID = "邀请链接无效或已使用";
const INVITE_REVOKE_DENIED = "仅企业负责人可吊销邀请";
const INVITE_LIST_DENIED = "仅企业负责人或部门负责人可查看邀请列表";
const INVITE_RATE_DENIED = "操作太频繁，请稍后再试";

/** create 限频：每企业 60s 内最多创建 20 个邀请（DB 计数，重启不丢） */
export const WB_INVITE_CREATE_LIMIT = 20;
const INVITE_RATE_WINDOW_MS = 60_000;

const tokenInput = { token: z.string().trim().min(1) };
const codeInput = z
  .string()
  .trim()
  .regex(/^iv_[0-9a-f]{48}$/, "邀请码格式不正确");

/** 邀请状态（一次性语义：consumed > revoked > expired > pending） */
function inviteStatus(inv: WbInvite, now: Date): "pending" | "consumed" | "revoked" | "expired" {
  if (inv.consumedAt) return "consumed";
  if (inv.revokedAt) return "revoked";
  if (new Date(inv.expiresAt).getTime() <= now.getTime()) return "expired";
  return "pending";
}

/** 列表输出行（绝不包含 code/codeHash；manager 脱敏 inviterName） */
function inviteRow(
  inv: WbInvite,
  deptName: string | null,
  inviterName: string | null,
  now: Date,
) {
  return {
    inviteId: inv.id,
    displayName: inv.displayName,
    deptId: inv.deptId,
    deptName,
    role: inv.role,
    status: inviteStatus(inv, now),
    expiresAt: inv.expiresAt,
    createdAt: inv.createdAt,
    inviterName,
  };
}

export const wbInvitesRouter = createRouter({
  /**
   * create（mutation，admin+目标部门负责人——彭总 2026-10-15 闸开+角色后果闸成对）：生成一次性邀请。
   * 幂等防重：同企业同 displayName+deptId 存在未消耗/未吊销邀请 → BAD_REQUEST。
   * 明文 iv_+48hex 仅本次响应返回；库写 sha256。默认 72h 有效（24~168h 可配）。
   */
  create: publicQuery
    .input(
      z.object({
        ...tokenInput,
        displayName: z.string().trim().min(1).max(64),
        deptId: z.string().trim().min(1).max(64),
        role: z.enum(["manager", "staff"]),
        ttlHours: z.number().int().min(24).max(168).default(72),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      // 闸开（彭总 2026-10-15 令——HR/部门负责人邀请个人入舱做法；wb#83 同形搬入）：requireDeptScope=admin 直通+manager 邀进本部门
      // （staff/跨部门=FORBIDDEN——服务端真闸）
      const { user: inviter, factory } = await requireDeptScope(input.token, input.deptId);
      // 权限后果闸（NumX portal#63 记录③：放闸必须成对搬——单放 requireDeptScope 不搬本闸=经理可任命经理的洞原样复现）：
      // role:'manager' 邀请=任命部门负责人（accept 双写 wb_dept_heads）=权限授予面仅 admin 可签；manager 只能签 role:'staff'
      const inviterRole = await effectiveRoleOf(inviter);
      if (input.role === "manager" && inviterRole !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "任命部门负责人需企业负责人签发" });
      }
      const dept = factory.departments.find((d) => d.id === input.deptId);
      if (!dept) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "deptId 必须是企业画像中的真实部门",
        });
      }
      const [dup] = await db
        .select({ id: wbInvites.id })
        .from(wbInvites)
        .where(
          and(
            eq(wbInvites.factoryId, factory.id),
            eq(wbInvites.displayName, input.displayName),
            eq(wbInvites.deptId, input.deptId),
            isNull(wbInvites.consumedAt),
            isNull(wbInvites.revokedAt),
          ),
        )
        .limit(1);
      if (dup) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "该成员在此部门已有未使用的邀请，请先吊销或待其过期",
        });
      }
      // 限频（DB 计数，重启不丢）：本企业 60s 内 ≥20 个邀请 → TOO_MANY_REQUESTS。
      // 放在角色/参数/幂等校验之后：被拒的无效请求不占配额，计数行与 wbPair.open 同模式。
      const since = new Date(Date.now() - INVITE_RATE_WINDOW_MS);
      const recent = await db
        .select({ count: sql<number>`count(*)` })
        .from(wbInvites)
        .where(and(eq(wbInvites.factoryId, factory.id), gte(wbInvites.createdAt, since)));
      if (Number(recent[0]?.count ?? 0) >= WB_INVITE_CREATE_LIMIT) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: INVITE_RATE_DENIED });
      }
      const code = newCredential("iv_"); // 明文仅此一处，随响应返回一次
      const expiresAt = new Date(Date.now() + input.ttlHours * 3600_000);
      const [{ id: inviteId }] = await db
        .insert(wbInvites)
        .values({
          factoryId: factory.id,
          codeHash: sha256(code),
          displayName: input.displayName,
          deptId: input.deptId,
          role: input.role,
          inviterId: inviter.id,
          expiresAt,
        })
        .$returningId();
      return {
        inviteId,
        code, // 明文仅本次
        inviteUrl: `/wb/invite?code=${code}`,
        displayName: input.displayName,
        deptId: input.deptId,
        deptName: dept.name,
        role: input.role,
        expiresAt,
      };
    }),

  /**
   * list（query）：admin 看本企业全量；manager 自动收敛本部门且脱敏（不见 inviterName）；
   * staff 拒绝。任何输出都不含 code/codeHash。
   */
  list: publicQuery
    .input(z.object({ ...tokenInput, deptId: z.string().trim().min(1).max(64).optional() }))
    .query(async ({ input }) => {
      const db = getDb();
      const { user: caller, factory } = await sessionMe(input.token);
      const role = await effectiveRoleOf(caller);
      if (role === "staff") {
        throw new TRPCError({ code: "FORBIDDEN", message: INVITE_LIST_DENIED });
      }
      // manager 数据范围强制收敛本部门（跨部门入参忽略，不泄露其他部门存在性）
      const deptFilter = role === "admin" ? input.deptId : (caller.departmentId ?? "__none__");
      const rows = await db
        .select()
        .from(wbInvites)
        .where(
          deptFilter
            ? and(eq(wbInvites.factoryId, factory.id), eq(wbInvites.deptId, deptFilter))
            : eq(wbInvites.factoryId, factory.id),
        );
      const inviterNameOf = new Map<number, string>();
      if (role === "admin" && rows.length > 0) {
        const inviterIds = [...new Set(rows.map((r) => r.inviterId))];
        const inviters = await db
          .select({ id: wbUsers.id, displayName: wbUsers.displayName })
          .from(wbUsers)
          .where(eq(wbUsers.factoryId, factory.id));
        for (const u of inviters) {
          if (inviterIds.includes(u.id)) inviterNameOf.set(u.id, u.displayName);
        }
      }
      const deptName = (id: string) =>
        factory.departments.find((d) => d.id === id)?.name ?? null;
      const now = new Date();
      return rows
        .map((inv) =>
          inviteRow(inv, deptName(inv.deptId), inviterNameOf.get(inv.inviterId) ?? null, now),
        )
        .sort((a, b) => b.inviteId - a.inviteId);
    }),

  /**
   * revoke（mutation，仅 admin）：吊销待使用邀请。同企业校验；幂等（已吊销返回 ok:true）。
   */
  revoke: publicQuery
    .input(z.object({ ...tokenInput, inviteId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const { factory } = await requireWbRole(input.token, ["admin"], INVITE_REVOKE_DENIED);
      const [inv] = await db
        .select()
        .from(wbInvites)
        .where(and(eq(wbInvites.id, input.inviteId), eq(wbInvites.factoryId, factory.id)))
        .limit(1);
      if (!inv) {
        throw new TRPCError({ code: "NOT_FOUND", message: "邀请不存在" });
      }
      if (inv.revokedAt) {
        return { ok: true as const, inviteId: inv.id }; // 幂等：重复吊销
      }
      if (inv.consumedAt) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "邀请已被使用，不可吊销" });
      }
      await db.update(wbInvites).set({ revokedAt: new Date() }).where(eq(wbInvites.id, inv.id));
      return { ok: true as const, inviteId: inv.id };
    }),

  /**
   * peek（query，公开）：落地页预填。无效/过期/已用/吊销统一 valid:false，不泄露原因细节。
   */
  peek: publicQuery.input(z.object({ code: codeInput })).query(async ({ input }) => {
    const db = getDb();
    const [inv] = await db
      .select()
      .from(wbInvites)
      .where(eq(wbInvites.codeHash, sha256(input.code)))
      .limit(1);
    if (!inv || inviteStatus(inv, new Date()) !== "pending") {
      return { valid: false as const };
    }
    const [factory] = await db
      .select()
      .from(wbFactories)
      .where(eq(wbFactories.id, inv.factoryId))
      .limit(1);
    if (!factory) {
      return { valid: false as const };
    }
    return {
      valid: true as const,
      enterpriseName: factory.enterpriseName,
      displayName: inv.displayName,
      deptName: factory.departments.find((d) => d.id === inv.deptId)?.name ?? null,
      role: inv.role,
      expiresAt: inv.expiresAt,
    };
  }),

  /**
   * accept（mutation，公开，一次性）：两条路径——
   * - 无 token（公开注册）：设密码激活并自动登录（签发 nt_ token）。
   *   流程：码校验 → 用户名/手机号查重 → 单事务内【原子置 consumedAt（含 expiresAt>NOW() 防过期
   *   TOCTOU，影响行=0 → CONFLICT）→ 建 wb_users（role=邀请角色、invitedBy/activatedAt 审计）
   *   → manager 双写 wb_dept_heads → join 履历钩子 → 签发 nt_】，任一步失败整体回滚，无孤立行。
   * - 有 token（已登录个人账号入企，M22）：sessionMe 对 factoryId=0 的游离个人会因无 factory
   *   行抛 UNAUTHORIZED，故按 authMe/sessionUpgrade 同模式直接以 authToken 取用户；
   *   已在企业（factoryId≠0）→ CONFLICT 且不消费码。单事务内【身份复核（先于码消费——无效
   *   入企尝试不烧码，失败整体回滚）→ 原子置 consumedAt → 原子落编 wb_users（WHERE factoryId=0
   *   兜底并发重复入企）→ manager 双写 wb_dept_heads → join 履历钩子】；不签发新 token，
   *   原 token 继续有效（响应 token 字段原样回传，与 sessionInfo 同构便于 App saveWbSession）。
   */
  accept: publicQuery
    .input(
      z.object({
        code: codeInput,
        token: z.string().trim().min(1).optional(),
        username: z.string().trim().min(2).max(64).optional(),
        password: z.string().min(8, "密码至少 8 位").max(128).optional(),
        phone: z
          .string()
          .trim()
          .regex(/^1[3-9]\d{9}$/, "手机号格式不正确")
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [inv] = await db
        .select()
        .from(wbInvites)
        .where(eq(wbInvites.codeHash, sha256(input.code)))
        .limit(1);
      if (!inv || inviteStatus(inv, new Date()) !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: INVITE_INVALID });
      }
      const [factory] = await db
        .select()
        .from(wbFactories)
        .where(eq(wbFactories.id, inv.factoryId))
        .limit(1);
      if (!factory) {
        throw new TRPCError({ code: "BAD_REQUEST", message: INVITE_INVALID });
      }
      const deptName = factory.departments.find((d) => d.id === inv.deptId)?.name ?? null;
      const activatedAt = new Date();

      // ── token 分支：已登录个人账号（factoryId=0 游离态）入企 ─────────────────
      if (input.token) {
        const person = await resolveWbUserByToken(db, input.token); // portal#86 必修：明文直读→双轨单点
        if (!person) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "token 无效或已过期" });
        }
        // 预检：已在企业中 → CONFLICT，不进入事务、码不被消耗
        if (person.factoryId !== 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "你已在企业中，如需换企业请先离职",
          });
        }
        const userId = person.id;
        try {
          await db.transaction(async (tx) => {
            // 事务内身份复核先行（消费判定在身份校验之后）：预检→置位窗口内并发入企的
            // 败方在此拦截；失败整体回滚，邀请码不被消耗（不烧码）。
            const [me] = await tx
              .select({ id: wbUsers.id, factoryId: wbUsers.factoryId })
              .from(wbUsers)
              .where(eq(wbUsers.id, userId))
              .limit(1);
            if (!me || me.factoryId !== 0) {
              throw new TRPCError({
                code: "CONFLICT",
                message: "你已在企业中，如需换企业请先离职",
              });
            }
            // 原子置 consumedAt：一次性消费，并发抢用/过期败方影响行=0 → CONFLICT
            const upd = await tx.execute(
              sql`UPDATE wb_invites SET consumedAt = NOW() WHERE id = ${inv.id} AND consumedAt IS NULL AND revokedAt IS NULL AND expiresAt > NOW()`,
            );
            const affected = Number(
              (upd[0] as { affectedRows?: number | string } | undefined)?.affectedRows ?? 0,
            );
            if (affected !== 1) {
              throw new TRPCError({
                code: "CONFLICT",
                message: "邀请已被使用或已过期，请联系管理员重新邀请",
              });
            }
            // 原子落编：factoryId/departmentId/role/activatedAt（username=phone 保留不动）；
            // WHERE factoryId=0 兜底——并发重复入企败方影响行=0 → CONFLICT，整体回滚码也不消耗
            const claim = await tx.execute(
              sql`UPDATE wb_users SET factoryId = ${inv.factoryId}, departmentId = ${inv.deptId}, role = ${inv.role}, activatedAt = ${activatedAt} WHERE id = ${userId} AND factoryId = 0`,
            );
            const claimed = Number(
              (claim[0] as { affectedRows?: number | string } | undefined)?.affectedRows ?? 0,
            );
            if (claimed !== 1) {
              throw new TRPCError({
                code: "CONFLICT",
                message: "你已在企业中，如需换企业请先离职",
              });
            }
            // manager 双写 wb_dept_heads（读取侧 normalizeRole 与 dept_heads 命中取并集）
            if (inv.role === "manager") {
              await tx.insert(wbDeptHeads).values({
                factoryId: inv.factoryId,
                deptId: inv.deptId,
                userId,
              });
            }
            // M21 join 钩子：入编即写 pending 履历，同事务同生共死
            await recordCareerEvent(userId, inv.factoryId, "join", deptName, inv.role, tx);
          });
        } catch (err) {
          if (err instanceof TRPCError) throw err;
          throw err;
        }
        const [user] = await db.select().from(wbUsers).where(eq(wbUsers.id, userId)).limit(1);
        return {
          ok: true as const,
          // sessionInfo 同构（含 orgRole/enterpriseName）；token 原样回传——不签发新 token，原 token 继续有效
          ...sessionInfo(user, factory, input.token),
          kind: user.kind,
          departmentId: user.departmentId ?? null,
          deptName,
        };
      }

      // ── 无 token 分支：公开注册路径（原有逻辑零改动）─────────────────────────
      if (!input.username || !input.password) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "请填写用户名和密码" });
      }
      const [dupName] = await db
        .select({ id: wbUsers.id })
        .from(wbUsers)
        .where(eq(wbUsers.username, input.username))
        .limit(1);
      if (dupName) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "用户名已存在" });
      }
      if (input.phone) {
        const [dupPhone] = await db
          .select({ id: wbUsers.id })
          .from(wbUsers)
          .where(eq(wbUsers.phone, input.phone))
          .limit(1);
        if (dupPhone) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "手机号已注册" });
        }
      }
      // ── 事务（reviewer-gate F1/F2）：原子消费置位 + 建号 + dept_heads 双写 + 发 token
      // 同生共死——并发败方/建号失败整体回滚，绝不产生孤立 wb_users 行；
      // UPDATE 带 expiresAt > NOW() 消除过期 TOCTOU（读侧预检与置位之间的窗口）。
      // 提取为局部 const：守卫后收窄为 string，供事务闭包使用（属性收窄不进闭包）
      const username = input.username;
      const password = input.password;
      let userId = 0;
      let token = "";
      try {
        await db.transaction(async (tx) => {
          // 原子置 consumedAt 先行：一次性消费，并发抢用/过期败方影响行=0 → CONFLICT
          const upd = await tx.execute(
            sql`UPDATE wb_invites SET consumedAt = NOW() WHERE id = ${inv.id} AND consumedAt IS NULL AND revokedAt IS NULL AND expiresAt > NOW()`,
          );
          const affected = Number(
            (upd[0] as { affectedRows?: number | string } | undefined)?.affectedRows ?? 0,
          );
          if (affected !== 1) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "邀请已被使用或已过期，请联系管理员重新邀请",
            });
          }
          const [{ id }] = await tx
            .insert(wbUsers)
            .values({
              username,
              passwordHash: hashPassword(password),
              displayName: inv.displayName,
              role: inv.role,
              factoryId: inv.factoryId,
              departmentId: inv.deptId, // 保留 raw 值
              phone: input.phone ?? null,
              kind: "enterprise",
              invitedBy: inv.inviterId,
              activatedAt,
            })
            .$returningId();
          userId = id;
          // manager 双写 wb_dept_heads（读取侧 normalizeRole 与 dept_heads 命中取并集）
          if (inv.role === "manager") {
            await tx.insert(wbDeptHeads).values({
              factoryId: inv.factoryId,
              deptId: inv.deptId,
              userId,
            });
          }
          // M21 join 钩子：入编即写 pending 履历（数字职业档案，待本人确认），
          // 同事务同生共死——建号失败/并发败方回滚不产生孤立履历行
          await recordCareerEvent(userId, inv.factoryId, "join", deptName, inv.role, tx);
          // 签发 nt_ token（自动登录，单点有效）
          token = newCredential("nt_");
          // portal#86 必修：落库只存指纹（明文不落库[凭证纪律——与 wb P3-6 同面]）
          await tx.update(wbUsers).set({ authToken: authTokenHash(token) }).where(eq(wbUsers.id, userId));
        });
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        // 预检后唯一键被抢注（username/phone 唯一索引兜底）→ 业务错误而非 500
        if (err instanceof Error && err.message.includes("Duplicate entry")) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "用户名或手机号已被注册" });
        }
        throw err;
      }
      const [user] = await db.select().from(wbUsers).where(eq(wbUsers.id, userId)).limit(1);
      return {
        ...sessionInfo(user, factory, token), // 含 orgRole，与 authLogin 输出对齐
        kind: user.kind,
        departmentId: user.departmentId ?? null,
        deptName,
      };
    }),
});
