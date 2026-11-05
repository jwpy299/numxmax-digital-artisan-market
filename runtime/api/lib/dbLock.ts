import { TRPCError } from "@trpc/server";
import { createConnection, type Connection } from "mysql2/promise";
import { getProbeConnectionUrl, qTimed } from "../queries/connection";
import { logQueryErrorThrottled } from "../queries/rawRows";

type LockMessages = { busyMessage?: string; unavailableMessage?: string; fnTimeoutMs?: number };

const LOCK_WAIT_SECONDS = 5;
const CONNECT_TIMEOUT_MS = 5_000;
const CONNECT_RETRY_MS = 250;
const TRANSIENT_CONNECT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
const LOCK_QUERY_TIMEOUT_MS = 8_000;
const RELEASE_QUERY_TIMEOUT_MS = 2_000;
const FN_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const CLOSE_TIMEOUT_MS = 2_000;
const NAMED_LOCK_INFLIGHT_PER_KEY = 4;
const NAMED_LOCK_INFLIGHT_GLOBAL = 16;
let namedLockInFlight = 0;
const namedLockByKey = new Map<string, number>();

function acquireNamedLockSlot(lockName: string): boolean {
  const count = namedLockByKey.get(lockName) ?? 0;
  if (count >= NAMED_LOCK_INFLIGHT_PER_KEY || namedLockInFlight >= NAMED_LOCK_INFLIGHT_GLOBAL) return false;
  namedLockByKey.set(lockName, count + 1);
  namedLockInFlight += 1;
  return true;
}

function releaseNamedLockSlot(lockName: string): void {
  const count = namedLockByKey.get(lockName) ?? 0;
  if (count <= 1) namedLockByKey.delete(lockName);
  else namedLockByKey.set(lockName, count - 1);
  namedLockInFlight = Math.max(0, namedLockInFlight - 1);
}

/** 私有超时类型：业务错误即使文案相同也不能被误判为超时。 */
class LockFnTimeoutError extends Error {
  constructor() { super("lock_fn_timed_out"); this.name = "LockFnTimeoutError"; }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LockFnTimeoutError()), ms);
      timer.unref?.();
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/** 连接关闭永远 best-effort：同步 throw、异步 reject、超时都不能掩盖业务结果。 */
async function closeConnection(conn: Connection, releaseOk: boolean): Promise<void> {
  if (!releaseOk) {
    try { conn.destroy(); } catch { /* best-effort */ }
    return;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  let endFailed = false;
  let ending: Promise<void> | null = null;
  try { ending = conn.end(); } catch { endFailed = true; }
  if (ending) {
    await Promise.race([
      ending.catch(() => { endFailed = true; }),
      new Promise<void>((resolve) => { timer = setTimeout(() => { endFailed = true; resolve(); }, CLOSE_TIMEOUT_MS); }),
    ]);
  }
  if (timer) clearTimeout(timer);
  if (endFailed) {
    try { conn.destroy(); } catch { /* best-effort：不掩盖业务结果 */ }
  }
}

/**
 * 专用连接的命名锁生命周期：驱动建连超时→GET_LOCK 分类→业务→RELEASE_LOCK 核验→成功 end/异常 destroy。
 * 连接固定取 getProbeConnectionUrl，不接收调用方 db，避免“用了调用方池/库”的假语义；每进程每锁 4、全局 16 支，
 * 部署须把专用连接纳入 max_connections 预算。业务超时时旧回调可能仍在飞：跳过 RELEASE_LOCK，直接 destroy 整会话。
 */
async function createLockConnection(): Promise<Connection> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await createConnection(getProbeConnectionUrl(CONNECT_TIMEOUT_MS)); }
    catch (err) {
      const code = String((err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code ?? "");
      if (attempt === 1 || !TRANSIENT_CONNECT_CODES.has(code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
    }
  }
  throw new Error("unreachable");
}

export async function withNamedDbConnection<T>(
  lockName: string,
  fn: (conn: Connection) => Promise<T>,
  messages: LockMessages = {},
): Promise<T> {
  const busy = messages.busyMessage ?? "另一操作正在执行——请稍后重试";
  const unavailable = messages.unavailableMessage ?? "数据库锁暂不可用——稍后重试";
  const fnTimeoutMs = messages.fnTimeoutMs ?? FN_TIMEOUT_MS;
  if (!Number.isInteger(fnTimeoutMs) || fnTimeoutMs <= 0 || fnTimeoutMs > MAX_TIMEOUT_MS) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: unavailable });
  }
  if (Buffer.byteLength(lockName, "utf8") === 0 || Buffer.byteLength(lockName, "utf8") > 64) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: unavailable });
  }
  if (!acquireNamedLockSlot(lockName)) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: busy });
  let conn: Connection | undefined;
  let locked = false;
  let acquireFailed = false;
  try {
    try {
      conn = await createLockConnection();
    } catch (err) {
      acquireFailed = true;
      logQueryErrorThrottled(`[dbLock] 获取专用连接失败（${lockName}）`, err);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: unavailable });
    }
    let rows: unknown;
    try {
      [rows] = await qTimed(conn, "SELECT GET_LOCK(?, ?) AS got", [lockName, LOCK_WAIT_SECONDS], LOCK_QUERY_TIMEOUT_MS);
    } catch (err) {
      acquireFailed = true; // 服务端可能已持锁但客户端未读到结果：病连接不得复用
      logQueryErrorThrottled(`[dbLock] GET_LOCK 失败（${lockName}）`, err);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: unavailable });
    }
    const raw = (rows as Array<{ got?: number | string | null }>)[0]?.got;
    if (raw === undefined) {
      acquireFailed = true; // 行形状异常：可能已持锁但无法确认，destroy 防泄漏
      logQueryErrorThrottled(`[dbLock] GET_LOCK 返回形状异常（${lockName}）`, new Error("lock_result_shape"));
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: unavailable });
    }
    if (raw === null) {
      logQueryErrorThrottled(`[dbLock] GET_LOCK 返回 NULL（${lockName}）`, new Error("lock_result_null"));
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: unavailable });
    }
    const got = Number(raw);
    if (got === 0) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: busy });
    if (got !== 1) {
      acquireFailed = true;
      logQueryErrorThrottled(`[dbLock] GET_LOCK 返回非预期值（${lockName}）`, new Error(`lock_result_${got}`));
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: unavailable });
    }
    locked = true;
    try {
      return await withTimeout(fn(conn), fnTimeoutMs);
    } catch (err) {
      if (err instanceof LockFnTimeoutError) {
        acquireFailed = true;
        logQueryErrorThrottled(`[dbLock] 锁内业务超时（${lockName}）`, err);
        throw new TRPCError({ code: "TIMEOUT", message: "数据库锁内业务超时——连接已隔离，请稍后重试" });
      }
      logQueryErrorThrottled(`[dbLock] 锁内业务失败（${lockName}）`, err);
      throw err;
    }
  } finally {
    let releaseOk = !acquireFailed;
    // 结果不明/业务超时可能仍有 SQL 在飞：绝不提前 RELEASE，destroy 由数据库随会话收锁。
    if (conn && locked && !acquireFailed) {
      try {
        const [rows] = await qTimed(conn, "SELECT RELEASE_LOCK(?) AS released", [lockName], RELEASE_QUERY_TIMEOUT_MS);
        releaseOk = Number((rows as Array<{ released?: number | string | null }>)[0]?.released) === 1;
        if (!releaseOk) throw new Error("RELEASE_LOCK did not release the held lock");
      } catch (err) {
        releaseOk = false;
        logQueryErrorThrottled(`[dbLock] RELEASE_LOCK 失败，连接拔池（${lockName}）`, err);
      }
    }
    try {
      if (conn) await closeConnection(conn, releaseOk);
    } catch (err) {
      try { conn?.destroy(); } catch { /* best-effort */ }
      logQueryErrorThrottled(`[dbLock] 连接收口失败（${lockName}）`, err);
    } finally {
      releaseNamedLockSlot(lockName);
    }
  }
}
