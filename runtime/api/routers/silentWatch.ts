/**
 * silentWatch —— 迭代75.5-A3「静默失败观测哨」。
 *
 * 背景：全仓普查 137 个 catch 中 128 个静默（多数是合理的降级兜底），
 * 但关键链路（进化链/记忆治理/圆桌记忆）静默失败会无声坏死。
 * 本模块提供 noteSilent：关键静默点打点落 st_silent_errors，
 * 自身双重静默——观测系统绝不成为新的故障源。
 */
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";

export function noteSilent(tag: string, err?: unknown): void {
  try {
    const msg = (err instanceof Error ? err.message : String(err ?? "")).slice(0, 300);
    void getDb()
      .execute(
        sql`INSERT INTO st_silent_errors (tag, message) VALUES (${tag.slice(0, 64)}, ${msg})`,
      )
      .catch(() => { /* 双静默：观测失败不再上报 */ });
  } catch { /* 双静默 */ }
}
