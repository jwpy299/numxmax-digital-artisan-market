/**
 * #5 用户操作审计（彭总令 2026-09-02，技术债治理）：
 * 敏感动作（合伙人处置/队列认领/工单验收/舱主任命/充值审核）统一留痕 st_user_audit。
 * 纪律：审计失败绝不阻塞业务主链（fire-and-forget，同 st_llm_events 口径）。
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getDb } from "../queries/connection";
import { logQueryErrorThrottled, warnThrottled } from "../queries/rawRows"; // R7-c56-⑦：审计写入失败脱敏留痕（不再静默吞）；R7-c159-⑩：良性道同引
import { isNoSuchTable } from "../auth/identity"; // R7-c159-⑩：1146 谓词单源同引
import { createRouter, publicQuery } from "../middleware";
import { sessionMe } from "./wbSession";

export function auditUserAction(opts: {
  userId: number; // R7-c56-⑦/R7-c57-③/R7-c76-⑦：生产实证 st_user_audit.user_id bigint NOT NULL——NULL 会被拒（审计行丢失）；
  //  委派/原生席走 wbThreadUserId 分带键（wb 空间——裸 id 撞 wb 同号会让 stats24h 聚合叠人；调用方同引 authLock 口径），detail.operatorOrigin 消歧留底
  userName?: string;
  action: string;
  targetType: string;
  targetId?: string | number;
  detail?: unknown;
  ip?: string;
}): void {
  try {
    const db = getDb();
    void db
      .execute(
        sql`INSERT INTO st_user_audit (user_id, user_name, action, target_type, target_id, detail_json, ip)
            VALUES (${opts.userId}, ${opts.userName ?? ""}, ${opts.action}, ${opts.targetType},
                    ${String(opts.targetId ?? "")}, ${JSON.stringify(opts.detail ?? null)}, ${opts.ip ?? ""})`,
      )
      .catch((e) => {
        // R7-c159-⑩ bug low：1146（表未建=部署面缺席）归良性道——不再与真事故同灌事故道（未部署环境每次审计都灌=告警疲劳面封死）；
        //  R7-c56-⑦：FK/NOT NULL/超长等真事故照旧 logQueryErrorThrottled——审计链可信（委派/原生席 NULL 写入若被拒至少有痕）
        if (isNoSuchTable(e)) { warnThrottled("userAudit.no-table", "[userAudit] st_user_audit 表未建——审计写入跳过（db 迁移未执行，非业务事故）"); return; }
        logQueryErrorThrottled("[userAudit] 审计写入失败", e);
      });
  } catch (e) {
    // R7-c67-④：同步段失败（getDb 构造/sql 模板构建/JSON.stringify 循环引用）也走脱敏节流留痕——空 catch 静默面封死（仍吞错不阻塞业务主链）
    logQueryErrorThrottled("[userAudit] 审计写入失败（同步段）", e);
  }
}

export const userAuditRouter = createRouter({
  /** 审计查询（HQ 限定）：按动作/对象/时间筛选最近 100 条 */
  list: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      action: z.string().trim().max(64).optional(),
      targetType: z.string().trim().max(32).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }))
    .query(async ({ input }) => {
      const session = await sessionMe(input.token);
      if (session.factory.id !== 6380240) {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅灵智枢成员可查审计" });
      }
      const db = getDb();
      const rows = (await db.execute(
        sql`SELECT id, user_id, user_name, action, target_type, target_id, detail_json, ip, created_at
            FROM st_user_audit
            ${input.action ? sql`WHERE action=${input.action}` : sql``}
            ${input.action && input.targetType ? sql`AND` : input.targetType ? sql`WHERE` : sql``}
            ${input.targetType ? sql`target_type=${input.targetType}` : sql``}
            ORDER BY id DESC LIMIT ${input.limit}`,
      )) as unknown as { rows?: any[] };
      return { items: rows };
    }),

  /** 审计统计（HQ 限定）：近24小时按动作分组计数 */
  stats24h: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const session = await sessionMe(input.token);
      if (session.factory.id !== 6380240) {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅灵智枢成员可查审计" });
      }
      const db = getDb();
      const rows = (await db.execute(
        sql`SELECT action, COUNT(*) c, COUNT(DISTINCT user_id) operators
            FROM st_user_audit WHERE created_at > NOW() - INTERVAL 1 DAY
            GROUP BY action ORDER BY c DESC`,
      )) as unknown as { rows?: any[] };
      return { items: rows };
    }),
});
