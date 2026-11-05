/**
 * wbAccount —— M35 账号注销（PIPL/工信部 APP 备案硬项：注销入口）。
 *
 * 口径（真实删除/匿名化，不做假注销）：
 * - 个人账号（kind=person 且 factoryId=0 游离态）：可自助注销——
 *   PII 全清（phone/realName/idCardMasked/idCardHash→NULL）、username→closed_{id}、
 *   displayName→「已注销用户」、passwordHash 随机化、authToken 置空（即时全端下线）；
 *   业务数据（记忆/履历）按系统留存口径保留但已无法关联到自然人。
 * - 企业成员（factoryId≠0 的 staff/manager）：拒绝——请先由管理员移出企业再注销；
 * - 企业管理员（admin/owner）：拒绝——请先转让管理员或解散企业（绝不留下无主企业）。
 *
 * 纪律：二次确认在调用方（App 输入「确认注销」）；本端点一调即真删；
 * 审计留痕（writeAdminAudit，actor=原 username）；token 只在请求体。
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { wbUsers, wbFactories } from "@db/schema";
import { normalizeRole, resolveWbUserByToken } from "./wbSession";
import { writeAdminAudit } from "./adminAnalytics";

export const wbAccountRouter = createRouter({
  /**
   * close（mutation）：注销当前账号。confirmText 必须原样「确认注销」（防误触）。
   * 成功返回 { ok:true }——前端随后清本地会话回登录页。
   */
  close: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        confirmText: z.string().trim().max(16),
      }),
    )
    .mutation(async ({ input }) => {
      if (input.confirmText !== "确认注销") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "请输入「确认注销」四个字以完成操作" });
      }
      const db = getDb();
      const user = await resolveWbUserByToken(db, input.token); // P3-6 双轨单点同引
      if (!user) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "token 无效或已过期" });
      }
      const factoryId = Number(user.factoryId);
      const role = normalizeRole(user.role);

      if (factoryId !== 0 && role === "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "你是企业管理员，不能注销：请先在组织管理把管理员转让给其他成员，或解散企业后再注销。",
        });
      }
      if (factoryId !== 0) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "你还在企业组织里，请先让管理员把你移出企业，再回来注销。",
        });
      }

      const id = Number(user.id);
      const origUsername = String(user.username);
      await db
        .update(wbUsers)
        .set({
          username: `closed_${id}`,
          displayName: "已注销用户",
          phone: null,
          realName: null,
          idCardMasked: null,
          idCardHash: null,
          passwordHash: `closed:${randomBytes(16).toString("hex")}`,
          authToken: null,
        })
        .where(eq(wbUsers.id, id));

      // 审计留痕（内部 fire-and-forget，失败静默，绝不阻塞）
      writeAdminAudit(id, origUsername, "wbAccount.close", `user#${id}`, { kind: String(user.kind) });
      return { ok: true as const };
    }),
});

// 保留引用防未用告警（wbFactories 供未来企业解散流程）
void wbFactories;
