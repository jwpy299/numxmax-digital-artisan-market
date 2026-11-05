/**
 * snapshots —— M8-b 快照引擎（纯函数层，不依赖请求上下文，供其他路由复用）。
 *
 * 表：st_snapshots（db/sync-snapshots.mts），UNIQUE(scope, skey)。
 *
 * 契约：
 * - readSnapshot(scope, skey)：读一份快照（无行 → null）；
 * - writeSnapshot(scope, skey, content, dataVersion, degraded)：INSERT ... ON DUPLICATE KEY UPDATE 幂等写，
 *   content 落库前一律过 stripSecrets（st_/pk_ 敏感串永不进快照）；
 * - refreshSnapshot(scope, skey, generator)：异步执行 generator 并写快照，任何异常只记 console.error 不外抛；
 * - refreshDutyBriefingSnapshot()：事件钩子专用（gate 执行成功 / st_auto_signals 新信号落库后调用），
 *   fire-and-forget，同步返回、绝不抛出，主流程零感知。
 */
import { sql } from "drizzle-orm";
import { stQuery } from "./terminal";
import { stripSecrets } from "./voice";

export interface SnapshotData {
  content: string;
  degraded: boolean;
  generatedAt: string;
  dataVersion: string | null;
}

/** 快照生成器产物 */
export interface SnapshotDraft {
  content: string;
  dataVersion?: string | null;
  degraded?: boolean;
}

export async function readSnapshot(scope: string, skey: string): Promise<SnapshotData | null> {
  const rows = await stQuery(
    sql`SELECT content, degraded, generated_at AS generatedAt, data_version AS dataVersion
        FROM st_snapshots WHERE scope = ${scope} AND skey = ${skey} LIMIT 1`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    content: String(r.content ?? ""),
    degraded: Number(r.degraded) === 1,
    generatedAt: String(r.generatedAt),
    dataVersion: r.dataVersion == null ? null : String(r.dataVersion),
  };
}

export async function writeSnapshot(
  scope: string,
  skey: string,
  content: string,
  dataVersion: string | null = null,
  degraded = false,
): Promise<void> {
  // 铁律：快照内容落库前过敏感串过滤（content 可能拼装自多源真实数据）
  const clean = stripSecrets(content);
  await stQuery(
    sql`INSERT INTO st_snapshots (scope, skey, content, data_version, degraded, generated_at)
        VALUES (${scope}, ${skey}, ${clean}, ${dataVersion}, ${degraded ? 1 : 0}, NOW())
        ON DUPLICATE KEY UPDATE
          content = VALUES(content),
          data_version = VALUES(data_version),
          degraded = VALUES(degraded),
          generated_at = NOW()`,
  );
}

/**
 * 异步刷新一份快照：执行 generator → 写库。永不抛出（快照是加速层，绝不能反过来打挂主流程）。
 * 返回 Promise 仅供测试/需要等待的调用方观测；主流程应 `void refreshSnapshot(...)` 使用。
 */
export async function refreshSnapshot(
  scope: string,
  skey: string,
  generator: () => Promise<SnapshotDraft>,
): Promise<void> {
  try {
    const draft = await generator();
    await writeSnapshot(scope, skey, draft.content, draft.dataVersion ?? null, draft.degraded ?? false);
  } catch (e) {
    console.error(
      `[snapshots] 刷新失败 ${scope}/${skey}:`,
      e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    );
  }
}

/**
 * 值守晨报快照刷新钩子（fire-and-forget）。
 * 动态 import adminAi：避免 adminAi ↔ gate/autoEngine 静态循环依赖；钩子本身同步返回、绝不抛出。
 */
/** 钩子节流：同一时刻最多一个在途刷新，且距上次触发 ≥60s 才再次生成（防高频事件打爆 LLM 用量） */
let dutyRefreshInflight = false;
let dutyRefreshLastAt = 0;
export const DUTY_REFRESH_MIN_INTERVAL_MS = 60_000;

/** 测试专用：重置节流状态（生产代码不得调用） */
export function __resetDutyRefreshThrottleForTest(): void {
  dutyRefreshInflight = false;
  dutyRefreshLastAt = 0;
}

export function refreshDutyBriefingSnapshot(): void {
  const now = Date.now();
  if (dutyRefreshInflight || now - dutyRefreshLastAt < DUTY_REFRESH_MIN_INTERVAL_MS) return;
  dutyRefreshInflight = true;
  dutyRefreshLastAt = now;
  void (async () => {
    const { dutyBriefingSnapshotGenerator } = await import("./adminAi");
    await refreshSnapshot("platform", "duty-briefing", dutyBriefingSnapshotGenerator);
  })()
    .catch((e) => {
      console.error(
        "[snapshots] duty-briefing 钩子异常:",
        e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
      );
    })
    .finally(() => {
      dutyRefreshInflight = false;
    });
}
