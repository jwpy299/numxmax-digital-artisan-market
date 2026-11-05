/**
 * evolvePost —— 后训练机制（2026-09-07 彭总令）。
 *
 * 三件套：
 * ① 养料效果回执：精灵/驻官调阅养料时打点（st_lesson_usage），
 *    每夜 03:40 评效——同类异常在养料入库后是否下降（真效果），confidence 随效果升降
 * ② 优胜劣汰：连续无效 → 降权 medium→low→退役（topic 标 retired: 前缀，调阅自动跳过）
 * ③ 偏好对沉淀：蒸馏互评的胜卷/败卷入 st_dpo_pairs（DPO-ready，中训练直接开蒸）
 *
 * 中训练机制（本文件同驻）：st_dpo_pairs + high 养料 → SFT/DPO JSONL 数据集导出
 * + 就绪度报告（多少条、够不够开蒸）。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";
import { isEvolveKey } from "./evolveAudit";

// ─── 表（幂等） ──────────────────────────────────────────────────────────
let ensured = false;
export async function ensurePostTables(): Promise<void> {
  if (ensured) return;
  const db = getDb();
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS st_lesson_usage (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      lesson_id BIGINT UNSIGNED NOT NULL,
      used_in VARCHAR(48) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_lesson (lesson_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS st_dpo_pairs (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      case_ref VARCHAR(96) NOT NULL,
      chosen TEXT NOT NULL,
      rejected TEXT NOT NULL,
      chosen_model VARCHAR(32) NOT NULL,
      rejected_model VARCHAR(32) NOT NULL,
      margin DOUBLE NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    ensured = true;
  } catch { /* 库抖动下轮再来 */ }
}

/** 调阅打点（fire-and-forget，绝不挡主链） */
export function markLessonUsage(lessonIds: number[], usedIn: string): void {
  if (!lessonIds.length) return;
  void (async () => {
    try {
      await ensurePostTables();
      const db = getDb();
      for (const id of lessonIds.slice(0, 4)) {
        await db.execute(sql`INSERT INTO st_lesson_usage (lesson_id, used_in) VALUES (${id}, ${usedIn})`);
      }
    } catch { /* 静默 */ }
  })();
}

// ─── 每夜评效：养料入库后同类异常有没有少 ────────────────────────────────
export async function postTrainScan(): Promise<{ scored: number; demoted: number; retired: number }> {
  await ensurePostTables();
  const db = getDb();
  const lessons = rawRows(
    await db.execute(sql`SELECT id, topic, problem, confidence, created_at FROM st_evolve_lessons
                         WHERE topic NOT LIKE 'retired:%' ORDER BY id DESC LIMIT 100`),
  ) as { id: number; topic: string; problem: string; confidence: string; created_at: string }[];
  let scored = 0, demoted = 0, retired = 0;

  for (const l of lessons) {
    // 异常类养料：problem 形如 "crash #id" / "api_error #id"——按 kind 看前后 3 天同类信号量
    const m = String(l.problem).match(/^([a-z_]+)\s*#/);
    if (!m) continue;
    const kind = m[1];
    try {
      const rows = rawRows(
        await db.execute(sql`SELECT
          SUM(CASE WHEN created_at < ${l.created_at} THEN 1 ELSE 0 END) AS before_c,
          SUM(CASE WHEN created_at >= ${l.created_at} THEN 1 ELSE 0 END) AS after_c
          FROM st_evo_signals WHERE kind=${kind}`),
      ) as { before_c: string | null; after_c: string | null }[];
      const before = Number(rows[0]?.before_c ?? 0), after = Number(rows[0]?.after_c ?? 0);
      if (before === 0) continue;
      scored++;
      const improved = after < before;
      if (improved && l.confidence !== "high") {
        await db.execute(sql`UPDATE st_evolve_lessons SET confidence='high' WHERE id=${l.id}`);
      } else if (!improved && l.confidence === "high") {
        await db.execute(sql`UPDATE st_evolve_lessons SET confidence='medium' WHERE id=${l.id}`);
        demoted++;
      } else if (!improved && l.confidence === "medium") {
        await db.execute(sql`UPDATE st_evolve_lessons SET confidence='low' WHERE id=${l.id}`);
        demoted++;
      } else if (!improved && l.confidence === "low") {
        await db.execute(sql`UPDATE st_evolve_lessons SET topic=CONCAT('retired:', topic) WHERE id=${l.id} AND topic NOT LIKE 'retired:%'`);
        retired++;
      }
    } catch { /* 静默 */ }
  }
  return { scored, demoted, retired };
}

// ─── 偏好对沉淀（蒸馏互评胜负成对入 DPO 库） ────────────────────────────
export async function recordDpoPair(caseRef: string, chosen: string, rejected: string, chosenModel: string, rejectedModel: string, margin: number): Promise<void> {
  try {
    await ensurePostTables();
    const db = getDb();
    await db.execute(sql`INSERT INTO st_dpo_pairs (case_ref, chosen, rejected, chosen_model, rejected_model, margin)
                         VALUES (${caseRef.slice(0, 96)}, ${chosen.slice(0, 1800)}, ${rejected.slice(0, 1800)}, ${chosenModel}, ${rejectedModel}, ${margin})`);
  } catch { /* 静默 */ }
}

// ─── 中训练数据集导出（SFT + DPO JSONL） ────────────────────────────────
export interface MidTrainReadiness {
  sftCount: number; dpoCount: number; readyForLora: boolean; note: string;
}
export async function midTrainStatus(): Promise<MidTrainReadiness> {
  await ensurePostTables();
  const db = getDb();
  const sft = rawRows(
    await db.execute(sql`SELECT COUNT(*) c FROM st_evolve_lessons WHERE confidence='high' AND topic NOT LIKE 'retired:%'`),
  );
  const dpo = rawRows(await db.execute(sql`SELECT COUNT(*) c FROM st_dpo_pairs`));
  const sftCount = Number(sft[0]?.c ?? 0), dpoCount = Number(dpo[0]?.c ?? 0);
  // 门槛：SFT ≥300 且 DPO ≥100（LoRA 一轮见效的最小弹药）
  const ready = sftCount >= 300 && dpoCount >= 100;
  return {
    sftCount, dpoCount, readyForLora: ready,
    note: ready ? "弹药齐——可开蒸 GLM-5.3-Flash LoRA" : `攒料中：SFT ${sftCount}/300 · DPO ${dpoCount}/100`,
  };
}

export const evolvePostRouter = createRouter({
  /** 后训练状态（HQ/EVOLVE_KEY） */
  status: publicQuery.input(z.object({ key: z.string().optional() })).query(async ({ input }) => {
    if (!isEvolveKey(input.key)) throw new Error("forbidden");
    await ensurePostTables();
    const db = getDb();
    const usage = rawRows(await db.execute(sql`SELECT used_in, COUNT(*) c FROM st_lesson_usage GROUP BY used_in`));
    const mid = await midTrainStatus();
    const dpo = rawRows(await db.execute(sql`SELECT COUNT(*) c, AVG(margin) m FROM st_dpo_pairs`));
    return { usage, midTrain: mid, dpo: dpo[0] ?? null };
  }),
  /** 手工跑一轮评效 */
  scan: publicQuery.input(z.object({ key: z.string().optional() })).mutation(async ({ input }) => {
    if (!isEvolveKey(input.key)) throw new Error("forbidden");
    return postTrainScan();
  }),
});
