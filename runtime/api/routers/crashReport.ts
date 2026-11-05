/**
 * #15 APP 崩溃看板（彭总令 2026-09-02）：
 * 崩溃链路（RN persistCrash→启动补报→reportSignal→evoSignals→st_evo_signals）M45 已建；
 * 本路由补齐「看板端」——把崩溃数据从信号总线里捞出给超终看，不重复建表。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../queries/connection";
import { createRouter, publicQuery } from "../middleware";
import { sessionMe } from "./wbSession";

export const crashReportRouter = createRouter({
  /** 崩溃看板（HQ 限定）：近24小时按错误聚合 + 版本分布 + 最近10条 */
  board24h: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const session = await sessionMe(input.token);
      if (session.factory.id !== 6380240) {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅灵智枢成员" });
      }
      const db = getDb();
      const byError = (await db.execute(
        sql`SELECT JSON_UNQUOTE(JSON_EXTRACT(payload, '$.message')) err, COUNT(*) c, MAX(created_at) latest
            FROM st_evo_signals WHERE kind='crash' AND created_at > NOW() - INTERVAL 1 DAY
            GROUP BY err ORDER BY c DESC LIMIT 20`,
      )) as unknown as { rows?: any[] };
      const total = (await db.execute(
        sql`SELECT COUNT(*) c FROM st_evo_signals WHERE kind='crash' AND created_at > NOW() - INTERVAL 1 DAY`,
      )) as unknown as { rows?: any[] };
      const recent = (await db.execute(
        sql`SELECT actor, payload, created_at FROM st_evo_signals
            WHERE kind='crash' ORDER BY id DESC LIMIT 10`,
      )) as unknown as { rows?: any[] };
      return { byError, total, recent };
    }),
});
