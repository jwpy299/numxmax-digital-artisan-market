import { beforeEach, describe, expect, it, vi } from "vitest";
import { withNamedDbConnection } from "./dbLock";
import { qTimed } from "../queries/connection";

let currentConn: any;
let connectAttempts = 0;
let connectTransientFailures = 0;
vi.mock("mysql2/promise", () => ({ createConnection: async () => {
  connectAttempts += 1;
  if (connectTransientFailures > 0) {
    connectTransientFailures -= 1;
    const err = new Error("connect_timeout") as Error & { code?: string };
    err.code = "ETIMEDOUT";
    throw err;
  }
  return currentConn;
} }));
beforeEach(() => { connectAttempts = 0; connectTransientFailures = 0; });

type Opts = { got?: number | null; getError?: boolean; releaseResult?: number; releaseError?: boolean; endThrow?: boolean; endSyncThrow?: boolean; connectTransient?: boolean };
function fakeLock(opts: Opts = {}) {
  const conn = {
    connection: { query: vi.fn(), destroy: vi.fn() },
    query: vi.fn(async (input: string | { sql: string }) => {
      const text = typeof input === "string" ? input : input.sql;
      if (text.includes("GET_LOCK")) {
        if (opts.getError) throw new Error("driver_get_lock_failed");
        return [[{ got: opts.got === undefined ? 1 : opts.got }], []];
      }
      if (text.includes("RELEASE_LOCK")) {
        if (opts.releaseError) throw new Error("driver_release_failed");
        return [[{ released: opts.releaseResult ?? 1 }], []];
      }
      return [[], []];
    }),
    end: vi.fn(() => {
      if (opts.endSyncThrow) throw new Error("end_sync_failed");
      return (async () => { if (opts.endThrow) throw new Error("end_failed"); })();
    }),
    destroy: vi.fn(),
  };
  currentConn = conn;
  connectTransientFailures = opts.connectTransient ? 1 : 0;
  return { conn };
}

describe("qTimed 独立连接结构", () => {
  it("独立 PromiseConnection 即使有 release 方法也允许执行", async () => {
    const conn = {
      connection: { query: vi.fn(), destroy: vi.fn() },
      release: vi.fn(),
      query: vi.fn(async () => [[{ ok: 1 }], []]),
      destroy: vi.fn(),
    };
    const result = await qTimed(conn as any, "SELECT 1", [], 20);
    expect(result).toEqual([[{ ok: 1 }], []]);
    expect(conn.query).toHaveBeenCalledWith("SELECT 1", []);
  });

  it("顶层或嵌套 _pool 以及 core.release 均在 SQL 前拒绝", async () => {
    for (const conn of [
      { _pool: {}, connection: { query: vi.fn(), destroy: vi.fn() }, query: vi.fn() },
      { connection: { _pool: {}, query: vi.fn(), destroy: vi.fn() }, query: vi.fn() },
      { connection: { release: vi.fn(), query: vi.fn(), destroy: vi.fn() }, query: vi.fn() },
    ]) {
      await expect(qTimed(conn as any, "SELECT 1", [], 20)).rejects.toThrow("禁止池连接");
      expect(conn.query).not.toHaveBeenCalled();
    }
  });

  it("未知缺结构连接 fail-closed", async () => {
    const conn = { query: vi.fn(), destroy: vi.fn() };
    await expect(qTimed(conn as any, "SELECT 1", [], 20)).rejects.toThrow("结构缺失");
    expect(conn.query).not.toHaveBeenCalled();
  });
});

describe("withNamedDbConnection 命名锁状态机", () => {
  it("成功：GET_LOCK→业务→RELEASE_LOCK→end", async () => {
    const { conn } = fakeLock();
    const r = await withNamedDbConnection("test:a", async () => "done");
    expect(r).toBe("done");
    expect(conn.end).toHaveBeenCalledTimes(1);
    expect(conn.destroy).not.toHaveBeenCalled();
  });

  it("瞬态建连超时只重试一次并成功；成功后不重试", async () => {
    const { conn } = fakeLock({ connectTransient: true });
    await expect(withNamedDbConnection("test:connect-retry", async () => "done")).resolves.toBe("done");
    expect(connectAttempts).toBe(2);
    expect(conn.end).toHaveBeenCalledTimes(1);
    await withNamedDbConnection("test:connect-retry-2", async () => "done");
    expect(connectAttempts).toBe(3);
  });

  it("GET_LOCK=0：busy，业务不执行且连接归还", async () => {
    const { conn } = fakeLock({ got: 0 });
    const fn = vi.fn(async () => "must-not-run");
    await expect(withNamedDbConnection("test:b", fn)).rejects.toThrow("另一操作正在执行");
    expect(fn).not.toHaveBeenCalled();
    expect(conn.end).toHaveBeenCalledTimes(1);
  });

  it("GET_LOCK=NULL：unavailable，不伪装 busy", async () => {
    fakeLock({ got: null });
    await expect(withNamedDbConnection("test:c", async () => "x")).rejects.toThrow("数据库锁暂不可用");
  });

  it("GET_LOCK 抛错：结果可能不明，destroy 不还池", async () => {
    const { conn } = fakeLock({ getError: true });
    await expect(withNamedDbConnection("test:d", async () => "x")).rejects.toThrow("数据库锁暂不可用");
    expect(conn.destroy).toHaveBeenCalledTimes(1);
    expect(conn.end).not.toHaveBeenCalled();
  });

  it("RELEASE_LOCK 失败：保留业务结果，destroy 拔池", async () => {
    const { conn } = fakeLock({ releaseError: true });
    const r = await withNamedDbConnection("test:e", async () => "done");
    expect(r).toBe("done");
    expect(conn.destroy).toHaveBeenCalledTimes(1);
  });

  it("end 异步失败：尝试 destroy 且不掩盖业务结果", async () => {
    const { conn } = fakeLock({ endThrow: true });
    const r = await withNamedDbConnection("test:f", async () => "done");
    expect(r).toBe("done");
    expect(conn.destroy).toHaveBeenCalledTimes(1);
  });

  it("end 同步 throw：不掩盖结果且并发槽必释放", async () => {
    for (let i = 0; i < 5; i += 1) {
      const { conn } = fakeLock({ endSyncThrow: true });
      await expect(withNamedDbConnection("test:sync-close", async () => "done")).resolves.toBe("done");
      expect(conn.destroy).toHaveBeenCalledTimes(1);
    }
  });

  it("锁内业务超时=跳过 RELEASE 并 destroy，不让旧回调越锁继续写", async () => {
    const { conn } = fakeLock();
    await expect(withNamedDbConnection("test:slow", () => new Promise(() => undefined), { fnTimeoutMs: 5 })).rejects.toThrow("锁内业务超时");
    expect(conn.destroy).toHaveBeenCalledTimes(1);
    expect(conn.end).not.toHaveBeenCalled();
    expect(conn.query.mock.calls.some((c) => String(c[0]).includes("RELEASE_LOCK"))).toBe(false);
  });

  it("业务错误即使文案撞 unavailable 也不误判超时", async () => {
    const { conn } = fakeLock();
    await expect(withNamedDbConnection("test:same-message", async () => { throw new Error("数据库锁暂不可用——稍后重试"); })).rejects.toThrow("数据库锁暂不可用");
    expect(conn.end).toHaveBeenCalledTimes(1);
    expect(conn.destroy).not.toHaveBeenCalled();
    expect(conn.query.mock.calls.some((c) => String(c[0]).includes("RELEASE_LOCK"))).toBe(true);
  });

  it("fnTimeoutMs 超 setTimeout 上界：在业务执行前明拒", async () => {
    fakeLock();
    const fn = vi.fn(async () => "must-not-run");
    await expect(withNamedDbConnection("test:timeout-overflow", fn, { fnTimeoutMs: 2_147_483_648 })).rejects.toThrow("数据库锁暂不可用");
    expect(fn).not.toHaveBeenCalled();
  });

  it("锁名超 64 字节：在业务执行前明拒", async () => {
    fakeLock();
    const fn = vi.fn(async () => "must-not-run");
    await expect(withNamedDbConnection(`test:${"x".repeat(65)}`, fn)).rejects.toThrow("数据库锁暂不可用");
    expect(fn).not.toHaveBeenCalled();
  });

  it("同锁并发帽：同 key 第 5 个等待者 busy，其他 lockName 不被误伤", async () => {
    fakeLock();
    const gates: Array<() => void> = [];
    const pending = Array.from({ length: 4 }, () => withNamedDbConnection("cap:same", () => new Promise<void>((resolve) => gates.push(resolve))));
    await new Promise((resolve) => setImmediate(resolve));
    expect(gates.length).toBe(4);
    await expect(withNamedDbConnection("cap:same", async () => "x")).rejects.toThrow("另一操作正在执行");
    const other = await withNamedDbConnection("cap:other", async () => "other");
    expect(other).toBe("other");
    for (const resolve of gates) resolve();
    await Promise.all(pending);
    const r = await withNamedDbConnection("cap:after", async () => "done");
    expect(r).toBe("done");
  });
});
