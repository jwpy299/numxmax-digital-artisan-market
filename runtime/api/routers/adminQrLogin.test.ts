import { createHash, createHmac, hkdfSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const dialect = new MySqlDialect();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const PROOF_KEY = "a".repeat(64);
const CONSOLE_ID = "lingshu-prod-admin";
function proofInput(row: Record<string, unknown>, session: string) {
  const expiresAt = new Date(row.created_at as string).getTime() + 300_000;
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(PROOF_KEY, "hex"), Buffer.alloc(0), "numx-admin-console-proof-v1", 32));
  const consoleProof = createHmac("sha256", key).update(`admin-console-v1|${session}|${CONSOLE_ID}|${expiresAt}`).digest("hex").slice(0, 32);
  return { session, consoleId: CONSOLE_ID, consoleProof, expiresAt, consent: "admin_console_confirmed" as const };
}

async function fresh(opts: { row?: Record<string, unknown>; rate?: number; affected?: number | string } = {}) {
  vi.resetModules();
  vi.stubEnv("QR_LOGIN_ENC_KEY", PROOF_KEY);
  vi.stubEnv("ADMIN_CONSOLE_ID", CONSOLE_ID);
  const captured: string[] = [];
  const execute = vi.fn(async (stmt: unknown) => {
    const q = dialect.sqlToQuery(stmt as never);
    captured.push(q.sql);
    if (q.sql.includes("SELECT n FROM st_qr_rate")) return [[{ n: opts.rate ?? 1 }], []];
    if (q.sql.includes("INSERT INTO st_qr_rate")) return [{ affectedRows: 1 }, []];
    if (q.sql.includes("FROM st_qr_sessions") && q.sql.includes("SELECT")) return [opts.row ? [opts.row] : [], []];
    if (q.sql.includes("UPDATE st_qr_sessions")) return [{ affectedRows: opts.affected ?? 1 }, []];
    if (q.sql.includes("INSERT INTO st_qr_sessions")) return [{ insertId: 1 }, []];
    return [[], []];
  });
  vi.doMock("../queries/connection", () => ({
    getDb: () => ({ execute, transaction: async (fn: (tx: { execute: typeof execute }) => unknown) => fn({ execute }) }),
  }));
  vi.doMock("../auth/adminGate", () => ({ requireAdmin: vi.fn(async () => ({ id: 1, username: "peng", displayName: "彭" })) }));
  vi.doMock("./qrLoginCrypto", () => ({ encryptQrToken: (t: string) => `enc:${t}`, decryptQrToken: (s: string) => s === "bad" ? null : s.replace(/^enc:/, "") }));
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  const mod = await import("./adminQrLogin");
  const caller = (ip?: string) => mod.adminQrLoginRouter.createCaller({ clientIp: ip ?? "", req: { headers: new Headers(ip ? { "x-forwarded-for": ip } : {}) } } as never);
  return { mod, caller, captured };
}

const pendingRow = () => ({ id: 7, state: "pending", target: "admin_console", created_at: new Date() });
const confirmedRow = () => ({ id: 7, state: "confirmed", target: "admin_console", created_at: new Date(), poll_secret_hash: sha("qs_test"), client_ip: "203.0.113.10", wb_token_enc: "enc:nt_admin" });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("adminQr 扫码安全链", () => {
  it("open：来源 IP 不可识别=fail-closed，不建会话", async () => {
    const { caller, captured } = await fresh();
    await expect(caller().open({ target: "admin_console" })).rejects.toThrow("无法识别请求来源");
    expect(captured.some((q) => q.includes("INSERT INTO st_qr_sessions"))).toBe(false);
  });

  it("open：qs_ 专用轮询密语+会话尾号+5 分钟 TTL，清理只收 admin-qr 桶", async () => {
    const { caller, captured } = await fresh();
    const r = await caller("203.0.113.10").open({ target: "admin_console" });
    expect(r.session).toMatch(/^ql_[0-9a-f]{24}$/);
    expect(r.pollSecret).toMatch(/^qs_[0-9a-f]{48}$/);
    expect(r.sessionHint).toBe(r.session.slice(-6));
    expect(r.expiresInSec).toBe(300);
    expect(r.expiresAt % 1000).toBe(0);
    expect(r.consoleProof).toMatch(/^[0-9a-f]{32}$/);
    expect(r.qrText).toContain("t=admin_console");
    expect(r.qrText).toContain(`e=${r.expiresAt}`);
    expect(captured.some((q) => q.includes("DELETE FROM st_qr_rate") && q.includes("ip LIKE 'admin-qr:%'"))).toBe(true);
  });

  it("open：同 IP 超过 10/min=明拒", async () => {
    const { caller } = await fresh({ rate: 11 });
    await expect(caller("203.0.113.10").open({ target: "admin_console" })).rejects.toThrow("过于频繁");
  });

  it("confirm：未显式人工 consent=schema 拒", async () => {
    const { caller } = await fresh({ row: pendingRow() });
    await expect(caller("203.0.113.10").confirm({ token: "nt_admin", session: "ql_0123456789abcdef01234567" } as never)).rejects.toThrow();
  });

  it("confirm：无会话=NOT_FOUND 业务话术；成功确认写 confirmed_at", async () => {
    const missing = await fresh();
    await expect(missing.caller("203.0.113.10").confirm({ token: "nt_admin", ...proofInput(pendingRow(), "ql_0123456789abcdef01234567") })).rejects.toThrow("扫码会话不存在");
    const row = pendingRow();
    const ok = await fresh({ row });
    const r = await ok.caller("203.0.113.10").confirm({ token: "nt_admin", ...proofInput(row, "ql_0123456789abcdef01234567") });
    expect(r.ok).toBe(true);
    expect(ok.captured.some((q) => q.includes("confirmed_at=NOW()"))).toBe(true);
  });

  it("confirm：实例签名被篡改=拒，不进入管理员确认", async () => {
    const { caller } = await fresh({ row: pendingRow() });
    const input = { ...proofInput(pendingRow(), "ql_0123456789abcdef01234567"), consoleProof: "0".repeat(32) };
    await expect(caller("203.0.113.10").confirm({ token: "nt_admin", ...input })).rejects.toThrow("实例或签名不一致");
  });

  it("status：open/status IP 不同=ip_mismatch 终态，绝不释放 token", async () => {
    const { caller, captured } = await fresh({ row: confirmedRow() });
    const r = await caller("203.0.113.99").status({ session: "ql_0123456789abcdef01234567", pollSecret: "qs_test" });
    expect(r.state).toBe("ip_mismatch");
    expect("token" in r).toBe(false);
    expect(captured.some((q) => q.includes("state='consumed'"))).toBe(false);
  });

  it("status：双证+同 IP+string affectedRows=1，仍只放 token 一次", async () => {
    const { caller } = await fresh({ row: confirmedRow(), affected: "1" });
    const r = await caller("203.0.113.10").status({ session: "ql_0123456789abcdef01234567", pollSecret: "qs_test" });
    expect(r.state).toBe("confirmed");
    expect("token" in r && r.token).toBe("nt_admin");
  });

  it("status：坏密文=过期并销毁死档，不反复解密也不释放 token", async () => {
    const row = { ...confirmedRow(), wb_token_enc: "bad" };
    const { caller, captured } = await fresh({ row });
    const r = await caller("203.0.113.10").status({ session: "ql_0123456789abcdef01234567", pollSecret: "qs_test" });
    expect(r.state).toBe("expired");
    expect("token" in r).toBe(false);
    expect(captured.some((q) => q.includes("state='expired', wb_token_enc=NULL") && q.includes("state='confirmed'"))).toBe(true);
    expect(captured.some((q) => q.includes("state='consumed'"))).toBe(false);
  });

  it("status：confirmed 超 5 分钟也过期并清密文", async () => {
    const row = { ...confirmedRow(), created_at: new Date(Date.now() - 10 * 60_000) };
    const { caller, captured } = await fresh({ row });
    const r = await caller("203.0.113.10").status({ session: "ql_0123456789abcdef01234567", pollSecret: "qs_test" });
    expect(r.state).toBe("expired");
    expect(captured.some((q) => q.includes("state='expired', wb_token_enc=NULL"))).toBe(true);
  });
});
