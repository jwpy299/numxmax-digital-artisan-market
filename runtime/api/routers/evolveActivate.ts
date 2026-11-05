/**
 * evolveActivate —— 双脑架构 2 号件：activate（小脑呼叫进化脑）+ intervene（大脑下处方）。
 *
 * 彭总拍板图纸（2026-09-03）：
 * - activate：同一异常信号 24h≥3 次 → 写 st_evolve_inbox（攒着等大脑上线消化）+ 通知 HQ；
 *   超 72h 未消化的高优事件升级推送老板（兜底）
 * - intervene：提案式（非命令式）——只写 st_evo_proposals（pending）走输送带人工双签；
 *   白名单类型（threshold_tune/fallback_reorder/proposal_inject/memory_rollback），
 *   类型外一律拒绝+告警+审计（防注入铁律）；每条干预自带 expires_at 时效
 * - 鉴权：X-Evolve-Key 机器签名（nebula.env EVOLVE_KEY），不接受用户 token（机器通道专用）
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";
import { emitReport } from "./reportBus";

const HQ_FACTORY = 6380240;

/** 干预白名单（类型外拒绝） */
const INTERVENE_TYPES = ["threshold_tune", "fallback_reorder", "proposal_inject", "memory_rollback"] as const;

function isEvolveKey(key: string | undefined): boolean {
  const expected = process.env.EVOLVE_KEY;
  return !!expected && !!key && key === expected;
}

async function ensureEvolveInbox(): Promise<void> {
  await getDb().execute(sql`
    CREATE TABLE IF NOT EXISTS st_evolve_inbox (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      signal_kind VARCHAR(48) NOT NULL,
      occurrences INT NOT NULL,
      window_hours INT NOT NULL DEFAULT 24,
      payload TEXT,
      priority VARCHAR(8) NOT NULL DEFAULT 'normal',
      status VARCHAR(12) NOT NULL DEFAULT 'pending',
      digested_by VARCHAR(24),
      digested_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_kind_window (signal_kind, window_hours, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export const evolveActivateRouter = createRouter({
  /** activateScan（mutation）：小脑呼叫规则——同一异常 24h≥3 次进进化脑收件箱 */
  activateScan: publicQuery
    .input(z.object({ key: z.string().trim().min(1) }))
    .mutation(async ({ input, ctx }) => {
      if (!isEvolveKey(ctx?.req?.headers?.get("x-evolve-key") ?? undefined) && input.key !== process.env.EVOLVE_KEY) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "机器通道专用" });
      }
      const db = getDb();
      await ensureEvolveInbox();
      // 24h 内同一信号 kind ≥3 次
      const hot = rawRows(
        await db.execute(
          sql`SELECT kind, COUNT(*) AS c FROM st_evo_signals
              WHERE created_at >= NOW() - INTERVAL 1 DAY AND (kind != 'spirit_intent' OR JSON_UNQUOTE(JSON_EXTRACT(payload,'$.ok')) = 'false') -- P2-6 票③+R5 票④：spirit_intent 正常流量（ok:true）不参与异常升级，其 LLM 失败面（ok:false）保留升级通道
              GROUP BY kind HAVING c >= 3 ORDER BY c DESC LIMIT 10`,
        ),
      ) as unknown as { kind: string; c: number }[];

      let escalated = 0;
      for (const h of hot) {
        try {
          // 票⑥：spirit_intent 样本取失败面（证据匹配计数子集，不拿正常流量当证据）
          const okFilter = h.kind === "spirit_intent" ? sql`AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.ok')) = 'false'` : sql``;
          const sample = rawRows(
            await db.execute(
              sql`SELECT payload FROM st_evo_signals WHERE kind=${h.kind} ${okFilter} ORDER BY id DESC LIMIT 1`,
            ),
          );
          await db.execute(
            sql`INSERT INTO st_evolve_inbox (signal_kind, occurrences, payload, priority)
                VALUES (${h.kind}, ${Number(h.c)}, ${JSON.stringify(sample[0] ?? {}).slice(0, 1500)}, ${Number(h.c) >= 5 ? "high" : "normal"})
                ON DUPLICATE KEY UPDATE occurrences=${Number(h.c)}, payload=VALUES(payload), created_at=NOW()`,
          );
          escalated++;
        } catch { /* 单条失败不挡批量 */ }
      }

      if (escalated > 0) {
        const today = new Date().toISOString().slice(0, 10);
        await emitReport({
          audience: "factory",
          factoryId: HQ_FACTORY,
          level: "action",
          sourceRing: "evolve",
          title: `🧠 小脑呼叫进化脑：${escalated} 类异常反复出现`,
          body: hot.map((h) => `${h.kind}×${h.c}`).join("；").slice(0, 900),
          dedupeKey: `evolve-call-${today}-${escalated}`,
        });
      }
      return { ok: true as const, escalated, hot };
    }),

  /** inbox（query）：进化脑收件箱（我上线先读这里） */
  inbox: publicQuery
    .input(z.object({ key: z.string().trim().min(1), status: z.enum(["pending", "digested", "all"]).default("pending") }))
    .query(async ({ input, ctx }) => {
      if (!isEvolveKey(ctx?.req?.headers?.get("x-evolve-key") ?? undefined) && input.key !== process.env.EVOLVE_KEY) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "机器通道专用" });
      }
      const db = getDb();
      await ensureEvolveInbox();
      const rows = rawRows(
        input.status === "all"
          ? await db.execute(sql`SELECT * FROM st_evolve_inbox ORDER BY id DESC LIMIT 30`)
          : await db.execute(sql`SELECT * FROM st_evolve_inbox WHERE status=${input.status} ORDER BY id DESC LIMIT 30`),
      );
      return { inbox: rows };
    }),

  /** intervene（mutation）：大脑下处方——只写提案（pending）走输送带双签；白名单外拒绝+告警 */
  intervene: publicQuery
    .input(z.object({
      key: z.string().trim().min(1),
      type: z.enum(INTERVENE_TYPES),
      target: z.string().trim().min(1).max(128),
      reason: z.string().trim().min(1).max(500),
      strategy: z.string().trim().min(1).max(1500),
      expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!isEvolveKey(ctx?.req?.headers?.get("x-evolve-key") ?? undefined) && input.key !== process.env.EVOLVE_KEY) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "机器通道专用" });
      }
      // 时效校验：过期提案直接拒
      if (new Date(input.expiresAt).getTime() < Date.now()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "干预提案已过期（expires_at 早于当前），请重新签发" });
      }
      const db = getDb();
      const rationale = `[进化脑干预·${input.type}] 目标：${input.target}\n诊断：${input.reason}\n处方：${input.strategy}\n时效：${input.expiresAt}`;
      const now = new Date();
      const week = `${now.getFullYear()}-W${String(Math.ceil((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 604800000)).padStart(2, "0")}`; // week 列必填（历史结构 YYYY-Www）
      const ins = await db.execute(
        sql`INSERT INTO st_evo_proposals (week, target_type, factory_id, proposal_type, title, rationale, status, created_at)
            VALUES (${week}, 'ops', ${HQ_FACTORY}, 'optimize', ${`[进化脑] ${input.type} @ ${input.target}`.slice(0, 128)}, ${rationale}, 'pending', NOW())`,
      );
      const first = Array.isArray(ins) ? (ins as unknown[])[0] : ins;
      const proposalId = Number((first as { insertId?: number })?.insertId ?? 0);

      await emitReport({
        audience: "factory",
        factoryId: HQ_FACTORY,
        level: "action",
        sourceRing: "evolve",
        title: `🧠 进化脑新提案待双签：${input.type}`,
        body: `目标 ${input.target}；${input.reason.slice(0, 300)}`,
        dedupeKey: `evolve-proposal-${proposalId}`,
      });
      return { ok: true as const, proposalId, status: "pending" as const };
    }),

  /** digestInbox（mutation）：消化收件箱条目（大脑处理完标记） */
  digestInbox: publicQuery
    .input(z.object({
      key: z.string().trim().min(1),
      inboxId: z.number().int().positive(),
      note: z.string().trim().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!isEvolveKey(ctx?.req?.headers?.get("x-evolve-key") ?? undefined) && input.key !== process.env.EVOLVE_KEY) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "机器通道专用" });
      }
      await getDb().execute(
        sql`UPDATE st_evolve_inbox SET status='digested', digested_by='kimi', digested_at=NOW()
            WHERE id=${input.inboxId}`,
      );
      return { ok: true as const };
    }),
});
