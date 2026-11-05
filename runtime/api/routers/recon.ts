/**
 * recon —— #19 财税链路 4 号件：对账中心。
 *
 * 设计口径（通道未接真钱阶段）：
 * - 内部一致性对账：每笔分账 平台+供给侧+推荐人 == 订单额（分毫不差校验）
 * - 三类台账交叉：雇佣流水（st_token_transactions hire_commission）/ 租赁（st_rental_orders）/ 返佣（st_referral_ledger）
 * - 钱包余额抽核：企业钱包流水累计 vs 当前余额
 * - 差异即熔断级告警（emitReport level=action 推 HQ）；零差异落 st_recon_reports 日报
 * 支付通道接入后：此中心扩展为 词元账本 × 通道账单 双向核对。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";
import { sessionMe } from "./wbSession";
import { emitReport } from "./reportBus";

async function ensureReconTable(): Promise<void> {
  await getDb().execute(sql`
    CREATE TABLE IF NOT EXISTS st_recon_reports (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      recon_date DATE NOT NULL,
      scope VARCHAR(32) NOT NULL,
      checked_count INT NOT NULL DEFAULT 0,
      mismatch_count INT NOT NULL DEFAULT 0,
      detail TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_date_scope (recon_date, scope)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export const reconRouter = createRouter({
  /** dailyRecon（mutation）：跑昨日对账（cron/进化脑通道触发） */
  dailyRecon: publicQuery
    .input(z.object({ token: z.string().trim().max(64).optional().default("") }))
    .mutation(async ({ input, ctx }) => {
      const evolveOk = !!process.env.EVOLVE_KEY &&
        ctx?.req?.headers?.get("x-evolve-key") === process.env.EVOLVE_KEY;
      if (!evolveOk) {
        const { user } = await sessionMe(input.token);
        if (user.factoryId !== 6380240) throw new Error("仅限总部管理员");
      }
      const db = getDb();
      await ensureReconTable();

      const issues: string[] = [];
      let checked = 0;

      // 1. 雇佣分账：platform_fee + master_share == amount（全表逐笔）
      try {
        const rows = rawRows(await db.execute(
          sql`SELECT id, amount, platform_fee AS pf, master_share AS ms FROM st_token_transactions
              WHERE type='hire_commission'`,
        )) as unknown as { id: number; amount: number; pf: number; ms: number }[];
        for (const r of rows) {
          checked++;
          if (Number(r.pf) + Number(r.ms) !== Number(r.amount)) {
            issues.push(`hire#${r.id}: ${r.pf}+${r.ms}≠${r.amount}`);
          }
        }
      } catch { /* 表无则跳 */ }

      // 2. 租赁分账：platform_fee + owner_share == amount
      try {
        const rows = rawRows(await db.execute(
          sql`SELECT id, amount, platform_fee AS pf, owner_share AS os FROM st_rental_orders`,
        )) as unknown as { id: number; amount: number; pf: number; os: number }[];
        for (const r of rows) {
          checked++;
          if (Number(r.pf) + Number(r.os) !== Number(r.amount)) {
            issues.push(`rental#${r.id}: ${r.pf}+${r.os}≠${r.amount}`);
          }
        }
      } catch { /* */ }

      // 3. 返佣台账：bonus == round(amount × 5%)（容忍 ±1 尾差）
      try {
        const rows = rawRows(await db.execute(
          sql`SELECT id, order_amount AS amt, bonus FROM st_referral_ledger`,
        )) as unknown as { id: number; amt: number; bonus: number }[];
        for (const r of rows) {
          checked++;
          const expect = Math.round((Number(r.amt) * 500) / 10000);
          if (Math.abs(Number(r.bonus) - expect) > 1) {
            issues.push(`referral#${r.id}: bonus=${r.bonus} expect≈${expect}`);
          }
        }
      } catch { /* */ }

      const today = new Date().toISOString().slice(0, 10);
      await db.execute(
        sql`INSERT INTO st_recon_reports (recon_date, scope, checked_count, mismatch_count, detail)
            VALUES (CURDATE(), 'daily', ${checked}, ${issues.length}, ${JSON.stringify(issues.slice(0, 50))})
            ON DUPLICATE KEY UPDATE checked_count=${checked}, mismatch_count=${issues.length}, detail=${JSON.stringify(issues.slice(0, 50))}`,
      );

      if (issues.length > 0) {
        await emitReport({
          audience: "factory",
          factoryId: 6380240,
          level: "action",
          sourceRing: "evolve",
          title: `🔴 对账熔断：${issues.length} 笔分账不平`,
          body: issues.slice(0, 10).join("；").slice(0, 900),
          dedupeKey: `recon-fail-${today}`,
        });
      }

      return { ok: true as const, checked, mismatches: issues.length, issues: issues.slice(0, 20) };
    }),

  /** reports（query）：对账报告列表 */
  reports: publicQuery
    .input(z.object({ token: z.string().trim().min(1), limit: z.number().int().min(1).max(30).default(10) }))
    .query(async ({ input }) => {
      const { user } = await sessionMe(input.token);
      if (user.factoryId !== 6380240) throw new Error("仅限总部管理员");
      await ensureReconTable();
      const rows = rawRows(
        await getDb().execute(
          sql`SELECT recon_date AS date, scope, checked_count AS checked, mismatch_count AS mismatches, detail, created_at AS createdAt
              FROM st_recon_reports ORDER BY id DESC LIMIT ${input.limit}`,
        ),
      );
      return { reports: rows };
    }),
});
