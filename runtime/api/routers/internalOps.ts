/**
 * internalOps —— 灵智枢内部工作台：四舱任务位 + 认领回路（2026-08-31 彭总定稿）。
 *
 * 队列认领制：超终四舱队列 → 成员个人工作台任务位（亮红点）→ 点认领 → 队列销项
 * （写认领人+时间，审计留痕）；舱主看本舱实况。
 * 纪律：认领互斥（已有主即拒）；仅灵智枢 HQ 成员可用（HQ_FACTORY_IDS）；
 * 认领只是派活，不改变原审批链（该双签的还双签）。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { STATION_CODES, type StationCode } from "@contracts/stations"; // R7-c4-③/R7-c5-②/R7-c6-①：典序双端单源（归顶部块）
import { sessionMe } from "./wbSession";
import { rawRows } from "./terminal";
import { auditUserAction } from "./userAudit";

/** 队列种类→舱（一张表定归属；可测） */
export const QUEUE_STATION: Record<string, StationCode> = {
  proposal: "x_rel",   // 待审提案 → 更新舱
  partner: "x_ch",     // 合伙人申请 → 渠道舱
  market: "x_mkt",     // 上架审核 → 市场舱
  alert: "x_ops",      // 系统告警 → 运行舱
  topup: "x_fin",      // 充值待办 → 财务舱
  protocol: "x_law",   // 协议评审 → 法务舱
  compliance: "x_law", // 合规审查 → 法务舱
} as const;

/** 认领互斥判定（纯函数） */
export function canClaim(claimedBy: number | null): boolean {
  return claimedBy == null;
}

function hqOnly(factoryId: number): void {
  const hq = (process.env.HQ_FACTORY_IDS ?? "").split(",").map((s) => Number(s.trim()));
  if (!hq.includes(factoryId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "仅灵智枢内部可用" });
  }
}

export const internalOpsRouter = createRouter({
  /** 我的任务位：四舱队列聚合（未认领的+我认领的） */
  myStation: publicQuery.input(z.object({ token: z.string().trim().min(1) })).query(async ({ input }) => {
    const session = await sessionMe(input.token);
    hqOnly(session.factory.id);
    const uid = Number(session.user.id);
    const db = getDb();
    const items: { kind: string; station: StationCode; id: number; title: string; claimedBy: number | null; mine: boolean; at: string }[] = [];
    try {
      const props = rawRows(
        await db.execute(
          sql`SELECT id, title, claimed_by, DATE_FORMAT(created_at,'%m-%d %H:%i') AS at FROM st_evo_proposals
              WHERE status='pending' ORDER BY id DESC LIMIT 15`,
        ),
      ) as { id: number; title: string; claimed_by: number | null; at: string }[];
      for (const r of props) items.push({ kind: "proposal", station: "x_rel", id: r.id, title: r.title, claimedBy: r.claimed_by, mine: r.claimed_by === uid, at: r.at });
    } catch { /* 静默 */ }
    try {
      const leads = rawRows(
        await db.execute(
          sql`SELECT id, contact_name, city, role, claimed_by, DATE_FORMAT(created_at,'%m-%d %H:%i') AS at FROM st_partner_leads
              WHERE status='pending' ORDER BY id DESC LIMIT 15`,
        ),
      ) as { id: number; contact_name: string; city: string; role: string; claimed_by: number | null; at: string }[];
      for (const r of leads) items.push({ kind: "partner", station: "x_ch", id: r.id, title: `合伙人申请：${r.contact_name}（${r.city}·${r.role === "partner" ? "合伙人" : "代理人"}）`, claimedBy: r.claimed_by, mine: r.claimed_by === uid, at: r.at });
    } catch { /* 静默 */ }
    // v185 财务舱：充值待办（wb topups pending）
    try {
      const tops = rawRows(
        await db.execute(
          sql`SELECT id, amount, status, DATE_FORMAT(created_at,'%m-%d %H:%i') AS at FROM st_token_topups WHERE status='pending' ORDER BY id DESC LIMIT 10`,
        ),
      ) as { id: number; amount: number; status: string; at: string }[];
      for (const r of tops) items.push({ kind: "topup", station: "x_fin", id: r.id, title: `充值待处理 ¥${(r.amount / 100).toFixed(0)}`, claimedBy: null, mine: false, at: r.at });
    } catch { /* 表异静默 */ }
    return { items, stations: STATION_CODES };
  }),

  /** 渠道舱合伙人队列（彭总定调：合伙人/代理人邀请处理归 x_ch） */
  channelLeads: publicQuery.input(z.object({ token: z.string().trim().min(1) })).query(async ({ input }) => {
    const session = await sessionMe(input.token);
    hqOnly(session.factory.id);
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT l.id, l.city, l.role, l.contact_name AS name, l.contact_phone AS phone, l.note, l.status,
              l.claimed_by, u.displayName AS claimedName, DATE_FORMAT(l.created_at,'%m-%d %H:%i') AS at
            FROM st_partner_leads l LEFT JOIN wb_users u ON u.id=l.claimed_by
            ORDER BY l.id DESC LIMIT 30`,
      ),
    );
    return { leads: rows };
  }),

  /** 渠道舱处置（已联系/签约/驳回；须先认领——认领制纪律） */
  leadDecide: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      leadId: z.number().int().positive(),
      action: z.enum(["contacted", "signed", "rejected"]),
    }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      hqOnly(session.factory.id);
      const uid = Number(session.user.id);
      const db = getDb();
      const lead = rawRows(await db.execute(sql`SELECT status, claimed_by FROM st_partner_leads WHERE id=${input.leadId} LIMIT 1`))[0];
      if (!lead) throw new TRPCError({ code: "NOT_FOUND", message: "申请不存在" });
      if (lead.claimed_by == null) throw new TRPCError({ code: "BAD_REQUEST", message: "请先认领再处置（认领制）" });
      if (Number(lead.claimed_by) !== uid) throw new TRPCError({ code: "FORBIDDEN", message: "该单已被同事认领" });
      await db.execute(sql`UPDATE st_partner_leads SET status=${input.action} WHERE id=${input.leadId}`);
      // #5 审计：合伙人处置留痕（签约/驳回/已联系）
      auditUserAction({
        userId: uid,
        userName: String((session.user as { displayName?: string }).displayName ?? session.user.username ?? ""),
        action: `partner_${input.action}`,
        targetType: "partner_lead",
        targetId: input.leadId,
        detail: { previousStatus: lead.status },
      });
      return { ok: true as const, status: input.action };
    }),

  /** 认领（互斥：已有主即拒；审计留痕） */
  claim: publicQuery
    .input(z.object({ token: z.string().trim().min(1), kind: z.enum(["proposal", "partner"]), id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      hqOnly(session.factory.id);
      const uid = Number(session.user.id);
      const db = getDb();
      const table = input.kind === "proposal" ? "st_evo_proposals" : "st_partner_leads";
      const cur = rawRows(await db.execute(sql`SELECT claimed_by FROM ${sql.raw(table)} WHERE id=${input.id} LIMIT 1`))[0];
      if (!cur) throw new TRPCError({ code: "NOT_FOUND", message: "队列项不存在" });
      if (!canClaim(cur.claimed_by == null ? null : Number(cur.claimed_by))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "已被同事认领" });
      }
      await db.execute(sql`UPDATE ${sql.raw(table)} SET claimed_by=${uid}, claimed_at=NOW() WHERE id=${input.id} AND claimed_by IS NULL`);
      return { ok: true as const };
    }),
});
