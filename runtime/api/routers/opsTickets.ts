/**
 * opsTickets —— 迭代 35 批次B「客服工单闭环」服务端路由（API-CONTRACT-v7 §1）。
 *
 * 数据表（db/sync-ops.mts 幂等创建，raw SQL 访问）：
 * - st_ops_tickets   工单（source=feedback|silent|manual，status=open|processing|done）
 * - st_ticket_events 处理留痕（认领/回复/关闭/建单事件流）
 *
 * 鉴权：全部 requireAdmin（token 仅在请求体，不落日志）。
 *
 * 幂等要点：
 * - silent 惰性补单在 ticketList 查询侧执行：沉默企业（factoryHealth silentLevel≠ok）
 *   且无 open/processing 工单时，INSERT ... WHERE NOT EXISTS 补单（source='silent'），
 *   重复调用/并发均不产生重复 open 单；
 * - ticketCreate 手动建单 source='manual'，不做去重（运营显式动作）。
 *
 * ticketReply：写 reply + 事件；若来源 feedback 且 ref_id 存在，尽力而为回写
 * st_skill_feedback.note 追加处理标记（try/catch 静默，绝不阻断主流程）。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows, requireAdmin } from "./terminal";
import { writeAdminAudit, adminDisplayName, buildFactoryHealth } from "./adminAnalytics";

const tokenInput = z.object({ token: z.string().trim().min(1) });

const toDate = (v: unknown) => (v ? new Date(String(v)) : null);

/** st_ 表查询兜底：表缺失按空集降级（sync 窗口），返回 null 表示查询失败 */
async function tryRows(
  statement: ReturnType<typeof sql>,
): Promise<Array<Record<string, unknown>> | null> {
  try {
    return rawRows(await getDb().execute(statement));
  } catch {
    return null;
  }
}

/** 写工单事件（fire-and-forget，失败静默不阻塞业务） */
function writeTicketEvent(ticketId: number, actor: string, event: string, detail?: unknown): void {
  const detailJson = detail == null ? null : JSON.stringify(detail).slice(0, 4000);
  void getDb()
    .execute(
      sql`INSERT INTO st_ticket_events (ticket_id, actor, event, detail)
          VALUES (${ticketId}, ${actor.slice(0, 64)}, ${event.slice(0, 32)}, ${detailJson})`,
    )
    .catch(() => {
      // 静默：事件表未建/写入失败不影响主流程
    });
}

/**
 * silent 惰性补单（幂等）：对沉默企业（silentLevel≠ok）且
 * 无 open/processing 工单的工厂补 source='silent' 工单。
 * INSERT ... WHERE NOT EXISTS 保证重复调用不产生重复 open 单；失败静默。
 */
async function ensureSilentTickets(): Promise<void> {
  try {
    const health = await buildFactoryHealth();
    const silent = health.filter((h) => h.silentLevel !== "ok");
    for (const h of silent) {
      const title = `沉默企业（${h.silentLevel === "critical" ? "严重" : "预警"}）：${h.name}`;
      await getDb().execute(
        sql`INSERT INTO st_ops_tickets (source, factory_id, ref_id, title, status, note)
            SELECT 'silent', ${h.factoryId}, NULL, ${title}, 'open',
                   ${`lastActiveAt=${h.lastActiveAt ? h.lastActiveAt.toISOString() : "null"}; score=${h.score}`}
            FROM DUAL
            WHERE NOT EXISTS (
              SELECT 1 FROM st_ops_tickets
              WHERE factory_id = ${h.factoryId} AND source = 'silent' AND status IN ('open','processing')
            )`,
      );
    }
  } catch {
    // 静默：补单失败（表未建等）不影响 ticketList 主查询
  }
}

/** 查询某工单最近一条事件（详情抽屉事件流由列表附带最近事件 + 前端按需再查） */
async function latestEvents(ticketIds: number[]): Promise<Map<number, Record<string, unknown>>> {
  const map = new Map<number, Record<string, unknown>>();
  if (ticketIds.length === 0) return map;
  const rows = await tryRows(
    sql`SELECT e.ticket_id, e.actor, e.event, e.detail, e.created_at
        FROM st_ticket_events e
        INNER JOIN (
          SELECT ticket_id, MAX(id) AS max_id FROM st_ticket_events
          WHERE ticket_id IN (${sql.join(ticketIds.map((id) => sql`${id}`), sql`, `)})
          GROUP BY ticket_id
        ) t ON t.max_id = e.id`,
  );
  for (const r of rows ?? []) map.set(Number(r.ticket_id), r);
  return map;
}

function toTicketDto(r: Record<string, unknown>, latest?: Record<string, unknown>) {
  return {
    ticketId: Number(r.id),
    source: String(r.source),
    factoryId: r.factory_id == null ? null : Number(r.factory_id),
    factoryName: r.factory_name == null ? null : String(r.factory_name),
    refId: r.ref_id == null ? null : Number(r.ref_id),
    title: String(r.title ?? ""),
    status: String(r.status),
    assignee: String(r.assignee ?? ""),
    note: r.note == null ? null : String(r.note),
    reply: r.reply == null ? null : String(r.reply),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
    closedAt: toDate(r.closed_at),
    latestEvent:
      latest == null
        ? null
        : {
            actor: String(latest.actor ?? ""),
            event: String(latest.event ?? ""),
            detail: latest.detail == null ? null : String(latest.detail),
            createdAt: toDate(latest.created_at),
          },
  };
}

export const opsTicketsRouter = createRouter({
  /**
   * ticketList：筛选（status/source）+ 分页；返回 { items:[工单+最近事件], total }。
   * 查询侧先执行 silent 惰性补单（幂等，见 ensureSilentTickets）。
   */
  ticketList: publicQuery
    .input(
      tokenInput.extend({
        status: z.enum(["open", "processing", "done"]).optional(),
        source: z.enum(["feedback", "silent", "manual"]).optional(),
        page: z.number().int().min(1).optional().default(1),
      }),
    )
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      await ensureSilentTickets();
      const pageSize = 20;
      const offset = (input.page - 1) * pageSize;
      const conds = sql`${input.status ? sql`AND t.status = ${input.status}` : sql``}
        ${input.source ? sql`AND t.source = ${input.source}` : sql``}`;
      const [rows, cnt] = await Promise.all([
        tryRows(
          sql`SELECT t.*, f.enterpriseName AS factory_name
              FROM st_ops_tickets t
              LEFT JOIN wb_factories f ON f.id = t.factory_id
              WHERE 1=1 ${conds}
              ORDER BY t.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
        ),
        tryRows(
          sql`SELECT COUNT(*) AS c FROM st_ops_tickets t WHERE 1=1 ${conds}`,
        ),
      ]);
      const items = rows ?? [];
      const latest = await latestEvents(items.map((r) => Number(r.id)));
      return {
        items: items.map((r) => toTicketDto(r, latest.get(Number(r.id)))),
        total: cnt?.[0]?.c == null ? 0 : Number(cnt[0].c),
        degraded: rows == null,
      };
    }),

  /** ticketEvents：单工单事件流（详情抽屉） */
  ticketEvents: publicQuery
    .input(tokenInput.extend({ ticketId: z.number().int().positive() }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const rows = await tryRows(
        sql`SELECT id, actor, event, detail, created_at
            FROM st_ticket_events WHERE ticket_id = ${input.ticketId}
            ORDER BY id ASC LIMIT 200`,
      );
      return {
        items: (rows ?? []).map((r) => ({
          eventId: Number(r.id),
          actor: String(r.actor ?? ""),
          event: String(r.event ?? ""),
          detail: r.detail == null ? null : String(r.detail),
          createdAt: toDate(r.created_at),
        })),
      };
    }),

  /** ticketClaim：open → processing + assignee=当前管理员 + 事件 */
  ticketClaim: publicQuery
    .input(tokenInput.extend({ ticketId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const name = adminDisplayName(admin);
      const rows = await tryRows(
        sql`SELECT id, status FROM st_ops_tickets WHERE id = ${input.ticketId} LIMIT 1`,
      );
      const ticket = rows?.[0];
      if (!ticket) throw new TRPCError({ code: "NOT_FOUND", message: "工单不存在" });
      if (String(ticket.status) === "done") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "工单已关闭，不能认领" });
      }
      await getDb().execute(
        sql`UPDATE st_ops_tickets SET status = 'processing', assignee = ${name}
            WHERE id = ${input.ticketId}`,
      );
      writeTicketEvent(input.ticketId, name, "claim", { from: String(ticket.status) });
      writeAdminAudit(Number(admin.id), name, "opsTickets.claim", String(input.ticketId));
      return { ok: true as const, ticketId: input.ticketId, status: "processing" as const, assignee: name };
    }),

  /**
   * ticketReply：写 reply + 事件；若来源 feedback 且 ref_id 存在，
   * 尽力而为回写 st_skill_feedback.note 追加处理标记（静默，不阻断）。
   */
  ticketReply: publicQuery
    .input(
      tokenInput.extend({
        ticketId: z.number().int().positive(),
        reply: z.string().trim().min(1, "回复内容不能为空").max(4000),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const name = adminDisplayName(admin);
      const rows = await tryRows(
        sql`SELECT id, source, ref_id, status FROM st_ops_tickets WHERE id = ${input.ticketId} LIMIT 1`,
      );
      const ticket = rows?.[0];
      if (!ticket) throw new TRPCError({ code: "NOT_FOUND", message: "工单不存在" });
      if (String(ticket.status) === "done") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "工单已关闭，不能回复" });
      }
      await getDb().execute(
        sql`UPDATE st_ops_tickets SET reply = ${input.reply} WHERE id = ${input.ticketId}`,
      );
      writeTicketEvent(input.ticketId, name, "reply", { reply: input.reply.slice(0, 500) });
      // 来源 feedback：尽力回写处理标记（不阻断）
      if (String(ticket.source) === "feedback" && ticket.ref_id != null) {
        try {
          await getDb().execute(
            sql`UPDATE st_skill_feedback
                SET note = CONCAT(COALESCE(note, ''), ${` [工单#${input.ticketId} 已回复]`})
                WHERE id = ${Number(ticket.ref_id)}`,
          );
        } catch {
          // 静默
        }
      }
      writeAdminAudit(Number(admin.id), name, "opsTickets.reply", String(input.ticketId));
      return { ok: true as const, ticketId: input.ticketId };
    }),

  /** ticketClose：→ done + closed_at + 事件（note 可选） */
  ticketClose: publicQuery
    .input(
      tokenInput.extend({
        ticketId: z.number().int().positive(),
        note: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const name = adminDisplayName(admin);
      const rows = await tryRows(
        sql`SELECT id, status, note FROM st_ops_tickets WHERE id = ${input.ticketId} LIMIT 1`,
      );
      const ticket = rows?.[0];
      if (!ticket) throw new TRPCError({ code: "NOT_FOUND", message: "工单不存在" });
      if (String(ticket.status) === "done") {
        return { ok: true as const, ticketId: input.ticketId, status: "done" as const, duplicated: true as const };
      }
      const mergedNote =
        input.note == null
          ? (ticket.note == null ? null : String(ticket.note))
          : `${ticket.note == null ? "" : String(ticket.note) + "\n"}[关闭备注] ${input.note}`;
      await getDb().execute(
        sql`UPDATE st_ops_tickets SET status = 'done', closed_at = NOW(), note = ${mergedNote}
            WHERE id = ${input.ticketId}`,
      );
      writeTicketEvent(input.ticketId, name, "close", { note: input.note ?? null });
      writeAdminAudit(Number(admin.id), name, "opsTickets.close", String(input.ticketId));
      return { ok: true as const, ticketId: input.ticketId, status: "done" as const, duplicated: false as const };
    }),

  /** ticketCreate：手动建单（source='manual'） */
  ticketCreate: publicQuery
    .input(
      tokenInput.extend({
        factoryId: z.number().int().positive(),
        title: z.string().trim().min(1, "标题不能为空").max(191),
        note: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const name = adminDisplayName(admin);
      const factories = await tryRows(
        sql`SELECT id, enterpriseName FROM wb_factories WHERE id = ${input.factoryId} LIMIT 1`,
      );
      if (!factories?.[0]) {
        throw new TRPCError({ code: "NOT_FOUND", message: "企业不存在" });
      }
      const res = (await getDb().execute(
        sql`INSERT INTO st_ops_tickets (source, factory_id, ref_id, title, status, note)
            VALUES ('manual', ${input.factoryId}, NULL, ${input.title}, 'open', ${input.note ?? null})`,
      )) as unknown;
      const header = Array.isArray(res) ? (res[0] as { insertId?: number }) : {};
      let ticketId = Number(header?.insertId ?? 0);
      if (!ticketId) {
        const back = await tryRows(
          sql`SELECT id FROM st_ops_tickets WHERE factory_id = ${input.factoryId}
              ORDER BY id DESC LIMIT 1`,
        );
        ticketId = Number(back?.[0]?.id ?? 0);
      }
      writeTicketEvent(ticketId, name, "create", { source: "manual", title: input.title });
      writeAdminAudit(Number(admin.id), name, "opsTickets.create", String(ticketId), {
        factoryId: input.factoryId,
        title: input.title,
      });
      return { ok: true as const, ticketId };
    }),
});
