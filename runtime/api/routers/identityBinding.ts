/**
 * identityBinding —— 个人/企业 APP 绑定（2026-08-26 彭总定调：组织以人为主）。
 *
 * 口径：
 * - 人是根：wb_users（kind=person）是唯一身份根；企业身份=st_identity_bindings 成员关系；
 * - 邀请制：企业 admin/owner 发起（pending），本人 confirm 才 active（bound_at 确权）——
 *   企业绝不能单方面绑人；
 * - 双向隔离：企业只见成员在企业内的角色；个人私人数据永不外露；
 * - 离职脱钩：revoke 只脱企业钩（revoked_at），个人根与信用不动；
 * - factoryId 只取服务端会话，绝不收客户端传值。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { effectiveRoleOf, sessionMe } from "./wbSession";
import { rawRows } from "../queries/rawRows"; // 战区④批A-lite：私有副本退役→canonical 叶单源

const tokenInput = { token: z.string().trim().min(1) };
const ROLE_ENUM = z.enum(["admin", "manager", "staff"]);


/** 状态机纯规则（可测）：pending→active 只能本人 confirm；active/pending→revoked 本人或该厂 admin */
export function canConfirm(status: string, isSelf: boolean): boolean {
  return status === "pending" && isSelf;
}
export function canRevoke(status: string, isSelf: boolean, isFactoryAdmin: boolean): boolean {
  return (status === "pending" || status === "active") && (isSelf || isFactoryAdmin);
}

export const identityBindingRouter = createRouter({
  /** 企业侧发起绑定邀请（按手机号找个人身份根） */
  invite: publicQuery
    .input(z.object({ ...tokenInput, phone: z.string().trim().regex(/^1\d{10}$/, "手机号格式不正确"), orgRole: ROLE_ENUM.default("staff") }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const role = await effectiveRoleOf(session.user);
      if (role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "仅企业负责人可发起绑定" });
      const db = getDb();
      const persons = rawRows(
        await db.execute(sql`SELECT id FROM wb_users WHERE phone=${input.phone} AND kind='person' AND disabled=0 LIMIT 1`),
      );
      if (!persons[0]) throw new TRPCError({ code: "NOT_FOUND", message: "该手机号未注册灵枢个人账号" });
      const personId = Number(persons[0].id);
      await db.execute(
        sql`INSERT INTO st_identity_bindings (user_id, factory_id, org_role, invited_by, invite_channel, status)
            VALUES (${personId}, ${session.factory.id}, ${input.orgRole}, ${session.user.id}, 'manual', 'pending')
            ON DUPLICATE KEY UPDATE org_role=VALUES(org_role), invited_by=VALUES(invited_by), status=IF(status='revoked','pending',status), revoked_at=NULL`,
      );
      return { ok: true, status: "pending" as const };
    }),

  /** 个人侧：我待确认的绑定邀请 */
  myInvitations: publicQuery.input(z.object(tokenInput)).query(async ({ input }) => {
    const session = await sessionMe(input.token);
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT b.id, b.factory_id AS factoryId, b.org_role AS orgRole, b.created_at AS createdAt, f.enterpriseName AS factoryName
            FROM st_identity_bindings b LEFT JOIN wb_factories f ON f.id=b.factory_id
            WHERE b.user_id=${session.user.id} AND b.status='pending' ORDER BY b.id DESC`,
      ),
    );
    return { invitations: rows };
  }),

  /** 个人侧：本人确认（确权点——企业单方面绑人永不可能） */
  confirm: publicQuery.input(z.object({ ...tokenInput, bindingId: z.number().int().positive() })).mutation(async ({ input }) => {
    const session = await sessionMe(input.token);
    const db = getDb();
    const rows = rawRows(await db.execute(sql`SELECT id, status FROM st_identity_bindings WHERE id=${input.bindingId} AND user_id=${session.user.id} LIMIT 1`));
    const b = rows[0];
    if (!b || !canConfirm(String(b.status), true)) throw new TRPCError({ code: "FORBIDDEN", message: "绑定不存在或状态不可确认" });
    await db.execute(sql`UPDATE st_identity_bindings SET status='active', bound_at=NOW() WHERE id=${input.bindingId}`);
    return { ok: true, status: "active" as const };
  }),

  /** 解绑：本人随时可退；企业 admin 可移除本厂成员（跨厂永不） */
  revoke: publicQuery.input(z.object({ ...tokenInput, bindingId: z.number().int().positive() })).mutation(async ({ input }) => {
    const session = await sessionMe(input.token);
    const db = getDb();
    const rows = rawRows(await db.execute(sql`SELECT id, user_id AS userId, factory_id AS factoryId, status FROM st_identity_bindings WHERE id=${input.bindingId} LIMIT 1`));
    const b = rows[0];
    if (!b) throw new TRPCError({ code: "NOT_FOUND", message: "绑定不存在" });
    const isSelf = Number(b.userId) === session.user.id;
    const isFactoryAdmin = Number(b.factoryId) === session.factory.id && (await effectiveRoleOf(session.user)) === "admin";
    if (!canRevoke(String(b.status), isSelf, isFactoryAdmin)) throw new TRPCError({ code: "FORBIDDEN", message: "无权解绑（仅本人或本厂负责人）" });
    await db.execute(sql`UPDATE st_identity_bindings SET status='revoked', revoked_at=NOW() WHERE id=${input.bindingId}`);
    return { ok: true, status: "revoked" as const };
  }),

  /** 个人侧：我的组织列表（一人多企） */
  myOrgs: publicQuery.input(z.object(tokenInput)).query(async ({ input }) => {
    const session = await sessionMe(input.token);
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT b.id, b.factory_id AS factoryId, b.org_role AS orgRole, b.bound_at AS boundAt, f.enterpriseName AS factoryName
            FROM st_identity_bindings b LEFT JOIN wb_factories f ON f.id=b.factory_id
            WHERE b.user_id=${session.user.id} AND b.status='active' ORDER BY b.id DESC`,
      ),
    );
    return { orgs: rows };
  }),

  /** 企业侧：本厂成员列表（只见本厂，factoryId 服务端会话口径） */
  members: publicQuery.input(z.object(tokenInput)).query(async ({ input }) => {
    const session = await sessionMe(input.token);
    const role = await effectiveRoleOf(session.user);
    if (role !== "admin" && role !== "manager") throw new TRPCError({ code: "FORBIDDEN", message: "仅企业管理员可见成员" });
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT b.id, b.org_role AS orgRole, b.status, b.bound_at AS boundAt, u.display_name AS displayName
            FROM st_identity_bindings b LEFT JOIN wb_users u ON u.id=b.user_id
            WHERE b.factory_id=${session.factory.id} AND b.status IN ('pending','active') ORDER BY b.id DESC`,
      ),
    );
    return { members: rows };
  }),
});
