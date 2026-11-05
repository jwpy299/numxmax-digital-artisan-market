import { describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const dialect = new MySqlDialect();
vi.mock("@hono/node-server/conninfo", () => ({ getConnInfo: () => ({ remote: { address: "127.0.0.1" } }) }));
const captured: string[] = [];
vi.mock("../queries/connection", () => ({
  getDb: () => ({
    execute: async (stmt: unknown) => {
      const q = dialect.sqlToQuery(stmt as never);
      captured.push(q.sql);
      return [[{ id: 1 }], []];
    },
  }),
}));
vi.mock("./betaInvites", () => ({ ensureBetaInvites: async () => undefined }));
vi.mock("./terminal", () => ({ rawRows: (r: unknown) => (r as [unknown[], unknown])[0] }));

import { betaCheckHandler } from "./betaGate";

describe("beta-check 下载前验码", () => {
  it("活码查询与注册链同带 revoked_at IS NULL，吊销码不可下载后才发现无效", async () => {
    const body = { code: "iv_" + "a".repeat(48) };
    const c = {
      req: { header: () => "203.0.113.9", json: async () => body },
      json: (data: unknown, status = 200) => Response.json(data, { status }),
    };
    const r = await betaCheckHandler(c as never);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, via: "invite_beta" });
    expect(captured.some((sql) => sql.includes("FROM st_beta_invites") && sql.includes("revoked_at IS NULL"))).toBe(true);
  });
});
