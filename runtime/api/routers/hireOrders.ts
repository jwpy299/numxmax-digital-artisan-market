/**
 * hireOrders —— 雇佣工单闭环（六刀第一刀，2026-08-30 彭总拍板）。
 *
 * 一单到底：order_no 从派单活到结算，五端同认。
 * 链路：企业派单（须在有效雇佣合约内）→ 数字员工干活（flash 槽执行）→ 交付回传
 *      → 企业验收确权（落 st_delivery_acceptances，北极星同源）→ 词元结算（企业扣、主人入）。
 * 纪律：验收才结算（不合格不付钱）；验收事实源与北极星同表；驳回可返工一次（重派原单号）。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { sessionMe } from "./wbSession";
import { rawRows } from "./terminal";
import { auditUserAction } from "./userAudit";
import { callSlotChatFast } from "./modelGateway";
import { emitReport } from "./reportBus";
import { publishBroadcast } from "./streamBus";
import { debitForPurchase, creditUser } from "./tokenLedger";

export const ORDER_STATUS = ["dispatched", "running", "delivered", "accepted", "rejected", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];

/** 状态迁移表（纯函数可测）：合法迁移才放行 */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  dispatched: ["running", "cancelled"],
  running: ["delivered", "cancelled"],
  delivered: ["accepted", "rejected"],
  accepted: [],
  rejected: ["dispatched"], // 驳回返工：回原单号重派
  cancelled: [],
};
export function canTransit(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** 工单号（纯函数）：HO-<hireId>-<seq> */
export function orderNo(hireRecordId: number, seq: number): string {
  return `HO-${hireRecordId}-${String(seq).padStart(3, "0")}`;
}

const tokenInput = { token: z.string().trim().min(1) };

export const hireOrdersRouter = createRouter({
  /** 派单（企业负责人/主管；须在本厂有效合约内） */
  dispatch: publicQuery
    .input(z.object({
      ...tokenInput,
      hireRecordId: z.number().int().positive(),
      title: z.string().trim().min(2).max(128),
      brief: z.string().trim().max(2000).optional(),
    }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const db = getDb();
      const hire = rawRows(
        await db.execute(
          sql`SELECT id, agentId, enterpriseId, status FROM agent_hire_records WHERE id=${input.hireRecordId} LIMIT 1`,
        ),
      )[0];
      if (!hire || Number(hire.enterpriseId) !== session.factory.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "合约不存在或不属于本厂" });
      }
      if (!["trial", "active"].includes(String(hire.status))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "合约已结束，无法派单" });
      }
      const seqRow = rawRows(
        await db.execute(sql`SELECT COUNT(*) AS c FROM st_hire_orders WHERE hire_record_id=${input.hireRecordId}`),
      )[0];
      const no = orderNo(input.hireRecordId, Number(seqRow?.c ?? 0) + 1);
      // 分身主人（个人分身被雇时回填，供个人工作台外派区）
      const owner = rawRows(
        await db.execute(sql`SELECT owner_user_id AS o FROM st_personal_agents WHERE id=${Number(hire.agentId)} LIMIT 1`),
      )[0];
      await db.execute(
        sql`INSERT INTO st_hire_orders (order_no, factory_id, hire_record_id, agent_id, owner_user_id, title, brief)
            VALUES (${no}, ${session.factory.id}, ${input.hireRecordId}, ${Number(hire.agentId)}, ${owner ? Number(owner.o) : null}, ${input.title}, ${input.brief ?? null})`,
      );
      // 派单即起执行（数字员工立即开工）
      void executeOrder(no).catch(() => undefined);
      await emitReport({
        audience: "factory", factoryId: session.factory.id, level: "info", sourceRing: "hire",
        title: `📋 新工单 ${no}：${input.title}`,
        body: `已派单，数字员工开工中。`, dedupeKey: `ho:new:${no}`,
      });
      if (owner) {
        await emitReport({
          audience: "personal", userId: Number(owner.o), level: "info", sourceRing: "hire",
          title: `你的分身接到外派工单 ${no}`,
          body: `「${input.title}」——干完验收后词元自动入账。`, dedupeKey: `ho:new:${no}`,
        });
      }
      return { ok: true as const, orderNo: no };
    }),

  /** 我的工单（企业侧按厂 / 个人侧按主人） */
  list: publicQuery
    .input(z.object({ ...tokenInput, scope: z.enum(["factory", "mine"]).default("factory"), status: z.string().optional() }))
    .query(async ({ input }) => {
      const session = await sessionMe(input.token);
      const uid = Number(session.user.id);
      const db = getDb();
      const cond = input.scope === "mine" ? sql`o.owner_user_id=${uid}` : sql`o.factory_id=${session.factory.id}`;
      const stFilter = input.status ? sql`AND o.status=${input.status}` : sql``;
      const rows = rawRows(
        await db.execute(
          sql`SELECT o.id, o.order_no AS orderNo, o.title, o.status, o.token_settle AS tokenSettle,
                     a.name AS agentName, DATE_FORMAT(o.created_at, '%m-%d %H:%i') AS at,
                     DATE_FORMAT(o.accepted_at, '%m-%d %H:%i') AS acceptedAt
              FROM st_hire_orders o JOIN agents a ON a.id=o.agent_id
              WHERE ${cond} ${stFilter} ORDER BY o.id DESC LIMIT 30`,
        ),
      );
      return { orders: rows };
    }),

  /** 工单详情（交付物正文；本厂/主人可见） */
  get: publicQuery
    .input(z.object({ ...tokenInput, orderNo: z.string().trim().regex(/^HO-\d+-\d{3}$/) }))
    .query(async ({ input }) => {
      const session = await sessionMe(input.token);
      const uid = Number(session.user.id);
      const o = rawRows(
        await getDb().execute(sql`SELECT * FROM st_hire_orders WHERE order_no=${input.orderNo} LIMIT 1`),
      )[0] as Record<string, unknown> | undefined;
      if (!o) throw new TRPCError({ code: "NOT_FOUND", message: "工单不存在" });
      const isFactory = Number(o.factory_id) === session.factory.id;
      const isOwner = o.owner_user_id != null && Number(o.owner_user_id) === uid;
      if (!isFactory && !isOwner) throw new TRPCError({ code: "FORBIDDEN", message: "无权查看" });
      return {
        orderNo: String(o.order_no), title: String(o.title), brief: o.brief ?? null,
        status: String(o.status), deliverable: o.deliverable ?? null,
        tokenSettle: o.token_settle != null ? Number(o.token_settle) : null,
      };
    }),

  /** 验收（企业负责人；delivered → accepted/rejected；验收才结算） */
  review: publicQuery
    .input(z.object({
      ...tokenInput,
      orderNo: z.string().trim().regex(/^HO-\d+-\d{3}$/, "工单号格式不正确"),
      verdict: z.enum(["accept", "reject"]),
      note: z.string().trim().max(300).optional(),
    }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const db = getDb();
      const o = rawRows(
        await db.execute(sql`SELECT * FROM st_hire_orders WHERE order_no=${input.orderNo} LIMIT 1`),
      )[0] as Record<string, unknown> | undefined;
      if (!o || Number(o.factory_id) !== session.factory.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "工单不存在或不属于本厂" });
      }
      if (!canTransit("delivered", input.verdict === "accept" ? "accepted" : "rejected") || String(o.status) !== "delivered") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `当前状态（${o.status}）不可验收` });
      }
      const uid = Number(session.user.id);
      if (input.verdict === "accept") {
        // 验收确权落北极星事实源（task_ref=ho:<orderNo> 唯一）
        const cost = Math.max(10, Math.round(String(o.deliverable ?? "").length / 20)); // 交付量折算词元（确定性）
        await db.execute(
          sql`INSERT INTO st_delivery_acceptances (hire_record_id, factory_id, task_ref, accepted_by, accept_source, token_cost, duration_min)
              VALUES (${Number(o.hire_record_id)}, ${session.factory.id}, ${`ho:${input.orderNo}`}, ${uid}, 'hire_order', ${cost}, 1)`,
        );
        // 结算：企业扣、主人入（有主人才入；无主=企业员工，记平台账）
        const ownerId = o.owner_user_id ? Number(o.owner_user_id) : null;
        await debitForPurchase({ factoryId: session.factory.id, amount: cost, packKey: `hire_order:${input.orderNo}` }).catch(() => undefined);
        if (ownerId) await creditUser({ userId: ownerId, amount: cost, bizType: "hire_order_income", note: `外派工单入账 ${input.orderNo}` }).catch(() => undefined);
        await db.execute(
          sql`UPDATE st_hire_orders SET status='accepted', token_settle=${cost}, accepted_by=${uid}, accepted_at=NOW() WHERE order_no=${input.orderNo}`,
        );
        if (ownerId) {
          await emitReport({
            audience: "personal", userId: ownerId, level: "info", sourceRing: "hire",
            title: `💰 工单 ${input.orderNo} 已验收，词元 +${cost} 入账`,
            body: `雇主已确权。继续攒口碑，口碑就是租金。`, dedupeKey: `ho:accept:${input.orderNo}`,
          });
        }
        publishBroadcast({ factoryId: session.factory.id, level: "B", title: `工单 ${input.orderNo} 已验收确权` });
        // #5 审计：验收结算留痕（钱）
        auditUserAction({
          userId: uid,
          userName: String((session.user as { displayName?: string }).displayName ?? session.user.username ?? ""),
          action: "hire_order_accept",
          targetType: "hire_order",
          targetId: input.orderNo,
          detail: { settled: cost, ownerId, factoryId: session.factory.id },
        });
        return { ok: true as const, status: "accepted" as const, settled: cost };
      }
      await db.execute(sql`UPDATE st_hire_orders SET status='rejected' WHERE order_no=${input.orderNo}`);
      // #5 审计：驳回留痕
      auditUserAction({
        userId: uid,
        userName: String((session.user as { displayName?: string }).displayName ?? session.user.username ?? ""),
        action: "hire_order_reject",
        targetType: "hire_order",
        targetId: input.orderNo,
        detail: { note: input.note ?? null },
      });
      return { ok: true as const, status: "rejected" as const };
    }),

  /** 返工重派（驳回后回原单号） */
  redispatch: publicQuery
    .input(z.object({ ...tokenInput, orderNo: z.string().trim().regex(/^HO-\d+-\d{3}$/) }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const db = getDb();
      const o = rawRows(await db.execute(sql`SELECT status, factory_id FROM st_hire_orders WHERE order_no=${input.orderNo} LIMIT 1`))[0];
      if (!o || Number(o.factory_id) !== session.factory.id) throw new TRPCError({ code: "FORBIDDEN", message: "工单不存在" });
      if (!canTransit("rejected", "dispatched") || String(o.status) !== "rejected") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "仅驳回单可返工" });
      }
      await db.execute(sql`UPDATE st_hire_orders SET status='dispatched', deliverable=NULL WHERE order_no=${input.orderNo}`);
      void executeOrder(input.orderNo).catch(() => undefined);
      return { ok: true as const };
    }),
});

/** 数字员工干活（flash 槽；产出交付物 → delivered） */
async function executeOrder(no: string): Promise<void> {
  const db = getDb();
  const o = rawRows(await db.execute(sql`SELECT id, agent_id, title, brief, status FROM st_hire_orders WHERE order_no=${no} LIMIT 1`))[0];
  if (!o || String(o.status) !== "dispatched") return;
  await db.execute(sql`UPDATE st_hire_orders SET status='running' WHERE order_no=${no} AND status='dispatched'`);
  const agent = rawRows(await db.execute(sql`SELECT name FROM agents WHERE id=${Number(o.agent_id)} LIMIT 1`))[0];
  const r = await callSlotChatFast("flash", {
    messages: [
      { role: "system", content: `你是数字员工「${String(agent?.name ?? "员工")}」，正在执行雇佣工单。直接交付工作成果：结构清晰、可直接使用，不解释过程。` },
      { role: "user", content: `工单 ${no}：${String(o.title)}\n${String(o.brief ?? "")}` },
    ],
    maxTokens: 2400, // 思维链要留余量（产线实锤：800 全被推理吃光、零内容回弹 dispatched）
    timeoutMs: 30_000,
    context: "hire_order",
  }).catch(() => null);
  if (r && r.ok && r.content) {
    await db.execute(
      sql`UPDATE st_hire_orders SET status='delivered', deliverable=${r.content.slice(0, 60000)} WHERE order_no=${no} AND status='running'`,
    );
    const fac = rawRows(await db.execute(sql`SELECT factory_id FROM st_hire_orders WHERE order_no=${no} LIMIT 1`))[0];
    await emitReport({
      audience: "factory", factoryId: Number(fac?.factory_id ?? 0), level: "action", sourceRing: "hire",
      title: `📦 工单 ${no} 已交付，待验收`,
      body: `「${String(o.title)}」成果已回传，请到用工管理验收。`, dedupeKey: `ho:deliver:${no}`,
    });
    // v177 第四刀：关键业务事件 SSE 毫秒达（B 级 persona=xingyun 播报）
    publishBroadcast({ factoryId: Number(fac?.factory_id ?? 0), level: "B", title: `工单 ${no} 已交付待验收` });
  } else {
    // 执行失败如实回 dispatched（下拍/手动可重试），不装交付
    await db.execute(sql`UPDATE st_hire_orders SET status='dispatched' WHERE order_no=${no} AND status='running'`);
  }
}
