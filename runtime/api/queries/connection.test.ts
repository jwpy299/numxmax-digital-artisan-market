/**
 * connection 探测面直测（portal#40 R7 票⑧）：
 * getProbeConnectionUrl（无 query / 有 query / 同键剥除·单键·连续双键·尾键 / #fragment / 尾随分隔符）；
 * poolAcquirePing（正常 true+release / ping 失败 destroy 不回池 / 单飞闸未 settle 拒新 / 超时留痕不误报）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const getConnectionMock = vi.fn();
const poolOnMock = vi.fn();
const envHolder = { url: "mysql://root:pw@127.0.0.1:3306/wb_rebuild" };

vi.mock("mysql2/promise", () => ({
  createPool: vi.fn(() => ({ getConnection: (...a: unknown[]) => getConnectionMock(...a), pool: { on: poolOnMock } })),
}));
vi.mock("../lib/env", () => ({
  get env() { return { databaseUrl: envHolder.url }; },
}));

import type { Connection } from "mysql2/promise";
import { createDbFromConnection, getProbeConnectionUrl, poolAcquirePing, __resetPoolPingForTest } from "./connection";

beforeEach(() => {
  __resetPoolPingForTest(); // 池信号面模块级状态清零（用例间不串）
  getConnectionMock.mockReset();
  envHolder.url = "mysql://root:pw@127.0.0.1:3306/wb_rebuild";
});

describe("getProbeConnectionUrl", () => {
  it("无 query → 追加 ?connectTimeout", () => {
    expect(getProbeConnectionUrl(1000)).toBe("mysql://root:pw@127.0.0.1:3306/wb_rebuild?connectTimeout=1000");
  });
  it("已有 query → & 追加；原串零再序列化", () => {
    envHolder.url = "mysql://root:pw@127.0.0.1:3306/wb_rebuild?charset=utf8mb4";
    expect(getProbeConnectionUrl(1000)).toBe("mysql://root:pw@127.0.0.1:3306/wb_rebuild?charset=utf8mb4&connectTimeout=1000");
  });
  it("同键剥除：单键尾键 → 换探测值（运维大值不压探测界）", () => {
    envHolder.url = "mysql://root:pw@127.0.0.1:3306/wb_rebuild?connectTimeout=10000";
    expect(getProbeConnectionUrl(1000)).toBe("mysql://root:pw@127.0.0.1:3306/wb_rebuild?connectTimeout=1000");
  });
  it("同键剥除：中段键保结构（charset 不动）", () => {
    envHolder.url = "mysql://root:pw@127.0.0.1:3306/wb_rebuild?connectTimeout=10000&charset=utf8mb4";
    expect(getProbeConnectionUrl(1000)).toBe("mysql://root:pw@127.0.0.1:3306/wb_rebuild?charset=utf8mb4&connectTimeout=1000");
  });
  it("同键剥除：连续双键全剥（R7 票⑤：前 match 吃锚点漏剥第二键的面封死）", () => {
    envHolder.url = "mysql://root:pw@127.0.0.1:3306/wb_rebuild?connectTimeout=5&connectTimeout=6";
    const out = getProbeConnectionUrl(1000);
    expect(out).toBe("mysql://root:pw@127.0.0.1:3306/wb_rebuild?connectTimeout=1000");
    expect(out.match(/connectTimeout=/g)).toHaveLength(1);
  });
  it("#fragment：参数插在 fragment 前，不被吞", () => {
    envHolder.url = "mysql://root:pw@127.0.0.1:3306/wb_rebuild#frag";
    expect(getProbeConnectionUrl(1000)).toBe("mysql://root:pw@127.0.0.1:3306/wb_rebuild?connectTimeout=1000#frag");
  });
  it("尾随 ? 不补分隔符（不出 ?& 畸形）", () => {
    envHolder.url = "mysql://root:pw@127.0.0.1:3306/wb_rebuild?";
    expect(getProbeConnectionUrl(1000)).toBe("mysql://root:pw@127.0.0.1:3306/wb_rebuild?connectTimeout=1000");
  });
});

describe("poolAcquirePing（单飞闸）", () => {
  const okConn = () => ({ ping: vi.fn().mockResolvedValue(undefined), release: vi.fn(), destroy: vi.fn() });

  it("正常 acquire+ping → true 且 release 回池（兼验：池 error 托管已挂载，R16 票③——静默缺位面钉死）", async () => {
    const conn = okConn();
    getConnectionMock.mockResolvedValue(conn);
    expect(await poolAcquirePing(50)).toBe(true);
    expect(poolOnMock).toHaveBeenCalledWith("error", expect.any(Function)); // 挂载实证
    expect(conn.release).toHaveBeenCalledTimes(1);
    expect(conn.destroy).not.toHaveBeenCalled();
  });

  it("ping 失败 → false 且 destroy 拔池（病连接不回池，R7 票④）", async () => {
    const conn = okConn();
    conn.ping.mockRejectedValue(new Error("ping boom"));
    getConnectionMock.mockResolvedValue(conn);
    const errs: unknown[] = [];
    expect(await poolAcquirePing(50, (e) => errs.push(e))).toBe(false);
    expect(conn.destroy).toHaveBeenCalledTimes(1);
    expect(conn.release).not.toHaveBeenCalled();
    expect(errs).toHaveLength(1);
  });

  it("acquire 挂起 → 撞窗探测 join 在飞同答（不新开 acquire、不假红），flow settle 后闸自开", async () => {
    let resolveConn!: (v: unknown) => void;
    getConnectionMock.mockReturnValue(new Promise((r) => { resolveConn = r; }));
    const p1 = poolAcquirePing(1000);
    const p2 = poolAcquirePing(1000); // join 在飞（R8 票④：同答不假红）
    expect(getConnectionMock).toHaveBeenCalledTimes(1); // 不新开 acquire
    resolveConn(okConn()); // 池恢复：挂起的 acquire 兑现
    expect(await p1).toBe(true);
    expect(await p2).toBe(true); // join 同答
    const conn2 = okConn();
    getConnectionMock.mockResolvedValue(conn2);
    expect(await poolAcquirePing(50)).toBe(true); // 闸已开
  });

  it("超时放闸＋物理 waiter 绝对闸：连续 acquire 挂死两次后第三调硬拒", async () => {
    getConnectionMock.mockReturnValue(new Promise(() => { /* acquire 永不兑现 */ }));
    expect(await poolAcquirePing(30)).toBe(false); // 超时放闸，物理 waiter +1
    expect(await poolAcquirePing(30)).toBe(false); // 逻辑闸已放（老 flow 挂起）→ 开新 acquire 再超时，物理 waiter +1
    expect(await poolAcquirePing(30)).toBe(false); // 物理 waiter=2 硬拒（不再 acquire）
    expect(getConnectionMock).toHaveBeenCalledTimes(2); // 物理面封死在 2
  });

  it("超时 → false＋onError 留痕；自毁引发的 ping reject 不误留（票⑥）", async () => {
    const conn = okConn();
    conn.ping.mockReturnValue(new Promise(() => { /* 永不结算 */ }));
    getConnectionMock.mockResolvedValue(conn);
    const errs: unknown[] = [];
    expect(await poolAcquirePing(30, (e) => errs.push(e))).toBe(false);
    expect(errs).toHaveLength(1); // 只有 timeout 那一笔（destroy 引发的 ping reject 不第二笔）
    expect(conn.destroy).toHaveBeenCalled();
  });

  // wb#49 ①：越界入参守卫。`NaN` 会让 `deadline = Date.now() + NaN = NaN` ⇒ `now > deadline` **恒 false**
  // ⇒ 超时永不触发；0/负数 ⇒ 立即超时。两者都属"越界入参静默改变语义"。
  it("入参守卫：NaN/0/负数 ⇒ 回落有界默认值并留痕，不挂死、不假红（wb#49 ①）", async () => {
    getConnectionMock.mockResolvedValue(okConn());
    for (const bad of [Number.NaN, 0, -1]) {
      const errs: unknown[] = [];
      const t0 = Date.now();
      const ok = await poolAcquirePing(bad, (e) => errs.push(e));
      expect(typeof ok).toBe("boolean"); // 不挂死（NaN 旧行为下这里会一直等）
      expect(Date.now() - t0).toBeLessThan(5_000); // 有界
      expect(errs).toHaveLength(1); // 回落事实**留痕**，不只活在注释里
      expect(String((errs[0] as { message?: string })?.message ?? errs[0])).toContain("入参非法");
    }
  });

  // portal#45 R5 的 :160 / wb#53 R5 的 :163：**夹取分支此前没有测试**。
  // `1e12` 会原样通过"非有限/非正"那道闸，而 Node 的 `setTimeout` 对 > 2^31-1ms 回绕成 1ms ⇒ 立刻超时。
  it("入参守卫：巨大但有穷的值（1e12）⇒ 夹到上界并留痕，不静默变 1ms（portal#45 R5）", async () => {
    getConnectionMock.mockResolvedValue(okConn());
    const errs: unknown[] = [];
    const t0 = Date.now();
    const ok = await poolAcquirePing(1e12, (e) => errs.push(e));
    expect(typeof ok).toBe("boolean");
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(errs).toHaveLength(1);
    const msg = String((errs[0] as { message?: string })?.message ?? errs[0]);
    expect(msg).toContain("越界");
    expect(msg).toContain("60000ms"); // 夹到 POOL_PING_TIMEOUT_MAX_MS（60s），不是回绕后的 1ms
    expect(msg).not.toContain("1ms（"); // 防"回绕"回归：绝不能落到 1ms
  });
});

describe("createDbFromConnection（命名锁物理连接复用）", () => {
  it("保留原 client 身份，BEGIN/COMMIT 只在传入连接执行且不从池取连接", async () => {
    const events: string[] = [];
    const query = vi.fn(async (input: string | { sql: string }) => {
      events.push(typeof input === "string" ? input : input.sql);
      return [[], []];
    });
    const conn = {
      connection: { query: vi.fn(), destroy: vi.fn() },
      query,
      execute: query,
      end: vi.fn(async () => undefined),
      destroy: vi.fn(),
    };

    const db = createDbFromConnection(conn as unknown as Connection);
    expect(db.$client).toBe(conn);
    await expect(db.transaction(async () => "done")).resolves.toBe("done");

    const statements = events.map((event) => event.trim().toUpperCase());
    expect(statements).toContain("BEGIN");
    expect(statements).toContain("COMMIT");
    expect(statements.indexOf("BEGIN")).toBeLessThan(statements.indexOf("COMMIT"));
    expect(query).toHaveBeenCalled();
    expect(getConnectionMock).not.toHaveBeenCalled();
  });
});
