/**
 * alertUtil —— iter92 告警到人工具（api/lib 禁改，故放 routers 目录）。
 *
 * sendAlert(level, event, payload)：
 * - 始终写 st_alert_log（sent_ok 按 webhook 投递结果）；
 * - process.env.ALERT_WEBHOOK_URL 存在时 POST JSON（8s AbortController 超时）；
 * - 永不 throw：任何异常只记库/记日志，绝不阻断业务主链路。
 *
 * alertOnceDaily(level, event, payload, factoryId)：
 * - 每厂每日每档（同 event + 同 factoryId）只发一次——用 st_alert_log 当日查重。
 */
import { sql } from "drizzle-orm";
import { stQuery } from "./terminal";
import { emitSignal } from "./autoEngine";

export type AlertLevel = "info" | "warn" | "error";

/** 发送告警：webhook（可选）+ st_alert_log 落库；任何异常吞掉，永不 throw */
export async function sendAlert(
  level: AlertLevel,
  event: string,
  payload: Record<string, unknown>,
): Promise<{ sentOk: boolean }> {
  let sentOk = false;
  const payloadJson = JSON.stringify(payload ?? {});
  const url = (process.env.ALERT_WEBHOOK_URL ?? "").trim();
  if (url) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level, event, payload, ts: new Date().toISOString() }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      sentOk = res.ok;
    } catch {
      sentOk = false;
    }
  }
  try {
    await stQuery(
      sql`INSERT INTO st_alert_log (level, event, payload, sent_ok)
          VALUES (${level}, ${event.slice(0, 64)}, ${payloadJson}, ${sentOk ? 1 : 0})`,
    );
  } catch (e) {
    // 库不可用只记 console，绝不 throw
    console.error(
      "[alert] st_alert_log 写入失败:",
      e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    );
  }
  // iter96 信号接入点：告警到人 → emitSignal（B 级，source=alert；无 factoryId 则不落信号）
  const fid = Number((payload as { factoryId?: unknown })?.factoryId);
  if (Number.isFinite(fid) && fid > 0) {
    await emitSignal(fid, "alert", "B", `告警提醒：${event.slice(0, 120)}`, payloadJson);
  }
  return { sentOk };
}

/**
 * 每厂每日每 event 只发一次（LLM 用量 80%/100% 阈值告警用）。
 * 查重口径：st_alert_log 当日同 event 且 payload 含 "factoryId":<id>。
 */
export async function alertOnceDaily(
  level: AlertLevel,
  event: string,
  payload: Record<string, unknown>,
  factoryId: number,
): Promise<void> {
  try {
    const dup = await stQuery(
      sql`SELECT id FROM st_alert_log
          WHERE event = ${event.slice(0, 64)} AND DATE(created_at) = CURDATE()
            AND payload LIKE ${`%"factoryId":${factoryId}%`} LIMIT 1`,
    );
    if (dup[0]) return;
  } catch {
    // 查重失败不阻断，直接发（宁可多发不可漏发）
  }
  await sendAlert(level, event, { ...payload, factoryId });
}
