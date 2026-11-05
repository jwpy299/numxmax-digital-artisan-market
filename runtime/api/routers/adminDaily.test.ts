import { afterEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const dialect = new MySqlDialect();

async function freshDaily(opts: { rows?: Array<Record<string, unknown>>; roles?: string; affected?: number; cacheMs?: number; dshToken?: string } = {}) {
  vi.resetModules();
  vi.stubEnv("ADMIN_CABIN_ROLES", opts.roles ?? "peng:admin:all,song:tech:tech,qiu:ops:ops");
  vi.stubEnv("HQ_FACTORY_IDS", "6380240");
  vi.stubEnv("DSH_SERVICE_TOKEN", opts.dshToken ?? "test-token");
  vi.stubEnv("ADMIN_RUNTIME_CACHE_MS", String(opts.cacheMs ?? 0));
  const audit = vi.fn();
  vi.doMock("../auth/adminGate", () => ({
    requireAdmin: vi.fn(async (token: string) => ({ grant: true, id: token === "tech" ? 2 : token === "ops" ? 3 : 1, username: token === "tech" ? "song" : token === "ops" ? "qiu" : "peng", displayName: "管理席" })),
    hqFactoryIds: () => [6380240],
  }));
  const captured: string[] = [];
  const db = {
    execute: vi.fn(async (stmt: unknown) => {
      const q = dialect.sqlToQuery(stmt as never);
      captured.push(q.sql);
      if (q.sql.includes("FROM st_beta_daily_codes")) return [[{ id: 3, code_text: "工单直达", quota: 15, used_count: 2, biz_date: "2026-10-24" }], []];
      if (q.sql.includes("DATE_FORMAT(CURDATE()")) return [[{ biz_date: "2026-10-24", day_start_epoch: Date.UTC(2026, 9, 24) / 1000, day_end_epoch: Date.UTC(2026, 9, 25) / 1000 }], []];
      if (q.sql.includes("COUNT(*)")) return [[{ n: 3 }], []];
      if (q.sql.includes("FROM st_beta_invites") && q.sql.includes("SELECT")) return [opts.rows ?? [], []];
      if (q.sql.includes("UPDATE")) return [{ affectedRows: opts.affected ?? 1 }, []];
      if (q.sql.includes("INSERT")) return [{ insertId: 7 }, []];
      return [[], []];
    }),
    transaction: vi.fn(async (fn: (tx: never) => Promise<unknown>) => fn({ execute: db.execute } as never)),
  };
  const lockSql = (input: string | { sql: string }) => {
    const text = typeof input === "string" ? input : input.sql;
    if (text.includes("GET_LOCK")) return [[{ got: 1 }], []];
    if (text.includes("RELEASE_LOCK")) return [[{ released: 1 }], []];
    if (text.includes("FROM st_beta_invites")) return [opts.rows ?? [], []];
    if (text.includes("UPDATE")) return [{ affectedRows: 1 }, []];
    if (text.includes("INSERT")) return [{ insertId: 7 }, []];
    return [[], []];
  };
  const conn = { connection: { query: vi.fn(), destroy: vi.fn() }, query: vi.fn(lockSql), execute: vi.fn(lockSql), end: vi.fn(async () => undefined), destroy: vi.fn() };
  vi.doMock("mysql2/promise", () => ({ createConnection: async () => conn }));
  vi.doMock("../queries/connection", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../queries/connection")>();
    return { ...actual, getDb: () => db };
  });
  vi.doMock("./betaInvites", () => ({
    ensureBetaInvites: vi.fn(async () => undefined),
    withBetaInvitePhoneLock: vi.fn(async (_phone: string, fn: (tx: never) => Promise<unknown>) => db.transaction(fn)),
  }));
  vi.doMock("./adminAnalytics", () => ({ writeAdminAudit: audit, writeAdminAuditResult: async () => true }));
  const mod = await import("./adminDaily");
  return { mod, captured, audit };
}

function stubHarness(overrides: Record<string, unknown> = {}) {
  const payloads: Record<string, unknown> = {
    load: { workers: 2 }, tasks: { items: [], total: 0 }, reviews: { items: [], total: 0 }, health: { items: [] }, notices: { items: [], total: 0 }, ...overrides,
  };
  const fetchMock = vi.fn(async (input: unknown) => {
    const u = String(input);
    if (u.includes("/org/load")) return Response.json(payloads.load);
    if (u.includes("/org/tasks")) return Response.json(payloads.tasks);
    if (u.includes("/reviews")) return Response.json(payloads.reviews);
    if (u.includes("/org/health")) return Response.json(payloads.health);
    if (u.includes("/notices")) return Response.json(payloads.notices);
    return Response.json({ error: "not_found" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { ...payloads, fetchMock };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("adminDaily 运营面", () => {
  it("stats：口令/余量/KPI/数据库日期真面；今日兑换只读口令 used_count", async () => {
    const { mod, captured } = await freshDaily();
    const r = await mod.adminDailyRouter.createCaller({} as never).stats({ token: "boss" });
    expect(r.codeText).toBe("工单直达");
    expect(r.left).toBe(13);
    expect(r.pendingIssue).toBe(3);
    expect(r.redeemedToday).toBe(2);
    expect(r.date).toBe("2026-10-24");
    expect(captured.some((q) => q.includes("enterprise_name = '' AND created_at >= CURDATE()"))).toBe(false);
  });

  it("runtime：HARNESS_POOL_URL 优先且去尾斜杠，兼容 HARNESS_POOL_BASE", async () => {
    const harness = stubHarness();
    vi.stubEnv("HARNESS_POOL_URL", "http://127.0.0.1:29999/");
    const { mod } = await freshDaily();
    await mod.adminDailyRouter.createCaller({} as never).runtime({ token: "boss" });
    expect(harness.fetchMock.mock.calls.some((c) => String(c[0]).startsWith("http://127.0.0.1:29999/org/load"))).toBe(true);
  });

  it("runtime：error JSON=未达，reviewsPending 不伪装 0", async () => {
    stubHarness({ reviews: { error: "unauthorized" } });
    const { mod } = await freshDaily();
    const r = await mod.adminDailyRouter.createCaller({} as never).runtime({ token: "boss" });
    expect(r.degraded).toBe(true);
    expect(r.reviewsPending).toBeNull();
  });

  it("runtime：截断页=未知；有真实 total 才报真实总数", async () => {
    const payloads: any = stubHarness({ reviews: { items: Array.from({ length: 20 }, (_, i) => ({ id: i + 1 })) } });
    const { mod } = await freshDaily();
    const caller = mod.adminDailyRouter.createCaller({} as never);
    const saturated = await caller.runtime({ token: "boss" });
    expect(saturated.degraded).toBe(true);
    expect(saturated.reviewsPending).toBeNull();
    payloads.reviews.total = 50;
    const counted = await caller.runtime({ token: "boss" });
    expect(counted.degraded).toBe(false);
    expect(counted.reviewsPending).toBe(50);
  });

  it("runtime：今日失败按 DB 日期+updated_at，昨天创建今天失败也计入", async () => {
    stubHarness({ tasks: { items: [{ id: 9, status: "failed", created_at: "2026-10-23 23:59:00", updated_at: "2026-10-24 00:01:00" }], total: 1 } });
    const { mod } = await freshDaily();
    const r = await mod.adminDailyRouter.createCaller({} as never).runtime({ token: "boss" });
    expect(r.failedToday).toBe(1);
    expect(r.failedItems[0]?.id).toBe(9);
  });

  it("runtime：items 缺失/变形=降级且计数未知，不显示假 0", async () => {
    stubHarness({ tasks: { total: 0 } });
    const { mod } = await freshDaily();
    const r = await mod.adminDailyRouter.createCaller({} as never).runtime({ token: "boss" });
    expect(r.degraded).toBe(true);
    expect(r.executing).toBeNull();
    expect(r.failedToday).toBeNull();
  });

  it("runtime：带时区时间戳按 DB 日界计，不拿字符串日期误判", async () => {
    stubHarness({ tasks: { items: [{ id: 10, status: "failed", updated_at: "2026-10-25T01:30:00+08:00" }], total: 1 } });
    const { mod } = await freshDaily();
    const r = await mod.adminDailyRouter.createCaller({} as never).runtime({ token: "boss" });
    expect(r.failedToday).toBe(1);
  });

  it("runtime：短缓存复用同一 Harness 响应；缺 token 不发空 Bearer", async () => {
    const harness = stubHarness();
    const cached = await freshDaily({ cacheMs: 5000 });
    const caller = cached.mod.adminDailyRouter.createCaller({} as never);
    await caller.runtime({ token: "boss" });
    const before = harness.fetchMock.mock.calls.length;
    await caller.runtime({ token: "boss" });
    expect(harness.fetchMock.mock.calls.length).toBe(before);
    const missing = await freshDaily({ dshToken: "" });
    const r = await missing.mod.adminDailyRouter.createCaller({} as never).runtime({ token: "boss" });
    expect(r.degraded).toBe(true);
    expect(harness.fetchMock.mock.calls.length).toBe(before);
  });

  it("quotaSet：同人明拒；双人过且写 before/after+复核 id 审计", async () => {
    const same = await freshDaily();
    await expect(same.mod.adminDailyRouter.createCaller({} as never).quotaSet({ token: "boss", reviewToken: "boss", quota: 18 })).rejects.toThrow("同一人");
    const ok = await freshDaily();
    const r = await ok.mod.adminDailyRouter.createCaller({} as never).quotaSet({ token: "boss", reviewToken: "ops", quota: 18 });
    expect(r.ok).toBe(true);
    expect(ok.audit).toHaveBeenCalledWith(1, "peng", "adminDaily.quotaSet", "2026-10-24", expect.objectContaining({ before: 15, after: 18, reviewerId: 3 }));
  });

  it("issue：同号已有活码明拒；成功签发走手机号锁并持久化企业名", async () => {
    const dup = await freshDaily({ rows: [{ id: 9 }] });
    await expect(dup.mod.adminDailyRouter.createCaller({} as never).issue({ token: "boss", phone: "13800000001", enterpriseName: "测试企业", ttlHours: 72 })).rejects.toThrow("已有未消费活码");
    const ok = await freshDaily({ rows: [] });
    const r = await ok.mod.adminDailyRouter.createCaller({} as never).issue({ token: "boss", phone: "13800000001", enterpriseName: "测试企业", ttlHours: 72 });
    expect(r.code).toMatch(/^iv_[0-9a-f]{48}$/);
    expect(r.phone).toBe("138****0001");
    expect(ok.captured.some((q) => q.includes("enterprise_name"))).toBe(true);
    expect(ok.audit).toHaveBeenCalledWith(1, "peng", "adminDaily.issue", "测试企业", expect.objectContaining({ codeHash8: expect.any(String) }));
  });

  it("quotaSet：当日行更新为 0 行时不得返回假成功或写审计", async () => {
    const { mod, audit } = await freshDaily({ affected: 0 });
    await expect(mod.adminDailyRouter.createCaller({} as never).quotaSet({ token: "boss", reviewToken: "ops", quota: 16 })).rejects.toThrow("跨午夜");
    expect(audit).not.toHaveBeenCalled();
  });

  it("issue：staff 只读，不能签发", async () => {
    const { mod } = await freshDaily({ roles: "" });
    await expect(mod.adminDailyRouter.createCaller({} as never).issue({ token: "boss", phone: "13800000001", enterpriseName: "测试企业", ttlHours: 72 })).rejects.toThrow("只读");
  });

  it("issue：非法第二位手机号=schema 明拒", async () => {
    const { mod } = await freshDaily();
    await expect(mod.adminDailyRouter.createCaller({} as never).issue({ token: "boss", phone: "10000000000", enterpriseName: "测试企业", ttlHours: 72 })).rejects.toThrow("手机号须 11 位");
  });

  it("list：掩码/hash8/企业名/吊销状态分面，全 hash 不出，日期由 DB 格式化", async () => {
    const { mod, captured } = await freshDaily({ rows: [{ id: 7, phone: "13800000001", codeHash: "ab".repeat(32), enterprise_name: "测试企业", expires_at: "2026-10-26", consumed_at: "2026-10-24", revoked_at: "2026-10-24", created_at: "2026-10-24", status: "已吊销" }] });
    const r = await mod.adminDailyRouter.createCaller({} as never).list({ token: "boss", limit: 10 });
    expect(captured.some((q) => q.includes("DATE_FORMAT(created_at") && q.includes("DATE_FORMAT(expires_at"))).toBe(true);
    expect(r.items[0].phone).toBe("138****0001");
    expect(r.items[0].codeHash8).toBe("abababab");
    expect(r.items[0].enterpriseName).toBe("测试企业");
    expect(r.items[0].status).toBe("已吊销");
    expect(JSON.stringify(r.items[0])).not.toContain("ab".repeat(32));
  });

  it("revoke：同人明拒；成功只写 revoked_at，不伪装 consumed_at", async () => {
    const same = await freshDaily();
    await expect(same.mod.adminDailyRouter.createCaller({} as never).revoke({ token: "boss", reviewToken: "boss", id: 7 })).rejects.toThrow("同一人");
    const ok = await freshDaily();
    const r = await ok.mod.adminDailyRouter.createCaller({} as never).revoke({ token: "boss", reviewToken: "ops", id: 7 });
    expect(r.status).toBe("revoked");
    const upd = ok.captured.find((q) => q.includes("UPDATE st_beta_invites SET revoked_at"));
    expect(upd).toBeTruthy();
    expect(upd).not.toContain("SET consumed_at");
    expect(ok.audit).toHaveBeenCalledWith(1, "peng", "adminDaily.revoke", "7", expect.objectContaining({ reviewerId: 3 }));
  });
});

const CURRENT = { version: "2.9.63", minVersion: "2.9.9", url: "https://downloads.example.invalid/numx-max-v2.9.63.apk", notes: "x" };

async function freshRelease(opts: { files?: string[]; exists?: boolean | ((path: string) => boolean); readBody?: string; readThrows?: boolean; readErrorCode?: string; statErrorCode?: string; lockGot?: number | null; renameFailSecond?: boolean; recoveryFail?: boolean } = {}) {
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
  vi.doMock("../lib/releaseFileLock", () => ({ withReleaseFileLock: async (fn: () => Promise<unknown>) => fn() }));
  const mod = await import("./adminRelease");
  return { mod, fsMock, audit, conn };
}

describe("adminRelease 通道面", () => {
  it("current：配置缺失显式未初始化，不伪装已有版本", async () => {
    const { mod } = await freshRelease({ readThrows: true });
    const r = await mod.adminReleaseRouter.createCaller({} as never).current({ token: "boss" });
    expect(r.initialized).toBe(false);
    expect(r.app).toBeNull();
  });

  it("current：EACCES/ELOOP 不伪装桌面包不存在", async () => {
    const { mod } = await freshRelease({ statErrorCode: "EACCES" });
    await expect(mod.adminReleaseRouter.createCaller({} as never).current({ token: "boss" })).rejects.toThrow();
  });

  it("history：2.9.10 数值排序在 2.9.9 前", async () => {
    const { mod } = await freshRelease({ files: ["numx-max-v2.9.9.apk", "numx-max-v2.9.10.apk"] });
    const r = await mod.adminReleaseRouter.createCaller({} as never).history({ token: "boss" });
    expect(r.items.map((x) => x.file)).toEqual(["numx-max-v2.9.10.apk", "numx-max-v2.9.9.apk"]);
  });

  it("publish：不递进/版本与 URL 不匹配/APK 未落盘均明拒", async () => {
    const a = await freshRelease();
    await expect(a.mod.adminReleaseRouter.createCaller({} as never).publish({ token: "boss", reviewToken: "tech", version: "2.9.62", url: "numx-max-v2.9.62.apk", notes: "x" })).rejects.toThrow("递进");
    await expect(a.mod.adminReleaseRouter.createCaller({} as never).publish({ token: "boss", reviewToken: "tech", version: "3.0.0", url: "numx-max-v2.9.0.apk", notes: "x" })).rejects.toThrow("与版本一致");
    const b = await freshRelease({ exists: false });
    await expect(b.mod.adminReleaseRouter.createCaller({} as never).publish({ token: "boss", reviewToken: "tech", version: "3.0.0", url: "numx-max-v3.0.0.apk", notes: "x" })).rejects.toThrow("未落盘");
  });

  it("publish：dist/public 缺包也拒，不能写两面查一面", async () => {
    const { mod } = await freshRelease({ exists: (p) => !p.includes("dist/public") });
    await expect(mod.adminReleaseRouter.createCaller({} as never).publish({ token: "boss", reviewToken: "tech", version: "3.0.0", url: "numx-max-v3.0.0.apk", notes: "x" })).rejects.toThrow("未落盘");
  });

  it("publish：真实 APK+裸文件名也统一写绝对链，双写 rename", async () => {
    const { mod, fsMock } = await freshRelease();
    const r = await mod.adminReleaseRouter.createCaller({} as never).publish({ token: "boss", reviewToken: "tech", version: "3.0.0", url: "numx-max-v3.0.0.apk", notes: "x" });
    expect(r.url).toBe("https://downloads.example.invalid/numx-max-v3.0.0.apk");
    expect(fsMock.writeFileSync.mock.calls.some((c) => String(c[1]).includes(r.url))).toBe(true);
    expect(fsMock.renameSync).toHaveBeenCalledTimes(2);
    expect(fsMock.rmSync).toHaveBeenCalled();
    const body = fsMock.writeFileSync.mock.calls.map((c) => String(c[1])).join("\n");
    expect(body).toContain('"minVersion": "3.0.0"');
    expect(fsMock.openSync).toHaveBeenCalledWith(expect.any(String), "r+");
  });

  it("history：dist 缺双份标 synced:false，不给可回滚假面", async () => {
    const { mod } = await freshRelease({ exists: (p) => !p.includes("dist/public") });
    const r = await mod.adminReleaseRouter.createCaller({} as never).history({ token: "boss" });
    expect(r.items[0]?.synced).toBe(false);
  });

  it("current/publish：release JSON 形态损坏=显错，不伪装未初始化或覆盖", async () => {
    const { mod } = await freshRelease({ readBody: JSON.stringify({ version: "bad" }) });
    await expect(mod.adminReleaseRouter.createCaller({} as never).current({ token: "boss" })).rejects.toThrow("形态无效");
  });

  it("rollback：历史包不存在=NOT_FOUND", async () => {
    const { mod } = await freshRelease({ exists: false });
    await expect(mod.adminReleaseRouter.createCaller({} as never).rollback({ token: "boss", reviewToken: "tech", version: "2.9.50" })).rejects.toThrow("历史包不存在");
  });

  it("rollback：回滚低于 minVersion 时同步下调，不产生 version<minVersion", async () => {
    const { mod, fsMock } = await freshRelease();
    fsMock.readFileSync.mockImplementation(((file: unknown) => {
      if (String(file).includes("manifest-history")) { const e = new Error("missing") as Error & { code: string }; e.code = "ENOENT"; throw e; }
      return JSON.stringify(CURRENT);
    }) as never);
    const r = await mod.adminReleaseRouter.createCaller({} as never).rollback({ token: "boss", reviewToken: "tech", version: "2.9.5" });
    expect(r.ok).toBe(true);
    const body = fsMock.writeFileSync.mock.calls.map((c) => String(c[1])).join("\n");
    expect(body).toContain('"minVersion": "2.9.5"');
  });

  it("rollback：历史快照版本不一致时 fail-closed", async () => {
    const { mod } = await freshRelease();
    await expect(mod.adminReleaseRouter.createCaller({} as never).rollback({ token: "boss", reviewToken: "tech", version: "2.9.5" })).rejects.toThrow("历史快照与目标版本或下载链不一致");
  });

  it("publish：命名锁未取得=不写包；成功路径锁内重读并释放连接", async () => {
    const blocked = await freshRelease({ lockGot: 0 });
    await expect(blocked.mod.adminReleaseRouter.createCaller({} as never).publish({ token: "boss", reviewToken: "tech", version: "3.0.0", url: "numx-max-v3.0.0.apk", notes: "x" })).rejects.toThrow("另一发布/回滚");
    expect(blocked.fsMock.writeFileSync).not.toHaveBeenCalled();
    expect(blocked.conn.end).toHaveBeenCalledTimes(1);
    const ok = await freshRelease();
    await ok.mod.adminReleaseRouter.createCaller({} as never).publish({ token: "boss", reviewToken: "tech", version: "3.0.0", url: "numx-max-v3.0.0.apk", notes: "x" });
    expect(ok.conn.query.mock.calls.some((c) => String(typeof c[0] === "string" ? c[0] : c[0].sql).includes("GET_LOCK(?, ?) AS got"))).toBe(true);
    expect(ok.conn.end).toHaveBeenCalledTimes(1);
    expect(ok.conn.destroy).not.toHaveBeenCalled();
  });

  it("history：列目录后文件被清理=跳过该件；正常分支也返 initialized", async () => {
    const { mod, fsMock } = await freshRelease();
    fsMock.statSync.mockImplementation(() => { const e = new Error("gone") as Error & { code: string }; e.code = "ENOENT"; throw e; });
    const r = await mod.adminReleaseRouter.createCaller({} as never).history({ token: "boss" });
    expect(r.items).toEqual([]);
    expect(r.initialized).toBe(true);
  });

  it("rollback：同版或更高版本不伪装回滚，须走 publish 递进闸", async () => {
    const { mod, fsMock } = await freshRelease();
    const caller = mod.adminReleaseRouter.createCaller({} as never);
    await expect(caller.rollback({ token: "boss", reviewToken: "tech", version: "2.9.63" })).rejects.toThrow("回滚目标须低于当前版本");
    await expect(caller.rollback({ token: "boss", reviewToken: "tech", version: "3.0.0" })).rejects.toThrow("回滚目标须低于当前版本");
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it("publish：备份读取 EACCES 中止且不删除原 release 文件", async () => {
    const { mod, fsMock } = await freshRelease({ readErrorCode: "EACCES" });
    await expect(mod.adminReleaseRouter.createCaller({} as never).publish({ token: "boss", reviewToken: "tech", version: "3.0.0", url: "numx-max-v3.0.0.apk", notes: "x" })).rejects.toThrow();
    expect(fsMock.rmSync).not.toHaveBeenCalled();
  });

  it("publish：第二 rename 与补偿均失败=明确分叉且 fsync 已执行", async () => {
    const { mod, fsMock } = await freshRelease({ renameFailSecond: true, recoveryFail: true });
    await expect(mod.adminReleaseRouter.createCaller({} as never).publish({ token: "boss", reviewToken: "tech", version: "3.0.0", url: "numx-max-v3.0.0.apk", notes: "x" })).rejects.toThrow("已分叉");
    expect(fsMock.fsyncSync).toHaveBeenCalledTimes(2);
  });

  it("history：门户目录缺失=initialized:false，不抛基础设施错", async () => {
    const { mod, fsMock } = await freshRelease({ readThrows: true });
    fsMock.readdirSync.mockImplementation(() => { const e = new Error("missing") as Error & { code: string }; e.code = "ENOENT"; throw e; });
    const r = await mod.adminReleaseRouter.createCaller({} as never).history({ token: "boss" });
    expect(r.initialized).toBe(false);
    expect(r.items).toEqual([]);
  });
  it("rollback：有历史快照时按快照恢复并标记 snapshotVerified", async () => {
    const { mod, fsMock } = await freshRelease({ readBody: JSON.stringify({ ...CURRENT, version: "2.9.65" }) });
    fsMock.readFileSync.mockImplementation(((file: unknown) => String(file).includes("manifest-history")
      ? JSON.stringify({ ...CURRENT, version: "2.9.63" })
      : JSON.stringify({ ...CURRENT, version: "2.9.65" })) as never);
    const r = await mod.adminReleaseRouter.createCaller({} as never).rollback({ token: "boss", reviewToken: "tech", version: "2.9.63" });
    expect(r.snapshotVerified).toBe(true);
    expect(fsMock.writeFileSync.mock.calls.some((c) => String(c[1]).includes('"version": "2.9.63"'))).toBe(true);
  });
});
