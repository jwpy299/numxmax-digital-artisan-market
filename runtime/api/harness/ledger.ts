/**
 * harnessLedger —— 全链登记制（2026-08-26 彭总令：Nebula Harness 驱动整个系统）。
 *
 * 口径：全系统每个 API 请求在 st_harness_runs 落一条轻量台账（tier='edge'，lane=api:<path>）——
 * Harness 对全系统「看得见、数得清」，但不挡路（fire-and-forget，写失败静默，绝不阻塞业务）。
 * LLM 承载链（语音问答等）另记 tier='interactive'——与 orchestrator 交互级同一口径。
 */
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";

export function recordHarnessRun(entry: {
  tier: "edge" | "interactive" | "heavy" | "construction";
  lane: string;
  ok: boolean;
  durationMs?: number;
  factoryId?: number | null;
  textLen?: number;
}): void {
  void (async () => {
    try {
      await getDb().execute(
        sql`INSERT INTO st_harness_runs (tier, lane, factory_id, ok, duration_ms, text_len)
            VALUES (${entry.tier}, ${entry.lane.slice(0, 24)}, ${entry.factoryId ?? null}, ${entry.ok ? 1 : 0},
                    ${entry.durationMs ?? null}, ${entry.textLen ?? 0})`,
      );
    } catch {
      // 表缺失/写失败：静默——台账绝不阻塞业务
    }
  })();
}
