/**
 * nebulaScreen —— 人机共生实时大屏（2026-08-29 彭总令：佛山/肇庆先行，上线当天就连真系统）。
 *
 * 纪律：
 * - 全部读真实业务表，一个假数字都没有；
 * - 隐私红线：企业可实名（对公实体），个人用户一律匿名（个人用户#尾号），手机号/身份信息绝不出端；
 * - 公开只读聚合，无需登录；查询全部轻量 COUNT/LIMIT，10s 轮询量级无压力。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";

interface CityBucket {
  enterprises: number;
  users: number;
  devices: number;
  agents: number;
}

export const nebulaScreenRouter = createRouter({
  /** 大屏快照：全城点亮数 + 总量 + 实时点亮流 + 汇报真流；v171 支持 ?city= 城市分屏过滤 */
  snapshot: publicQuery
    .input(z.object({ token: z.string().optional(), city: z.string().trim().max(16).optional() }).optional())
    .query(async ({ input }) => {
    const focusCity = input?.city || null;
    const db = getDb();
    const num = (rows: Record<string, unknown>[]) => Number(rows[0]?.c ?? 0);

    const safeCount = async (q: ReturnType<typeof sql>): Promise<number> => {
      try { return num(rawRows(await db.execute(q))); } catch { return 0; }
    };

    // v171 全城点亮：GROUP BY 一次查清（city 列缺失时静默空表，不炸大屏）
    const cityMap: Record<string, CityBucket> = {};
    try {
      const ef = rawRows(await db.execute(sql`SELECT city, COUNT(*) c FROM wb_factories WHERE disabled = 0 GROUP BY city`)) as { city: string | null; c: number }[];
      const uf = rawRows(await db.execute(sql`SELECT city, COUNT(*) c FROM wb_users GROUP BY city`)) as { city: string | null; c: number }[];
      const keys = new Set([...ef.map(r => r.city ?? ""), ...uf.map(r => r.city ?? "")]);
      for (const k of keys) {
        cityMap[k || "unassigned"] = {
          enterprises: Number(ef.find(r => (r.city ?? "") === k)?.c ?? 0),
          users: Number(uf.find(r => (r.city ?? "") === k)?.c ?? 0),
          devices: 0, agents: 0,
        };
      }
    } catch { /* city 列未建：全空，大屏显示待点亮 */ }

    // 总量（全城）
    const totals = {
      enterprises: await safeCount(sql`SELECT COUNT(*) c FROM wb_factories WHERE disabled = 0`),
      users: await safeCount(sql`SELECT COUNT(*) c FROM wb_users`),
      devices: await safeCount(sql`SELECT COUNT(*) c FROM st_devices`),
      personalAgents: await safeCount(sql`SELECT COUNT(*) c FROM st_personal_agents`),
      entAgents: await safeCount(sql`SELECT COUNT(*) c FROM st_ent_agents`),
      deliveries: await safeCount(sql`SELECT COUNT(*) c FROM st_delivery_acceptances`),
      weeklyDeliveries: await safeCount(sql`SELECT COUNT(*) c FROM st_delivery_acceptances WHERE accepted_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`),
    };

    // 实时点亮流：最近的新企业/新用户/新验收/新上架（跨表 union 取最近 12 条；v171 城市分屏时过滤本城企业/个人，无城市字段的交付/分身不冒充属地）
    let recent: { kind: string; label: string; city: string | null; at: string }[] = [];
    try {
      const unionCore = focusCity
        ? sql`
            SELECT 'enterprise' AS kind, enterpriseName COLLATE utf8mb4_unicode_ci AS label, city COLLATE utf8mb4_unicode_ci AS city, DATE_FORMAT(createdAt, '%m-%d %H:%i') AS at, createdAt AS ts
              FROM wb_factories WHERE disabled = 0
            UNION ALL
            SELECT 'user', CONCAT('个人用户#', id % 10000) COLLATE utf8mb4_unicode_ci, city COLLATE utf8mb4_unicode_ci, DATE_FORMAT(createdAt, '%m-%d %H:%i'), createdAt FROM wb_users`
        : sql`
            SELECT 'enterprise' AS kind, enterpriseName COLLATE utf8mb4_unicode_ci AS label, city COLLATE utf8mb4_unicode_ci AS city, DATE_FORMAT(createdAt, '%m-%d %H:%i') AS at, createdAt AS ts
              FROM wb_factories WHERE disabled = 0
            UNION ALL
            SELECT 'user', CONCAT('个人用户#', id % 10000) COLLATE utf8mb4_unicode_ci, city COLLATE utf8mb4_unicode_ci, DATE_FORMAT(createdAt, '%m-%d %H:%i'), createdAt FROM wb_users
            UNION ALL
            SELECT 'delivery', CONCAT('验收交付 #', id) COLLATE utf8mb4_unicode_ci, NULL, DATE_FORMAT(accepted_at, '%m-%d %H:%i'), accepted_at FROM st_delivery_acceptances
            UNION ALL
            SELECT 'agent', CONCAT('数字员工 #', id, '（', COALESCE(status, 'chat'), '）') COLLATE utf8mb4_unicode_ci, NULL, DATE_FORMAT(created_at, '%m-%d %H:%i'), created_at FROM st_personal_agents`;
      const rows = rawRows(
        await db.execute(sql`SELECT * FROM (${unionCore}) t ${focusCity ? sql`WHERE t.city = ${focusCity}` : sql``} ORDER BY ts DESC LIMIT 12`),
      ) as (typeof recent[number] & { ts?: string })[];
      recent = rows.map(({ kind, label, city, at }) => ({ kind, label, city, at }));
    } catch (e) {
      const err = e as Error & { cause?: Error };
      console.info("[nebulaScreen] recent 查询失败:", String(err?.cause?.message ?? err?.message ?? e).slice(0, 240));
    }

    // v172 城市运营官（表未建静默空表）
    let officers: { city: string; name: string; state: string; beatAt: string | null }[] = [];
    try {
      officers = (rawRows(
        await db.execute(sql`SELECT city, officer_name, state, DATE_FORMAT(last_beat_at, '%m-%d %H:%i') AS beat FROM st_city_agents`),
      ) as { city: string; officer_name: string; state: string; beat: string | null }[])
        .map((r) => ({ city: r.city, name: r.officer_name, state: r.state, beatAt: r.beat }));
    } catch { /* 静默 */ }

    // 汇报真流（最近 8 条已发送/待发送的汇报事件，标题级）
    let reports: { title: string; level: string; at: string }[] = [];
    try {
      reports = rawRows(
        await db.execute(sql`SELECT title, level, DATE_FORMAT(created_at, '%m-%d %H:%i') AS at FROM st_report_events ORDER BY id DESC LIMIT 8`),
      ) as typeof reports;
    } catch { /* 静默 */ }

    return {
      // v171：全城字典（key=city 英文码，unassigned=待点亮）；兼容旧字段 foshan/zhaoqing/unassigned
      cities: cityMap,
      foshan: cityMap.foshan ?? { enterprises: 0, users: 0, devices: 0, agents: 0 },
      zhaoqing: cityMap.zhaoqing ?? { enterprises: 0, users: 0, devices: 0, agents: 0 },
      unassigned: cityMap.unassigned ?? { enterprises: 0, users: 0, devices: 0, agents: 0 },
      focus: focusCity,
      officers,
      totals,
      recent,
      reports,
      generatedAt: new Date().toISOString(),
    };
  }),
});
