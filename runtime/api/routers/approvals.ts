/**
 * approvals —— 统一审批中心：跨域待办收口（龙虾操作单 + Token 充值申请）。
 *
 * 原则：只聚合与派单，不复制处理逻辑——批准/驳回全部调用既有共享 helper
 * （claw.confirmClawOp/rejectClawOp、wbBilling.confirmTopup/rejectTopup），
 * 与原端点行为完全一致（含并发互斥、真实入账、审计、工单联动）。
 *
 * 鉴权：inbox/decide 全走 requireHqAdmin（验收战役 P1 修复：收件箱聚合全厂待办，
 * 本厂闸 fail-closed，杜绝他厂 admin 跨厂探知/处置）。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { requireHqAdmin, stQuery } from "./terminal";
import { confirmClawOp, rejectClawOp } from "./claw";
import { confirmTopup, rejectTopup } from "./wbBilling";

interface InboxItem {
  kind: "claw" | "topup";
  refId: string;
  title: string;
  summary: string;
  actor: string;
  createdAt: string | null;
}

export const approvalsRouter = createRouter({
  /** inbox（query, admin）：统一待办收件箱，按时间倒序 */
  inbox: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      await requireHqAdmin(input.token);
      const clawRows = await stQuery(
        sql`SELECT op_no AS opNo, actor, task, domain, instance_key AS instanceKey, created_at AS createdAt
            FROM st_claw_operations WHERE status = 'pending' ORDER BY id DESC LIMIT 50`,
      );
      const topupRows = await stQuery(
        sql`SELECT t.id, t.factory_id AS factoryId, f.enterpriseName, t.amount, t.price_cny AS priceCny,
                   t.remark, t.created_at AS createdAt
            FROM st_token_topups t LEFT JOIN wb_factories f ON f.id = t.factory_id
            WHERE t.status = 'pending' ORDER BY t.id DESC LIMIT 50`,
      );
      const items: InboxItem[] = [
        ...clawRows.map((r) => ({
          kind: "claw" as const,
          refId: String(r.opNo),
          title: `龙虾任务审批 · ${String(r.opNo)}`,
          summary: `${String(r.task).slice(0, 120)}${r.domain ? `（域名：${String(r.domain)}，实例：${String(r.instanceKey ?? "main")}）` : ""}`,
          actor: String(r.actor),
          createdAt: r.createdAt ? String(r.createdAt) : null,
        })),
        ...topupRows.map((r) => ({
          kind: "topup" as const,
          refId: String(Number(r.id)),
          title: `充值确认 · ${r.enterpriseName ? String(r.enterpriseName) : `企业#${Number(r.factoryId)}`}`,
          summary: `充值 ${Number(r.amount)} Token（应付 ¥${Number(r.priceCny)}）${r.remark ? `；备注：${String(r.remark).slice(0, 60)}` : ""}`,
          actor: r.enterpriseName ? String(r.enterpriseName) : `企业#${Number(r.factoryId)}`,
          createdAt: r.createdAt ? String(r.createdAt) : null,
        })),
      ].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
      return { items, counts: { claw: clawRows.length, topup: topupRows.length } };
    }),

  /** decide（mutation, admin）：统一批准/驳回，派单到既有共享 helper */
  decide: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      kind: z.enum(["claw", "topup"]),
      refId: z.string().trim().min(1).max(24),
      action: z.enum(["approve", "reject"]),
      reason: z.string().trim().min(1).max(255).optional(),
    }))
    .mutation(async ({ input }) => {
      const admin = await requireHqAdmin(input.token);
      if (input.action === "reject" && input.kind === "topup" && !input.reason) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "驳回充值申请必须填写理由" });
      }
      if (input.kind === "claw") {
        if (input.action === "approve") {
          const r = await confirmClawOp(input.refId, String(admin.username));
          return { ok: true as const, message: r.message };
        }
        await rejectClawOp(input.refId);
        return { ok: true as const, message: `龙虾操作单 ${input.refId} 已驳回留痕` };
      }
      const topupId = Number(input.refId);
      if (!Number.isInteger(topupId) || topupId <= 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "充值单号非法" });
      }
      if (input.action === "approve") {
        const r = await confirmTopup(topupId, admin);
        return { ok: true as const, message: `充值单 #${topupId} 已确认入账（${r.amount} Token）` };
      }
      await rejectTopup(topupId, String(input.reason), admin);
      return { ok: true as const, message: `充值单 #${topupId} 已驳回：${String(input.reason)}` };
    }),
});
