/**
 * reportBus —— 汇报总线（2026-08-26 彭总令：环/部门智能体→个人APP/组织APP 随时汇报）。
 *
 * 架构：emit（环事件入队，dedupe 唯一键防骚扰）→ sweep（挂 proactiveJobs 现有 10 分钟环，
 * 按 st_identity_bindings 路由展开收件人，节流=每日上限+免打扰）→ 读取（APP 汇报中心）。
 *
 * 纪律：
 * - 新增逻辑整体 try/catch 隔离——汇报总线故障绝不拖垮 proactiveJobs 原触发器（R4）；
 * - factoryId 服务端口径；个人只见自己的、组织只见本厂的；
 * - level: info 站内 / action 待办 / alert C级（短信腿待翼讯通点火后接）。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { sessionMe } from "./wbSession";
import { rawRows } from "../queries/rawRows"; // 战区④批A-lite：私有副本退役→canonical 叶单源

const tokenInput = { token: z.string().trim().min(1) };


export interface ReportEmit {
  audience: "personal" | "factory";
  userId?: number;
  factoryId?: number;
  level?: "info" | "action" | "alert";
  sourceRing?: string;
  title: string;
  body: string;
  actionUrl?: string;
  dedupeKey: string;
}

/** emit：环/部门模块的唯一写入入口（服务端内部调用，dedupe 撞键静默跳过） */
export async function emitReport(e: ReportEmit): Promise<boolean> {
  try {
    await getDb().execute(
      sql`INSERT IGNORE INTO st_report_events (audience, user_id, factory_id, level, source_ring, title, body, action_url, dedupe_key)
          VALUES (${e.audience}, ${e.userId ?? null}, ${e.factoryId ?? null}, ${e.level ?? "info"}, ${e.sourceRing ?? null},
                  ${e.title.slice(0, 128)}, ${e.body.slice(0, 1024)}, ${e.actionUrl ?? null}, ${e.dedupeKey})`,
    );
    return true;
  } catch {
    return false; // 总线故障静默（R4）
  }
}

/** 免打扰判断（纯规则，可测）：当前时刻是否在 quiet 窗内（支持跨夜） */
export function inQuietHours(nowHHmm: string, start: string, end: string): boolean {
  if (start === end) return false;
  if (start < end) return nowHHmm >= start && nowHHmm < end;
  return nowHHmm >= start || nowHHmm < end; // 跨夜（22:00-08:00）
}

/** sweep：pending → sent（路由展开+节流）。挂 runProactiveSweep 尾部，独立 try/catch。 */
export async function runReportSweep(now: Date = new Date()): Promise<{ sent: number; throttled: number }> {
  const db = getDb();
  let sent = 0;
  let throttled = 0;
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  // factory 级汇报展开到 active 成员（身份绑定路由表）
  await db.execute(
    sql`INSERT IGNORE INTO st_report_events (audience, user_id, factory_id, level, source_ring, title, body, action_url, dedupe_key, status)
        SELECT 'personal', b.user_id, r.factory_id, r.level, r.source_ring, r.title, r.body, r.action_url,
               CONCAT(r.dedupe_key, ':u', b.user_id), 'pending'
        FROM st_report_events r JOIN st_identity_bindings b ON b.factory_id=r.factory_id AND b.status='active'
        WHERE r.audience='factory' AND r.status='pending'`,
  );
  await db.execute(sql`UPDATE st_report_events SET status='sent', sent_at=NOW() WHERE audience='factory' AND status='pending'`);
  // 个人级投递（节流：每日上限+免打扰；alert 不受免打扰限制——C级必达）
  const pendings = rawRows(
    await db.execute(sql`SELECT id, user_id AS userId, level FROM st_report_events WHERE audience='personal' AND status='pending' LIMIT 200`),
  );
  for (const p of pendings) {
    const prefs = rawRows(await db.execute(sql`SELECT daily_cap AS cap, quiet_start AS qs, quiet_end AS qe FROM st_report_prefs WHERE user_id=${Number(p.userId)} LIMIT 1`));
    const cap = Number(prefs[0]?.cap ?? 10);
    const qs = String(prefs[0]?.qs ?? "22:00");
    const qe = String(prefs[0]?.qe ?? "08:00");
    if (p.level !== "alert" && inQuietHours(hhmm, qs, qe)) { throttled++; continue; }
    const today = rawRows(
      await db.execute(sql`SELECT COUNT(*) AS c FROM st_report_events WHERE user_id=${Number(p.userId)} AND audience='personal' AND status IN ('sent','read') AND sent_at >= CURDATE()`),
    );
    if (p.level !== "alert" && Number(today[0]?.c ?? 0) >= cap) { throttled++; continue; }
    await db.execute(sql`UPDATE st_report_events SET status='sent', sent_at=NOW() WHERE id=${Number(p.id)}`);
    sent++;
  }
  return { sent, throttled };
}

export const reportBusRouter = createRouter({
  /** APP 汇报中心：我的汇报（个人级 + 我所在厂的厂级标题透传） */
  myReports: publicQuery.input(z.object({ ...tokenInput, limit: z.number().int().min(1).max(50).default(20) })).query(async ({ input }) => {
    const session = await sessionMe(input.token);
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT id, level, source_ring AS sourceRing, title, body, action_url AS actionUrl, sent_at AS sentAt, read_at AS readAt
            FROM st_report_events WHERE audience='personal' AND user_id=${session.user.id} AND status IN ('sent','read')
            ORDER BY id DESC LIMIT ${input.limit}`,
      ),
    );
    return { reports: rows };
  }),

  markRead: publicQuery.input(z.object({ ...tokenInput, reportId: z.number().int().positive() })).mutation(async ({ input }) => {
    const session = await sessionMe(input.token);
    await getDb().execute(
      sql`UPDATE st_report_events SET status='read', read_at=NOW() WHERE id=${input.reportId} AND user_id=${session.user.id} AND status='sent'`,
    );
    return { ok: true };
  }),

  /** 未读数（APP 角标） */
  unreadCount: publicQuery.input(z.object(tokenInput)).query(async ({ input }) => {
    const session = await sessionMe(input.token);
    const rows = rawRows(
      await getDb().execute(sql`SELECT COUNT(*) AS c FROM st_report_events WHERE audience='personal' AND user_id=${session.user.id} AND status='sent'`),
    );
    return { unread: Number(rows[0]?.c ?? 0) };
  }),

  /** v177 汇报追问（六刀第三刀：汇报不再只推不答）——追问落成对源环的 action 级回报 */
  reply: publicQuery
    .input(z.object({ ...tokenInput, reportId: z.number().int().positive(), text: z.string().trim().min(1).max(500) }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const db = getDb();
      const src = rawRows(await db.execute(sql`SELECT id, factory_id, source_ring, title FROM st_report_events WHERE id=${input.reportId} LIMIT 1`))[0];
      if (!src) throw new TRPCError({ code: "NOT_FOUND", message: "汇报不存在" });
      // 追问回源环：action 级（穿免打扰），dedupe 按人按条按小时防刷
      await emitReport({
        audience: "factory", factoryId: Number(src.factory_id ?? session.factory.id), level: "action",
        sourceRing: String(src.source_ring ?? "reply"),
        title: `💬 追问「${String(src.title).slice(0, 40)}」`,
        body: `${String(session.user.displayName ?? "用户")}：${input.text}`,
        dedupeKey: `report:reply:${input.reportId}:${session.user.id}:${new Date().toISOString().slice(0, 13)}`,
      });
      return { ok: true as const };
    }),

  /** v177 汇报转派：转给本厂另一名绑定成员（本人确权制外，转派也是确权） */
  forward: publicQuery
    .input(z.object({ ...tokenInput, reportId: z.number().int().positive(), toUserId: z.number().int().positive(), note: z.string().trim().max(200).optional() }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const db = getDb();
      const src = rawRows(await db.execute(sql`SELECT id, factory_id, title, body FROM st_report_events WHERE id=${input.reportId} LIMIT 1`))[0];
      if (!src) throw new TRPCError({ code: "NOT_FOUND", message: "汇报不存在" });
      // 接收人必须是本厂已确权成员
      // ⚠️ 状态词表修复（2026-10-04）：原写 status='bound' —— 幽灵值，见 entCabin.setHead 同注。
      //   此处**无**自任旁路 ⇒ 原条件下「定向汇报投递给任何成员」**100% 失败**（恒 FORBIDDEN）。
      const bound = rawRows(
        await db.execute(sql`SELECT id FROM st_identity_bindings WHERE user_id=${input.toUserId} AND factory_id=${Number(src.factory_id ?? session.factory.id)} AND status='active' LIMIT 1`),
      )[0];
      if (!bound) throw new TRPCError({ code: "FORBIDDEN", message: "对方不是本厂成员" });
      await emitReport({
        audience: "personal", userId: input.toUserId, level: "action", sourceRing: "forward",
        title: `📨 转派：「${String(src.title).slice(0, 40)}」`,
        body: `${String(session.user.displayName ?? "同事")} 转派给你${input.note ? `：${input.note}` : "。"}`,
        dedupeKey: `report:fwd:${input.reportId}:${input.toUserId}`,
      });
      return { ok: true as const };
    }),
});
