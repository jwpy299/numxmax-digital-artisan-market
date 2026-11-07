import { describe, expect, it, vi } from 'vitest'
const CURRENT = { version: "2.9.63", minVersion: "2.9.9", url: "https://downloads.example.invalid/numx-max-v2.9.63.apk", notes: "x" };
async function freshRelease(opts: { files?: string[]; exists?: boolean | ((path: string) => boolean); readBody?: string; readThrows?: boolean; readErrorCode?: string; statErrorCode?: string; lockGot?: number | null; renameFailSecond?: boolean; recoveryFail?: boolean; lockCleanupUnknown?: boolean } = {}) {
  vi.resetModules();
  vi.stubEnv("ADMIN_CABIN_ROLES", "peng:admin:all,song:tech:tech");
  const audit = vi.fn();
  vi.doMock("../auth/adminGate", () => ({ requireAdmin: vi.fn(async (token: string) => ({ grant: true, id: token === "tech" ? 2 : 1, username: token === "tech" ? "song" : "peng" })) }));
  vi.doMock("./adminAnalytics", () => ({ writeAdminAudit: audit, writeAdminAuditResult: async () => true }));
  const fsMock = {
    readFileSync: vi.fn(() => { if (opts.readThrows || opts.readErrorCode) { const e = new Error("read failed") as Error & { code?: string }; e.code = opts.readErrorCode ?? "ENOENT"; throw e; } return opts.readBody ?? JSON.stringify(CURRENT); }),
    writeFileSync: vi.fn((file: string, _body?: string) => { if (opts.recoveryFail && file.includes(".recovery-")) { const e = new Error("denied") as Error & { code: string }; e.code = "EACCES"; throw e; } }),
    readdirSync: vi.fn(() => opts.files ?? ["numx-max-v2.9.63.apk"]),
    statSync: vi.fn((p: string) => {
      if (opts.statErrorCode) { const e = new Error("stat failed") as Error & { code: string }; e.code = opts.statErrorCode; throw e; }
      const exists = typeof opts.exists === "function" ? opts.exists(p) : (opts.exists ?? true);
      if (!exists) { const e = new Error("missing") as Error & { code: string }; e.code = "ENOENT"; throw e; }
      return { size: 80434233, mtime: new Date("2026-10-23"), isDirectory: () => true, isFile: () => true };
    }),
    existsSync: vi.fn((p: string) => typeof opts.exists === "function" ? opts.exists(p) : (opts.exists ?? true)),
    renameSync: vi.fn(),
    rmSync: vi.fn(),
    openSync: vi.fn(() => 1),
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
  };
  fsMock.renameSync.mockImplementation(() => {
    if (opts.renameFailSecond && fsMock.renameSync.mock.calls.length === 2) {
      const e = new Error("second rename failed") as Error & { code: string };
      e.code = "EIO";
      throw e;
    }
  });
  vi.doMock("node:fs", () => ({ default: fsMock }));
  const conn = {
    connection: { query: vi.fn(), destroy: vi.fn() },
    query: vi.fn(async (input: string | { sql: string }) => {
      const text = typeof input === "string" ? input : input.sql;
      if (text.includes("GET_LOCK")) return [[{ got: opts.lockGot === undefined ? 1 : opts.lockGot }], []];
      if (text.includes("RELEASE_LOCK")) return [[{ released: 1 }], []];
      return [[], []];
    }),
    end: vi.fn(async () => undefined),
    destroy: vi.fn(),
  };
  vi.doMock("mysql2/promise", () => ({ createConnection: async () => conn }));
  vi.doMock("../queries/connection", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../queries/connection")>();
    return { ...actual, getDb: () => ({ $client: { getConnection: vi.fn(async () => conn) } }) };
  });
  vi.doMock("../lib/releaseFileLock", () => ({ withReleaseFileLock: async (fn: () => Promise<unknown>) => Object.assign({}, await fn() as Record<string, unknown>, opts.lockCleanupUnknown ? { lockCleanupUnknown: true, warning: '锁释放结果未知' } : {}) }));
  const mod = await import("./adminRelease");
  return { mod, fsMock, audit, conn };
}

describe("adminRelease 历史域名与锁清理", () => {
  it("rollback：历史域名变化仍按版本文件恢复并写回当前域名", async () => {
    const { mod, fsMock } = await freshRelease();
    fsMock.readFileSync.mockImplementation(((file: unknown) => {
      if (String(file).includes("api-app-release.json")) { const e = new Error("missing") as Error & { code?: string }; e.code = "ENOENT"; throw e; }
      if (String(file).includes("manifest-history")) return JSON.stringify({ ...CURRENT, version: "2.9.5", url: "https://old.example/numx-max-v2.9.5.apk" });
      return JSON.stringify(CURRENT);
    }) as never);
    const r = await mod.adminReleaseRouter.createCaller({} as never).rollback({ token: "boss", reviewToken: "tech", version: "2.9.5" });
    expect(r.ok).toBe(true);
    expect(r.url).toBe("https://downloads.example.invalid/numx-max-v2.9.5.apk");
  });
  it("rollback：DOWNLOAD_BASE 含路径前缀时按当前服务实际 URL 校验历史快照", async () => {
    vi.stubEnv("PORTAL_DOWNLOAD_BASE_URL", "https://cdn.example/releases");
    const { mod, fsMock } = await freshRelease();
    fsMock.readFileSync.mockImplementation(((file: unknown) => {
      if (String(file).includes("api-app-release.json")) { const e = new Error("missing") as Error & { code?: string }; e.code = "ENOENT"; throw e; }
      if (String(file).includes("manifest-history")) return JSON.stringify({ ...CURRENT, version: "2.9.5", url: "https://old.example/releases/numx-max-v2.9.5.apk" });
      return JSON.stringify(CURRENT);
    }) as never);
    const r = await mod.adminReleaseRouter.createCaller({} as never).rollback({ token: "boss", reviewToken: "tech", version: "2.9.5" });
    expect(r.url).toBe("https://cdn.example/releases/numx-max-v2.9.5.apk");
    vi.unstubAllEnvs();
  });
  it("publish：回滚改写 notes/minVersion 后仍保留首份快照且允许再次发布", async () => {
    const { mod, fsMock } = await freshRelease();
    fsMock.readFileSync.mockImplementation(((file: unknown) => {
      if (String(file).includes("api-app-release.json")) return JSON.stringify({ ...CURRENT, notes: "首次发布", minVersion: "2.9.9" });
      return JSON.stringify({ ...CURRENT, notes: "回滚至 v2.9.63（原 3.0.0）", minVersion: "2.9.63" });
    }) as never);
    const r = await mod.adminReleaseRouter.createCaller({} as never).publish({ token: "boss", reviewToken: "tech", version: "3.0.0", url: "numx-max-v3.0.0.apk", notes: "再次递进" });
    expect(r.ok).toBe(true);
    expect(fsMock.writeFileSync.mock.calls.some((call) => String(call[0]).includes("api-app-release.json.tmp-"))).toBe(false);
  });
  it("publish：API 快照与恢复脚本快照分名，不覆盖全量制品校验清单", async () => {
    const { mod, fsMock } = await freshRelease();
    fsMock.readFileSync.mockImplementation(((file: unknown) => {
      if (String(file).includes("api-app-release.json")) { const e = new Error("missing") as Error & { code?: string }; e.code = "ENOENT"; throw e; }
      return JSON.stringify(CURRENT);
    }) as never);
    await mod.adminReleaseRouter.createCaller({} as never).publish({ token: "boss", reviewToken: "tech", version: "3.0.0", url: "numx-max-v3.0.0.apk", notes: "x" });
    const writes = fsMock.writeFileSync.mock.calls.map((call) => String(call[0])).filter((file) => file.includes("manifest-history"));
    expect(writes.some((file) => file.includes("/api-app-release.json.tmp-"))).toBe(true);
    expect(writes.some((file) => file.includes("/api-SHA256SUMS.tmp-"))).toBe(true);
    expect(writes.some((file) => file.includes("/api-snapshot-hashes.tsv.tmp-"))).toBe(true);
    expect(writes.some((file) => file.includes("/SHA256SUMS.tmp-"))).toBe(false);
    expect(writes.some((file) => file.includes("/snapshot-hashes.tsv.tmp-"))).toBe(false);
  });
  it("publish：锁清理未知与审计结果同时保留，不覆盖警告", async () => {
    const { mod } = await freshRelease({ lockCleanupUnknown: true });
    const r = await mod.adminReleaseRouter.createCaller({} as never).publish({ token: "boss", reviewToken: "tech", version: "3.0.0", url: "numx-max-v3.0.0.apk", notes: "x" });
    expect(r.lockCleanupUnknown).toBe(true);
    expect(r.warning).toBeTruthy();
    expect(r.version).toBe("3.0.0");
  });
});
