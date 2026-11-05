/**
 * partner —— 城市合伙人/代理人模块（2026-08-30 彭总令）。
 *
 * 端点：overview（本城实况+制度摘要）/ apply（申请留资）/ myApplication（我的申请状态）。
 * 纪律：申请即 alert 汇报总部（汇报总线，不受免打扰限制）；
 * 同一人同城同角色有 pending 单即拒重（幂等防刷）；制度数字与在役定价同源，不写两份。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { sessionMe, resolveWbUserByToken } from "./wbSession";

/** v183 宽松会话（彭总实锤：个人用户未入企时 sessionMe 工厂缺失 → 合伙人模块整页加载失败）：
 * 工厂查不到也放行——userCity 照常返回，业务各端点自行判权 */
async function sessionLoose(token: string): Promise<{ user: Record<string, unknown>; factory: { id: number } | null }> {
  try {
    const s = await sessionMe(token);
    return { user: s.user as unknown as Record<string, unknown>, factory: { id: s.factory.id } };
  } catch {
    // sessionMe 连用户都验不过才 401
    const db = getDb();
    const full = await resolveWbUserByToken(db, token); // P3-6 双轨解析单点同引（私抄=守卫/迁移条件双写漂移面封死）
    if (!full) throw new TRPCError({ code: "UNAUTHORIZED", message: "token 无效或已过期" });
    const u = full as unknown as Record<string, unknown>;
    return { user: u, factory: null };
  }
}
import { rawRows } from "./terminal";
import { emitReport } from "./reportBus";
import { CITY_CN } from "./cityRuntime";

const PHONE = /^1\d{10}$/;

export const partnerRouter = createRouter({
  /** 总览：本城点亮实况 + 制度摘要（登录态） */
  overview: publicQuery.input(z.object({ token: z.string().min(1) })).query(async ({ input }) => {
    const session = await sessionLoose(input.token);
    const db = getDb();
    const userCity = (session.user as unknown as { city?: string | null }).city ?? null;
    const num = (r: Record<string, unknown>[]) => Number(r[0]?.c ?? 0);
    let cityStats = { enterprises: 0, users: 0 };
    if (userCity) {
      try {
        cityStats = {
          enterprises: num(rawRows(await db.execute(sql`SELECT COUNT(*) c FROM wb_factories WHERE disabled=0 AND city=${userCity}`))),
          users: num(rawRows(await db.execute(sql`SELECT COUNT(*) c FROM wb_users WHERE city=${userCity}`))),
        };
      } catch { /* 静默 */ }
    }
    const partnerCount = num(rawRows(await db.execute(sql`SELECT COUNT(*) c FROM st_partner_leads WHERE status='signed'`).catch(() => [[]] as unknown[])));
    return {
      userCity,
      cityName: userCity ? (CITY_CN[userCity] ?? userCity) : null,
      cityStats,
      partnerCount,
      // 制度摘要（与 PDF v1.0 同口径）
      rules: {
        partnerDeposit: 50000, agentDeposit: 10000,
        sharePartner: "20%-30% 阶梯", shareAgent: "15%-22% 阶梯",
        openCities: ["foshan", "zhaoqing"],
      },
    };
  }),

  /** 申请（登录态）：幂等防刷（同城同角色 pending 即拒重） */
  submitApplication: publicQuery
    .input(
      z.object({
        token: z.string().min(1),
        city: z.string().trim().min(1).max(16),
        role: z.enum(["partner", "agent"]),
        contactName: z.string().trim().min(2).max(64),
        contactPhone: z.string().trim().regex(PHONE, "手机号格式不正确"),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const session = await sessionLoose(input.token);
      const uid = Number((session.user as unknown as { id?: number }).id ?? 0);
      const db = getDb();
      const dup = rawRows(
        await db.execute(
          sql`SELECT id FROM st_partner_leads WHERE user_id=${uid} AND city=${input.city} AND role=${input.role} AND status='pending' LIMIT 1`,
        ),
      );
      if (dup.length > 0) throw new TRPCError({ code: "BAD_REQUEST", message: "你已提交过该城市的申请，工作人员会尽快联系你" });
      await db.execute(
        sql`INSERT INTO st_partner_leads (user_id, city, role, contact_name, contact_phone, note)
            VALUES (${uid}, ${input.city}, ${input.role}, ${input.contactName}, ${input.contactPhone}, ${input.note ?? null})`,
      );
      const cn = CITY_CN[input.city] ?? input.city;
      const roleCn = input.role === "partner" ? "城市合伙人" : "城市代理人";
      // alert 级：不受免打扰限制，总部立即可见
      await emitReport({
        audience: "factory", level: "alert", sourceRing: "channel",
        title: `🤝 ${roleCn}申请：${input.contactName}（${cn}）`,
        body: `电话 ${input.contactPhone}。${input.note ? `备注：${input.note.slice(0, 200)}` : ""}请到超级终端「渠道舱」合伙人队列处理。`,
        dedupeKey: `partner:apply:${uid}:${input.city}:${input.role}:${new Date().toISOString().slice(0, 13)}`,
      });
      return { ok: true as const };
    }),

  /** 我的申请（登录态） */
  myApplication: publicQuery.input(z.object({ token: z.string().min(1) })).query(async ({ input }) => {
    const session = await sessionLoose(input.token);
    const uid = Number((session.user as unknown as { id?: number }).id ?? 0);
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT id, city, role, status, DATE_FORMAT(created_at, '%m-%d %H:%i') AS at FROM st_partner_leads WHERE user_id=${uid} ORDER BY id DESC LIMIT 5`,
      ),
    ) as { id: number; city: string; role: string; status: string; at: string }[];
    return {
      applications: rows.map((r) => ({ ...r, cityName: CITY_CN[r.city] ?? r.city, roleName: r.role === "partner" ? "城市合伙人" : "城市代理人" })),
    };
  }),
});
