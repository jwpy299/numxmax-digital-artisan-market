/**
 * todoCenter —— 统一待办中心（六刀第二刀，2026-08-30）。
 *
 * 边界（彭总定调）：只装企业业务待办——验收/续约/合伙人申请/邀请确权/厂牌整改；
 * 系统级票据（发布双签等）永不在此出现（留在超级终端）。
 * 每条待办带深链 ref（todo://<kind>/<id>），三端同数据。
 * 纪律：全只读聚合，单源失败不拖垮其他类（逐类独立 catch）。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { sessionMe } from "./wbSession";
import { rawRows } from "./terminal";

export type TodoKind = "review" | "renewal" | "partner" | "invite" | "brand";

export interface TodoItem {
  kind: TodoKind;
  ref: string; // todo://<kind>/<id> 深链
  title: string;
  at: string;
  urgent: boolean;
}

/** 紧迫判定（纯函数可测）：验收待 24h+/续约 ≤3 天/合伙人待处理/厂牌连坐中 → urgent */
export function isUrgent(kind: TodoKind, hoursWaiting: number, daysLeft: number | null): boolean {
  if (kind === "review") return hoursWaiting >= 24;
  if (kind === "renewal") return daysLeft != null && daysLeft <= 3;
  if (kind === "brand") return true;
  return false;
}

/** 深链生成（纯函数）：五端同认 todo:// 协议 */
export function todoRef(kind: TodoKind, id: number | string): string {
  return `todo://${kind}/${id}`;
}

export const todoCenterRouter = createRouter({
  /** 我的待办（登录态；scope=factory 本厂业务 / mine 我个人的邀请等） */
  myTodos: publicQuery
    .input(z.object({ token: z.string().trim().min(1), scope: z.enum(["factory", "mine"]).default("factory") }))
    .query(async ({ input }) => {
      const session = await sessionMe(input.token);
      const uid = Number(session.user.id);
      const fid = session.factory.id;
      const db = getDb();
      const todos: TodoItem[] = [];

      if (input.scope === "factory") {
        // ① 验收待办：delivered 工单
        try {
          const rows = rawRows(
            await db.execute(
              sql`SELECT id, order_no, title, TIMESTAMPDIFF(HOUR, updated_at, NOW()) AS waitH
                  FROM st_hire_orders WHERE factory_id=${fid} AND status='delivered' ORDER BY id DESC LIMIT 20`,
            ),
          ) as { id: number; order_no: string; title: string; waitH: number }[];
          for (const r of rows) todos.push({ kind: "review", ref: todoRef("review", r.order_no), title: `验收：${r.title}（${r.order_no}）`, at: `${r.waitH}h 前交付`, urgent: isUrgent("review", Number(r.waitH), null) });
        } catch { /* 表未建静默 */ }
        // ② 续约倒计时：7 天内到期合约
        try {
          const rows = rawRows(
            await db.execute(
              sql`SELECT r.id, a.name, TIMESTAMPDIFF(DAY, NOW(), r.endsAt) AS d
                  FROM agent_hire_records r JOIN agents a ON a.id=r.agentId
                  WHERE r.enterpriseId=${fid} AND r.status IN ('trial','active') AND r.endsAt <= DATE_ADD(NOW(), INTERVAL 7 DAY)
                  ORDER BY r.endsAt ASC LIMIT 10`,
            ),
          ) as { id: number; name: string; d: number }[];
          for (const r of rows) todos.push({ kind: "renewal", ref: todoRef("renewal", r.id), title: `续约：${r.name} 剩 ${Math.max(0, r.d)} 天`, at: "", urgent: isUrgent("renewal", 0, Number(r.d)) });
        } catch { /* 静默 */ }
        // ③ 合伙人申请（总部/厂管理员视角——本厂收到的）
        try {
          const rows = rawRows(
            await db.execute(sql`SELECT id, contact_name, city, role FROM st_partner_leads WHERE status='pending' ORDER BY id DESC LIMIT 10`),
          ) as { id: number; contact_name: string; city: string; role: string }[];
          for (const r of rows) todos.push({ kind: "partner", ref: todoRef("partner", r.id), title: `合伙人申请：${r.contact_name}（${r.city}·${r.role === "partner" ? "合伙人" : "代理人"}）`, at: "", urgent: false });
        } catch { /* 静默 */ }
        // ④ 厂牌整改（连坐降曝光中）
        try {
          const b = rawRows(
            await db.execute(sql`SELECT strike_count FROM st_factory_brand WHERE factory_id=${fid} AND exposure_tier='limited' LIMIT 1`),
          )[0];
          if (b) todos.push({ kind: "brand", ref: todoRef("brand", fid), title: `厂牌降曝光中（砸牌 ${Number(b.strike_count)}/3）——整改提升评分`, at: "", urgent: true });
        } catch { /* 静默 */ }
      } else {
        // 个人域：邀请确权（别人邀我入企）
        try {
          const rows = rawRows(
            await db.execute(
              sql`SELECT b.id, f.enterpriseName FROM st_identity_bindings b JOIN wb_factories f ON f.id=b.factory_id
                  WHERE b.user_id=${uid} AND b.status='invited' ORDER BY b.id DESC LIMIT 10`,
            ),
          ) as { id: number; enterpriseName: string }[];
          for (const r of rows) todos.push({ kind: "invite", ref: todoRef("invite", r.id), title: `邀请你加入「${r.enterpriseName}」——等你本人确认`, at: "", urgent: false });
        } catch { /* 静默 */ }
      }

      todos.sort((a, b) => Number(b.urgent) - Number(a.urgent));
      return { todos, count: todos.length, urgentCount: todos.filter((t) => t.urgent).length };
    }),
});
