/**
 * wbCareer —— M21 数字职业档案（本人授权驱动，设计 §3/§4/§5）。
 *
 * 纪律：
 * - 框架层无自动鉴权：token 在请求体，业务层 sessionMe/effectiveRoleOf 校验（同 wbInvites）；
 * - 授权默认全关：本人 share 是 C 级动作（二次确认文案由前端承载），撤回 revokedAt 置位幂等；
 * - 敏感信息红线：手机号输出恒为 138****5678 口径，身份证恒为 前1***后1；
 *   orgView 绝不输出 phone/idCard/realName，姓名恒脱敏（前 1 字 + *）；
 * - 上家企业内部经营数据（任务明细/绩效评分）永不流动——只出结论性档案（履历/徽章）。
 */
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import {
  wbCareerEntries,
  wbCareerShares,
  wbFactories,
  wbSkillBadges,
  wbUsers,
  type WbCareerEntry,
  type WbSkillBadge,
} from "@db/schema";
import { effectiveRoleOf, normalizeRole, sessionMe, resolveWbUserByToken } from "./wbSession";

const ORG_VIEW_DENIED = "仅企业负责人或部门负责人可查看成员档案";
const ORG_VIEW_CROSS_DENIED = "仅可查看本企业成员档案";
const NOT_SHARED_MESSAGE = "该成员未共享档案";

const tokenInput = { token: z.string().trim().min(1) };
const scopeEnum = z.enum(["career", "badges", "achievements", "proof"]);
export type WbCareerScope = z.infer<typeof scopeEnum>;
export const WB_CAREER_SCOPES: WbCareerScope[] = [
  "career",
  "badges",
  "achievements",
  "proof",
];

/** 可传入事务的 DB 句柄（recordCareerEvent 挂 wbInvites.accept 同事务用） */
export type WbCareerDb = Pick<ReturnType<typeof getDb>, "select" | "insert" | "update">;

// ─── 脱敏（输出侧唯一口径，任何接口不回明文）────────────────────────────────
/** 手机号：138****5678；异常短号兜底也不回明文 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const s = String(phone);
  if (s.length >= 7) return `${s.slice(0, 3)}****${s.slice(-4)}`;
  return `${s.slice(0, 1)}****`;
}

/** 身份证：前 1 + *** + 后 1（入参即库存掩码 前4+10*+后4，输出再降维，绝不回明文） */
export function maskIdCard(masked: string | null | undefined): string | null {
  if (!masked) return null;
  const s = String(masked);
  return `${s.slice(0, 1)}***${s.slice(-1)}`;
}

/** 姓名：前 1 字 + *（orgView 恒脱敏） */
export function maskName(name: string | null | undefined): string {
  const s = String(name ?? "");
  if (!s) return "*";
  return `${s.slice(0, 1)}${"*".repeat(Math.max(s.length - 1, 1))}`;
}

// ─── 入编/离职事件钩子（设计 §5：写 wb_career_entries，status=待本人确认）────────
/**
 * recordCareerEvent：
 * - join：插入 pending 履历（入编事实，本人确认后置 confirmed——确认接口二期做）；
 * - depart：把该用户在该企业最新在职履历（endedAt IS NULL 且非 departed）置 departed+endedAt；
 *   幂等——无在职履历则 no-op。
 * 一期触发点：wbInvites.accept 事务内挂 join；depart 暂无 UI 触发点，导出待用。
 */
export async function recordCareerEvent(
  userId: number,
  factoryId: number,
  type: "join" | "depart",
  deptName?: string | null,
  role?: string | null,
  db: WbCareerDb = getDb(),
): Promise<{ ok: true; entryId: number | null }> {
  if (type === "join") {
    const [{ id }] = await db
      .insert(wbCareerEntries)
      .values({
        userId,
        factoryId,
        deptName: deptName ?? null,
        role: role ?? null,
        startedAt: new Date(),
        status: "pending", // 待本人确认（设计 §3.1：自动记录，本人确认后生效）
      })
      .$returningId();
    return { ok: true, entryId: id };
  }
  // depart：最新在职履历置 departed（JS 侧取最新一条，避免依赖 orderBy 链）
  const rows = await db
    .select()
    .from(wbCareerEntries)
    .where(and(eq(wbCareerEntries.userId, userId), eq(wbCareerEntries.factoryId, factoryId)));
  const active = rows
    .filter((r) => r.endedAt == null && r.status !== "departed")
    .sort((a, b) => b.id - a.id)[0];
  if (!active) return { ok: true, entryId: null };
  await db
    .update(wbCareerEntries)
    .set({ status: "departed", endedAt: new Date() })
    .where(eq(wbCareerEntries.id, active.id));
  return { ok: true, entryId: active.id };
}

function entryRow(e: WbCareerEntry) {
  return {
    entryId: e.id,
    factoryId: e.factoryId,
    deptName: e.deptName ?? null,
    role: e.role ?? null,
    startedAt: e.startedAt,
    endedAt: e.endedAt ?? null,
    status: e.status,
    createdAt: e.createdAt,
  };
}

function badgeRow(b: WbSkillBadge) {
  return {
    badgeId: b.id,
    skillKey: b.skillKey,
    name: b.name,
    factoryId: b.factoryId,
    issuedAt: b.issuedAt,
  };
}

export const wbCareerRouter = createRouter({
  /**
   * my（query，本人）：我的档案 = 脱敏实名信息 + currentFactory + 履历 + 徽章 + 授权矩阵。
   * shareMatrix：按 targetFactoryId 聚合，true=该企业持有本人该类目有效授权（revokedAt IS NULL）。
   *
   * currentFactory: { factoryId, enterpriseName, role } | null —— 游离态承载：
   * - 数据源：user.factoryId → wb_factories 查 enterpriseName；查不到或查询异常 → null（不抛错）；
   *   registerPerson（api/routers/agentic.ts）创建的个人账号 factoryId=0（占位，无对应 factory 行），
   *   即落入此 null 分支——游离态在数据层的表达一期即 "factoryId 指向占位/缺失行"。
   * - role 用 wbSession 归一口径 normalizeRole（与 sessionInfo orgRole 完全一致：
   *   owner→admin、member/未知→staff）；App 端游离判定以 currentFactory===null 为准
   *   （等价于"role 归一为 member/staff 且非任何企业员工"的一期数据表达，与 lead 联调口径）。
   * 注意：此处不复用 sessionMe——sessionMe 对缺失 factory 抛 UNAUTHORIZED，会把游离态个人账号
   * 挡在档案接口之外；my 仅在 token 无效（用户行不存在）时抛 UNAUTHORIZED。
   */
  my: publicQuery.input(z.object({ ...tokenInput })).query(async ({ input }) => {
    const db = getDb();
    const user = await resolveWbUserByToken(db, input.token); // P3-6 双轨单点同引
    if (!user) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "token 无效或已过期" });
    }
    let currentFactory: { factoryId: number; enterpriseName: string; role: string } | null = null;
    try {
      const [factory] = await db
        .select()
        .from(wbFactories)
        .where(eq(wbFactories.id, user.factoryId))
        .limit(1);
      if (factory) {
        currentFactory = {
          factoryId: factory.id,
          enterpriseName: factory.enterpriseName,
          role: normalizeRole(user.role),
        };
      }
    } catch {
      currentFactory = null; // 游离态兜底：查不到/异常一律 null，不抛错
    }
    const entries = await db
      .select()
      .from(wbCareerEntries)
      .where(eq(wbCareerEntries.userId, user.id));
    const badges = await db
      .select()
      .from(wbSkillBadges)
      .where(eq(wbSkillBadges.userId, user.id));
    const shares = await db
      .select()
      .from(wbCareerShares)
      .where(eq(wbCareerShares.userId, user.id));
    const shareMatrix: Record<string, Record<WbCareerScope, boolean>> = {};
    for (const s of shares) {
      const key = String(s.targetFactoryId);
      shareMatrix[key] ??= { career: false, badges: false, achievements: false, proof: false };
      if (s.revokedAt == null) shareMatrix[key][s.scope] = true;
    }
    return {
      profile: {
        userId: user.id,
        displayName: user.displayName,
        realNameMasked: user.realName ? maskName(user.realName) : null, // 实名姓名恒脱敏
        phoneMasked: maskPhone(user.phone),
        idCardMasked: maskIdCard(user.idCardMasked),
      },
      currentFactory,
      entries: entries.map(entryRow).sort((a, b) => b.entryId - a.entryId),
      badges: badges.map(badgeRow).sort((a, b) => b.badgeId - a.badgeId),
      shares: shares
        .map((s) => ({
          shareId: s.id,
          targetFactoryId: s.targetFactoryId,
          scope: s.scope,
          createdAt: s.createdAt,
          revokedAt: s.revokedAt ?? null,
        }))
        .sort((a, b) => b.shareId - a.shareId),
      shareMatrix,
    };
  }),

  /**
   * share（mutation，本人，C 级）：授权指定企业可见所选档案类目。
   * 【C 级确认】共享后该企业管理者（admin/manager）可见所选范围；前端须二次确认。
   * 幂等：同 userId+targetFactoryId+scope 已有有效授权 → 不重复插行，归入 alreadyShared。
   */
  share: publicQuery
    .input(
      z.object({
        ...tokenInput,
        targetFactoryId: z.number().int().positive(),
        scopes: z.array(scopeEnum).min(1).max(4),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { user } = await sessionMe(input.token);
      const [target] = await db
        .select({ id: wbFactories.id })
        .from(wbFactories)
        .where(eq(wbFactories.id, input.targetFactoryId))
        .limit(1);
      if (!target) {
        throw new TRPCError({ code: "NOT_FOUND", message: "目标企业不存在" });
      }
      const scopes = [...new Set(input.scopes)]; // 入参去重，单次调用内也幂等
      const shared: WbCareerScope[] = [];
      const alreadyShared: WbCareerScope[] = [];
      for (const scope of scopes) {
        const [dup] = await db
          .select({ id: wbCareerShares.id })
          .from(wbCareerShares)
          .where(
            and(
              eq(wbCareerShares.userId, user.id),
              eq(wbCareerShares.targetFactoryId, input.targetFactoryId),
              eq(wbCareerShares.scope, scope),
              isNull(wbCareerShares.revokedAt),
            ),
          )
          .limit(1);
        if (dup) {
          alreadyShared.push(scope); // 幂等：已有效则不重复插行
          continue;
        }
        await db.insert(wbCareerShares).values({
          userId: user.id,
          targetFactoryId: input.targetFactoryId,
          scope,
        });
        shared.push(scope);
      }
      return {
        ok: true as const,
        targetFactoryId: input.targetFactoryId,
        shared,
        alreadyShared,
      };
    }),

  /**
   * revoke（mutation，本人，C 级）：撤回某企业某类目授权，该企业侧立即不可见。
   * 幂等：UPDATE ... WHERE revokedAt IS NULL，影响 0 行（本无有效授权）也返回 ok:true。
   */
  revoke: publicQuery
    .input(
      z.object({
        ...tokenInput,
        targetFactoryId: z.number().int().positive(),
        scope: scopeEnum,
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { user } = await sessionMe(input.token);
      await db
        .update(wbCareerShares)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(wbCareerShares.userId, user.id),
            eq(wbCareerShares.targetFactoryId, input.targetFactoryId),
            eq(wbCareerShares.scope, input.scope),
            isNull(wbCareerShares.revokedAt),
          ),
        );
      return { ok: true as const };
    }),

  /**
   * orgView（query，企业侧）：查看本企业成员的已授权档案。
   * - 仅 admin/manager；跨企业 targetUserId → FORBIDDEN（不泄露存在性）；
   * - 逐类目检查 wb_career_shares 有效授权：未授权类目不返回（键不存在，scopes 标 authorized:false）；
   * - 完全未授权 → 只返回脱敏姓名 + message「该成员未共享档案」；
   * - 绝不输出 phone/idCard/realName；姓名恒脱敏（通讯录口径现状）。
   */
  orgView: publicQuery
    .input(
      z.object({ ...tokenInput, targetUserId: z.number().int().positive() }),
    )
    .query(async ({ input }) => {
      const db = getDb();
      const { user: caller, factory } = await sessionMe(input.token);
      const role = await effectiveRoleOf(caller);
      if (role !== "admin" && role !== "manager") {
        throw new TRPCError({ code: "FORBIDDEN", message: ORG_VIEW_DENIED });
      }
      const [target] = await db
        .select()
        .from(wbUsers)
        .where(eq(wbUsers.id, input.targetUserId))
        .limit(1);
      if (!target || target.factoryId !== factory.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: ORG_VIEW_CROSS_DENIED });
      }
      const shares = await db
        .select()
        .from(wbCareerShares)
        .where(
          and(
            eq(wbCareerShares.userId, target.id),
            eq(wbCareerShares.targetFactoryId, factory.id),
            isNull(wbCareerShares.revokedAt),
          ),
        );
      const authorized = new Set<WbCareerScope>(
        shares.filter((s) => s.revokedAt == null).map((s) => s.scope),
      );
      const scopes = Object.fromEntries(
        WB_CAREER_SCOPES.map((s) => [s, { authorized: authorized.has(s) }]),
      ) as Record<WbCareerScope, { authorized: boolean }>;
      const base = {
        targetUserId: target.id,
        displayNameMasked: maskName(target.displayName),
        scopes,
      };
      if (authorized.size === 0) {
        return { ...base, authorized: false as const, message: NOT_SHARED_MESSAGE };
      }
      // 逐类目授权返回：career=本人全部履历（结论性档案，含上家），badges=本人徽章；
      // achievements/proof 一期无数据表，仅有 scopes 授权标记。
      const result: Record<string, unknown> = {
        ...base,
        authorized: true as const,
        message: null,
      };
      if (authorized.has("career")) {
        const entries = await db
          .select()
          .from(wbCareerEntries)
          .where(eq(wbCareerEntries.userId, target.id));
        result.career = entries.map(entryRow).sort((a, b) => b.entryId - a.entryId);
      }
      if (authorized.has("badges")) {
        const badges = await db
          .select()
          .from(wbSkillBadges)
          .where(eq(wbSkillBadges.userId, target.id));
        result.badges = badges.map(badgeRow).sort((a, b) => b.badgeId - a.badgeId);
      }
      return result;
    }),
});
