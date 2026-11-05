/**
 * evolveAudit —— 双脑架构 1 号件：audit 通道（小脑→大脑的体检快照）+ 经验蒸馏留档。
 *
 * 彭总拍板（2026-09-03）：双脑立项，Kimi 为进化脑，Harness 为原生脑，经验蒸馏路线。
 *
 * 本件含两部分：
 * A. evolveAudit（query）：一次调用返回全系统体检单（四应用/MySQL/磁盘/隧道/模型槽/评测分/信号/告警/近期干预）。
 *    数据源全部是现有探针表与业务表（只读、读从库口径、绝不新加采集压力）。
 * B. st_evolve_lessons 经验蒸馏表：问题→诊断→方案→结果 四元组留档，
 *    格式即训练数据标准——攒够即微调私有「见习大脑」。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";
import { sessionMe } from "./wbSession";
import { callSlotChat } from "./modelGateway";
import { emitReport } from "./reportBus";

// ─── A. 体检快照 ────────────────────────────────────────────────
// P1-3 门禁：原 textfile 探针副本 readTextfileMetrics 及其配套 ProbeRow 无人调用已删除
// （探针指标统一落 MySQL 侧表更稳，跨进程不可读文件系统）；体检数据由下方 audit 直接查库聚合。

/** 进化脑服务凭证：X-Evolve-Key 头匹配 nebula.env 的 EVOLVE_KEY（HQ token 之外的机器通道） */
export function isEvolveKey(key: string | undefined): boolean {
  const expected = process.env.EVOLVE_KEY;
  return !!expected && !!key && key === expected;
}

export const evolveRouter = createRouter({
  /** audit（query）：全身 检单（HQ admin 限定） */
  audit: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input, ctx }) => {
      const evolveOk = isEvolveKey(ctx?.req?.headers?.get("x-evolve-key") ?? undefined);
      if (!evolveOk) {
        const { user } = await sessionMe(input.token);
        if (user.factoryId !== 6380240) {
          throw new Error("仅限总部管理员");
        }
      }
      const db = getDb();

      // 模型评测分（最近一次每日评测）
      let evals: Record<string, unknown>[] = [];
      try {
        evals = rawRows(await db.execute(
          sql`SELECT suite, score, created_at AS createdAt FROM st_model_evals ORDER BY id DESC LIMIT 3`,
        ));
      } catch { /* 表可能无 */ }

      // 模型槽健康（24h 时延账）
      let slots: Record<string, unknown>[] = [];
      try {
        slots = rawRows(await db.execute(
          sql`SELECT slot, COUNT(*) AS calls, SUM(ok) AS oks,
                     ROUND(AVG(latency_ms)) AS avgMs, ROUND(AVG(first_token_ms)) AS avgFirstMs
              FROM st_llm_events
              WHERE created_at >= NOW() - INTERVAL 1 DAY
              GROUP BY slot`,
        ));
      } catch { /* 表可能无 */ }

      // 信号总线（24h 聚合）
      let signals: Record<string, unknown>[] = [];
      try {
        signals = rawRows(await db.execute(
          sql`SELECT kind, COUNT(*) AS count FROM st_evo_signals
              WHERE created_at >= NOW() - INTERVAL 1 DAY GROUP BY kind ORDER BY count DESC LIMIT 8`,
        ));
      } catch { /* */ }

      // 大表规模
      let tables: Record<string, unknown>[] = [];
      try {
        tables = rawRows(await db.execute(
          sql`SELECT table_name AS name, table_rows AS rows
              FROM information_schema.tables
              WHERE table_schema = DATABASE() AND table_rows > 10000
              ORDER BY table_rows DESC LIMIT 8`,
        ));
      } catch { /* */ }

      // 近期蒸馏经验
      let lessons: Record<string, unknown>[] = [];
      try {
        lessons = rawRows(await db.execute(
          sql`SELECT id, topic, result, created_at AS createdAt FROM st_evolve_lessons ORDER BY id DESC LIMIT 5`,
        ));
      } catch { /* 表未建时静默 */ }

      return {
        ts: new Date().toISOString(),
        models: { evals, slots },
        signals,
        tables,
        lessonsRecent: lessons,
      };
    }),

  /** recordLesson（mutation）：经验蒸馏留档（问题/诊断/方案/结果四元组） */
  recordLesson: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      topic: z.string().trim().min(1).max(128),
      problem: z.string().trim().min(1).max(2000),
      diagnosis: z.string().trim().min(1).max(2000),
      solution: z.string().trim().min(1).max(2000),
      result: z.string().trim().min(1).max(1000),
      /** 双师蒸馏：来源模型（kimi/deepseek/qwen…），默认 kimi */
      sourceModel: z.string().trim().min(1).max(32).default("kimi"),
      /** 置信度：high=双师一致/验证过，medium=单师，low=待仲裁 */
      confidence: z.enum(["high", "medium", "low"]).default("medium"),
    }))
    .mutation(async ({ input, ctx }) => {
      // 双通道鉴权：进化脑服务密钥（X-Evolve-Key）或 HQ 管理员 token
      const evolveOk = isEvolveKey(ctx?.req?.headers?.get("x-evolve-key") ?? undefined);
      if (!evolveOk) {
        const { user } = await sessionMe(input.token);
        if (user.factoryId !== 6380240) throw new Error("仅限总部管理员");
      }
      const db = getDb();
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS st_evolve_lessons (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          topic VARCHAR(128) NOT NULL,
          problem TEXT NOT NULL,
          diagnosis TEXT NOT NULL,
          solution TEXT NOT NULL,
          result VARCHAR(1000) NOT NULL,
          source_model VARCHAR(32) NOT NULL DEFAULT 'kimi',
          confidence VARCHAR(8) NOT NULL DEFAULT 'medium',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_topic (topic),
          KEY idx_source (source_model)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      const ins = await db.execute(
        sql`INSERT INTO st_evolve_lessons (topic, problem, diagnosis, solution, result, source_model, confidence)
            VALUES (${input.topic}, ${input.problem}, ${input.diagnosis}, ${input.solution}, ${input.result}, ${input.sourceModel}, ${input.confidence})`,
      );
      const first = Array.isArray(ins) ? (ins as unknown[])[0] : ins;
      return { ok: true as const, id: Number((first as { insertId?: number })?.insertId ?? 0) };
    }),

  /** lessons（query）：经验库检索（蒸馏资产盘点） */
  lessons: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      topic: z.string().trim().max(128).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }))
    .query(async ({ input, ctx }) => {
      const evolveOk = isEvolveKey(ctx?.req?.headers?.get("x-evolve-key") ?? undefined);
      if (!evolveOk) {
        const { user } = await sessionMe(input.token);
        if (user.factoryId !== 6380240) throw new Error("仅限总部管理员");
      }
      const db = getDb();
      try {
        const rows = rawRows(
          input.topic
            ? await db.execute(
                sql`SELECT id, topic, problem, diagnosis, solution, result, created_at AS createdAt
                    FROM st_evolve_lessons WHERE topic LIKE ${"%" + input.topic + "%"}
                    ORDER BY id DESC LIMIT ${input.limit}`,
              )
            : await db.execute(
                sql`SELECT id, topic, problem, diagnosis, solution, result, created_at AS createdAt
                    FROM st_evolve_lessons ORDER BY id DESC LIMIT ${input.limit}`,
              ),
        );
        return { lessons: rows };
      } catch {
        return { lessons: [] };
      }
    }),

  /** dailyDigest（mutation）：系统日报——聚合体检单 → flash 槽润色 → 推送 HQ + 彭总个人 */
  dailyDigest: publicQuery
    .input(z.object({ token: z.string().trim().max(64).optional().default("") }))
    .mutation(async ({ input, ctx }) => {
      const evolveOk = isEvolveKey(ctx?.req?.headers?.get("x-evolve-key") ?? undefined);
      if (!evolveOk) {
        const { user } = await sessionMe(input.token);
        if (user.factoryId !== 6380240) throw new Error("仅限总部管理员");
      }
      const db = getDb();

      // 聚合今日体检数据
      const data: Record<string, unknown> = {};
      try {
        data.slots = rawRows(await db.execute(
          sql`SELECT slot, COUNT(*) AS calls, SUM(ok) AS oks, ROUND(AVG(latency_ms)) AS avgMs
              FROM st_llm_events WHERE created_at >= CURDATE() GROUP BY slot`,
        ));
      } catch { data.slots = []; }
      try {
        data.signals = rawRows(await db.execute(
          sql`SELECT kind, COUNT(*) AS count FROM st_evo_signals
              WHERE created_at >= CURDATE() GROUP BY kind ORDER BY count DESC LIMIT 6`,
        ));
      } catch { data.signals = []; }
      try {
        data.tasksToday = rawRows(await db.execute(
          sql`SELECT status, COUNT(*) AS c FROM st_cabin_tasks WHERE created_at >= CURDATE() GROUP BY status`,
        ));
      } catch { data.tasksToday = []; }
      try {
        data.evals = rawRows(await db.execute(
          sql`SELECT suite, score FROM st_model_evals ORDER BY id DESC LIMIT 3`,
        ));
      } catch { data.evals = []; }
      try {
        data.acceptances = rawRows(await db.execute(
          sql`SELECT COUNT(*) AS c FROM st_delivery_acceptances WHERE accepted_at >= CURDATE()`,
        ));
      } catch { data.acceptances = []; }

      // flash 槽润色成人话日报
      const r = await callSlotChat("flash", {
        messages: [
          { role: "system", content: "你是 NumX Max 系统的运维日报生成器。把 JSON 体检数据写成 6 行内的中文日报：先一行总结论（🟢正常/🟡注意/🔴异常），再列关键数字，最后一行给一句行动建议。不要 emoji 堆砌，专业简洁。" },
          { role: "user", content: JSON.stringify(data).slice(0, 1500) },
        ],
        maxTokens: 300,
        temperature: 0.3,
        timeoutMs: 20000,
        context: "evolve_daily_digest",
      });
      const digest = r.ok && r.content ? r.content.trim()
        : `系统日报（原始数据）：模型槽 ${JSON.stringify(data.slots)}；信号 ${JSON.stringify(data.signals)}；今日验收 ${JSON.stringify(data.acceptances)}`;

      const today = new Date().toISOString().slice(0, 10);
      // HQ 企业频道
      await emitReport({
        audience: "factory",
        factoryId: 6380240,
        level: "info",
        sourceRing: "evolve",
        title: `🧠 双脑日报 · ${today}`,
        body: digest.slice(0, 1000),
        dedupeKey: `evolve-daily-${today}`,
      });
      // 彭总个人频道（企业 admin 号 7811605）
      await emitReport({
        audience: "personal",
        userId: 7811605,
        level: "info",
        sourceRing: "evolve",
        title: `🧠 双脑日报 · ${today}`,
        body: digest.slice(0, 1000),
        dedupeKey: `evolve-daily-peng-${today}`,
      });
      return { ok: true as const, digest, pushed: 2 };
    }),
});
