import { afterEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const dialect = new MySqlDialect();
const legacyRows = [
  { id: 11, ip: "0:0:0:0:0:ffff:cb00:7108" },
  { id: 12, ip: "::ffff:203.0.113.8" },
  { id: 13, ip: "198.51.100.9" },
];

async function freshOps() {
  vi.resetModules();
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    transaction: vi.fn(async (fn: (tx: { execute: (stmt: unknown) => Promise<unknown> }) => Promise<unknown>) => fn({ execute: db.execute })),
    execute: vi.fn(async (stmt: unknown) => {
      const q = dialect.sqlToQuery(stmt as never);
      captured.push({ sql: q.sql, params: q.params as unknown[] });
      if (q.sql.includes("FROM ops_ip_blocklist")) return [legacyRows, []];
      if (q.sql.includes("FROM ops_access_log")) return [[{ ip: "203.0.113.8", req_count: 120, auth_fails: 0, server_errs: 0 }], []];
      if (q.sql.includes("COUNT(*)")) return [[{ c: 1 }], []];
      return [{ affectedRows: 2 }, []];
    }),
  };
  const noteIpBlocked = vi.fn();
  const noteIpUnblocked = vi.fn();
  vi.doMock("../queries/connection", () => ({ getDb: () => db }));
  vi.doMock("../middleware", async () => {
    const { initTRPC } = await import("@trpc/server");
    const t = initTRPC.context().create();
    return { createRouter: t.router, publicQuery: t.procedure, noteIpBlocked, noteIpUnblocked };
  });
  vi.doMock("./terminal", () => ({
    rawRows: (r: unknown) => Array.isArray(r) && Array.isArray(r[0]) ? r[0] : (r ?? []),
    requireAdmin: vi.fn(async () => ({ id: 1, username: "tester" })),
  }));
  vi.doMock("./adminAnalytics", () => ({ writeAdminAudit: vi.fn(), adminDisplayName: (u: { username: string }) => u.username }));
  const mod = await import("./opsCenter");
  return { mod, captured, noteIpUnblocked };
}

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

describe("opsCenter IP 归一与历史行", () => {
  it("unblockIp 按归一后的同一 IP 删除全部旧字面量行，不只 DELETE canonical 字符串", { timeout: 10000 }, async () => {
    const { mod, captured, noteIpUnblocked } = await freshOps();
    const r = await mod.opsCenterRouter.createCaller({} as never).unblockIp({ token: "boss", ip: "::ffff:203.0.113.8" });
    expect(r.ok).toBe(true);
    const del = captured.find((q) => q.sql.includes("DELETE FROM ops_ip_blocklist"));
    expect(del).toBeTruthy();
    expect(del?.sql).toContain("IN (?, ?)");
    expect(del?.params).toEqual([11, 12]);
    expect(noteIpUnblocked).toHaveBeenCalledWith("203.0.113.8");
  });

  it("accessLog 的 IP 筛选也归一，不把展开式 IPv6 当成无流量", async () => {
    const { mod, captured } = await freshOps();
    await mod.opsCenterRouter.createCaller({} as never).accessLog({ token: "boss", page: 1, ip: "0:0:0:0:0:ffff:cb00:7108" });
    const query = captured.find((q) => q.sql.includes("AND ip = ?"));
    expect(query?.params).toContain("203.0.113.8");
  });

  it("suspiciousIps 的 blocked 状态也按归一值命中历史行", async () => {
    const { mod } = await freshOps();
    const rows = await mod.opsCenterRouter.createCaller({} as never).suspiciousIps({ token: "boss" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ip: "203.0.113.8", blocked: true });
  });
});
