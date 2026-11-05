import { afterEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const dialect = new MySqlDialect();
const SESSION = "ql_0123456789abcdef01234567";
const PROOF_KEY = "a".repeat(64);

async function fresh(validSession = true) {
  vi.resetModules();
  vi.stubEnv("QR_LOGIN_ENC_KEY", PROOF_KEY);
  vi.stubEnv("ADMIN_CONSOLE_ID", "lingshu-prod-admin");
  const createdAt = new Date();
  const expiresAt = createdAt.getTime() + 300_000;
  const execute = vi.fn(async (stmt: unknown) => {
    const q = dialect.sqlToQuery(stmt as never);
    if (q.sql.includes("SELECT n FROM st_qr_rate")) return [[{ n: 1 }], []];
    if (q.sql.includes("SELECT id, created_at FROM st_qr_sessions")) return [validSession ? [{ id: 1, created_at: createdAt }] : [], []];
    return [[], []];
  });
  vi.doMock("../queries/connection", () => ({ getDb: () => ({ execute, transaction: async (fn: (tx: { execute: typeof execute }) => unknown) => fn({ execute }) }) }));
  const toBuffer = vi.fn(async () => Buffer.from("png"));
  vi.doMock("qrcode", () => ({ default: { toBuffer } }));
  vi.doMock("@hono/node-server/conninfo", () => ({ getConnInfo: (c: { peerIp?: string }) => ({ remote: { address: c.peerIp === undefined ? "127.0.0.1" : c.peerIp } }) }));
  const proof = await import("./adminQrProof");
  const qrText = proof.buildAdminConsoleQrText(SESSION, expiresAt);
  const mod = await import("./adminQrImage");
  return { mod, toBuffer, qrText };
}

function ctx(text: string, ip = "203.0.113.10", peerIp = "127.0.0.1") {
  return {
    peerIp,
    req: {
      query: (name: string) => name === "text" ? text : undefined,
      header: (name: string) => name === "x-forwarded-for" ? ip : undefined,
    },
    json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  } as never;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("adminQrImage 签名管理台会话出图", () => {
  it("实例签名+有效会话+同 IP=PNG no-store", async () => {
    const { mod, qrText } = await fresh();
    const r = await mod.adminQrImageHandler(ctx(qrText));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });

  it("签名外多余参数不回显，二维码按已验字段重建", async () => {
    const { mod, toBuffer, qrText } = await fresh();
    const r = await mod.adminQrImageHandler(ctx(`${qrText}&x=duplicate`));
    expect(r.status).toBe(200);
    expect(toBuffer).toHaveBeenCalledWith(qrText, expect.any(Object));
  });

  it("普通 workbench、缺 target 或篡改签名均拒", async () => {
    const { mod, toBuffer, qrText } = await fresh();
    const tampered = qrText.replace(/p=[0-9a-f]{32}/, `p=${"0".repeat(32)}`);
    for (const text of ["lingshu://qr-login?s=ql_0123456789abcdef01234567&t=workbench", "lingshu://qr-login?s=ql_0123456789abcdef01234567", tampered]) {
      const r = await mod.adminQrImageHandler(ctx(text));
      expect(r.status).toBe(400);
    }
    expect(toBuffer).not.toHaveBeenCalled();
  });

  it("无 socket peer 证据=拒，XFF 不能自造绑定键", async () => {
    const { mod, toBuffer, qrText } = await fresh();
    const r = await mod.adminQrImageHandler(ctx(qrText, "203.0.113.10", ""));
    expect(r.status).toBe(400);
    expect(toBuffer).not.toHaveBeenCalled();
  });

  it("同签名但会话/IP 不匹配=拒", async () => {
    const { mod, qrText } = await fresh(false);
    const r = await mod.adminQrImageHandler(ctx(qrText, "203.0.113.99"));
    expect(r.status).toBe(400);
  });
});
