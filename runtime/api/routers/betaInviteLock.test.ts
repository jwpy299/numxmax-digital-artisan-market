import { describe, expect, it, vi } from "vitest";
import { withBetaInvitePhoneLock } from "./betaInvites";

vi.mock("../queries/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../queries/connection")>();
  return { ...actual, getDb: () => ({ execute: vi.fn(async () => [[], []]) }) };
});
let currentConn: any;
vi.mock("mysql2/promise", () => ({ createConnection: async () => currentConn }));

function fakeDb(got: number | string | null, released: number | string | null = 1) {
  const events: string[] = [];
  const conn = {
    connection: { query: vi.fn(), destroy: vi.fn() },
    query: vi.fn(async (input: string | { sql: string }) => {
      const text = typeof input === "string" ? input : input.sql;
      events.push(text);
      if (text.includes("GET_LOCK")) return [[{ got }], []];
      if (text.includes("RELEASE_LOCK")) return [[{ released }], []];
      return [[], []];
    }),
    execute: vi.fn(async (input: string | { sql: string }) => {
      const text = typeof input === "string" ? input : input.sql;
      events.push(text);
      return [[], []];
    }),
    end: vi.fn(async () => { events.push("conn.end"); }),
    destroy: vi.fn(() => events.push("conn.destroy")),
  };
  currentConn = conn;
  const db = {
    $client: { getConnection: vi.fn(async () => conn) },
    transaction: vi.fn(async () => { throw new Error("不得另开池事务连接"); }),
  };
  return { db, conn, events };
}

describe("betaInvite 手机号签发锁", () => {
  it("GET_LOCK→BEGIN→COMMIT→RELEASE_LOCK 全在同一物理连接，绝不提前放锁", async () => {
    const { db, conn, events } = fakeDb(1);
    const r = await withBetaInvitePhoneLock("13800000001", async () => "done");
    expect(r).toBe("done");
    expect(events[0]).toContain("GET_LOCK(?, ?) AS got");
    expect(events).toContain("begin");
    expect(events).toContain("commit");
    expect(events.indexOf("commit")).toBeLessThan(events.findIndex((x) => x.includes("RELEASE_LOCK")));
    expect(events.at(-1)).toBe("conn.end");
    expect(db.transaction).not.toHaveBeenCalled();
    expect(conn.end).toHaveBeenCalledTimes(1);
    expect(conn.destroy).not.toHaveBeenCalled();
  });

  it("锁未取得=明拒，业务不执行且连接归还", async () => {
    const { db, conn, events } = fakeDb(0);
    const fn = vi.fn(async () => "must-not-run");
    await expect(withBetaInvitePhoneLock("13800000001", fn)).rejects.toThrow("正在签发");
    expect(fn).not.toHaveBeenCalled();
    expect(events).not.toContain("begin");
    expect(events.at(-1)).toBe("conn.end");
  });

  it("GET_LOCK 返回 NULL=锁服务异常，不冒充并发太频繁", async () => {
    const { db, events } = fakeDb(null);
    const fn = vi.fn(async () => "must-not-run");
    await expect(withBetaInvitePhoneLock("13800000001", fn)).rejects.toThrow("签发锁暂不可用");
    expect(fn).not.toHaveBeenCalled();
    expect(events.at(-1)).toBe("conn.end");
  });

  it("业务异常先 ROLLBACK 再 RELEASE_LOCK", async () => {
    const { db, events } = fakeDb(1);
    await expect(withBetaInvitePhoneLock("13800000001", async () => { throw new Error("business"); })).rejects.toThrow("business");
    expect(events).toContain("rollback");
    expect(events.indexOf("rollback")).toBeLessThan(events.findIndex((x) => x.includes("RELEASE_LOCK")));
    expect(events.at(-1)).toBe("conn.end");
  });

  it("RELEASE_LOCK 结果异常=连接拔池，不把仍持锁连接还池", async () => {
    const { db, conn, events } = fakeDb(1, 0);
    const r = await withBetaInvitePhoneLock("13800000001", async () => "done");
    expect(r).toBe("done");
    expect(events.at(-1)).toBe("conn.destroy");
    expect(conn.destroy).toHaveBeenCalledTimes(1);
    expect(conn.end).not.toHaveBeenCalled();
  });
});
