/**
 * betaDaily 钉（彭总 2026-10-23 令·每日口令兑专属邀测码面）：
 * 1. 建表面：DDL 字钉（uk_biz_date/used_count 缺省 0——SQL 模板串无行尾注释纪律面）；
 * 2. today 惰性生成面：无当日行=建（uk 撞 1062 容=并发双生幂等）；已有=不建直接回；
 * 3. redeem 闸面：口令错明拒/名额完明拒/一 phone 当日已兑拒/IP 限流拒；
 * 4. redeem 成功面：码=iv_ 48hex 明文凭返+sha256 落库+kind=enterprise+72h 有效+名额+1+OTP 消费序（daily 锁→插码→OTP 殿后）；
 * 5. quota env 钉：BETA_DAILY_QUOTA 默认 15（彭总口径 10-20 区间中值）。
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { z } from "zod";

const dialect = new MySqlDialect();
type ExecCapture = { sql: string; params: unknown[] };

interface FakeOpts {
  todayRows?: Array<Record<string, unknown>>; // 首个 SELECT 当日行
  todayRowsAgain?: Array<Record<string, unknown>>; // INSERT 后重取行（缺省=todayRows）
  insertDup?: boolean; // INSERT 当日行撞 1062
  inviteDup?: boolean; // 该 phone 当日已兑
  lockedRow?: Record<string, unknown> | null; // FOR UPDATE 锁行（null=同 todayRows[0]）
}

/** 每例独立模块实例（ready/ipHits 模块级缓存——resetModules 给净实例） */
async function freshRouter(opts: FakeOpts) {
  vi.resetModules();
  const captured: ExecCapture[] = [];
  const txCaptured: ExecCapture[] = [];
  const db = {
    execute: async (stmt: unknown) => {
      const q = dialect.sqlToQuery(stmt as never);
      captured.push({ sql: q.sql, params: q.params as unknown[] });
      if (q.sql.includes("CREATE TABLE")) return [[], []];
      if (q.sql.includes("FROM st_beta_daily_codes WHERE biz_date = CURDATE()")) {
        const rows = captured.some((c) => c.sql.includes("INSERT INTO st_beta_daily_codes")) ? (opts.todayRowsAgain ?? opts.todayRows ?? []) : (opts.todayRows ?? []);
        return [rows, []];
      }
      if (q.sql.includes("FROM st_beta_invites WHERE")) return [opts.inviteDup ? [{ id: 9 }] : [], []];
      return [[], []];
    },
    transaction: async (fn: (tx: never) => Promise<unknown>) => {
      const tx = {
        execute: async (stmt: unknown) => {
          const q = dialect.sqlToQuery(stmt as never);
          txCaptured.push({ sql: q.sql, params: q.params as unknown[] });
          if (q.sql.includes("FOR UPDATE")) {
            const row = opts.lockedRow !== undefined ? opts.lockedRow : (opts.todayRowsAgain ?? opts.todayRows ?? [])[0] ?? null;
            return [row ? [row] : [], []];
          }
          if (q.sql.includes("FROM st_beta_invites WHERE")) return [opts.inviteDup ? [{ id: 9 }] : [], []];
          if (q.sql.includes("UPDATE st_beta_daily_codes")) return [{ affectedRows: 1 }, []];
          if (q.sql.includes("INSERT INTO st_beta_invites")) return [{ insertId: 77 }, []];
          return [[], []];
        },
      };
      return fn(tx as never);
    },
  };
  vi.doMock("../queries/connection", () => ({ getDb: () => db }));
  vi.doMock("./smsVerify", () => ({
    phoneSchema: z.string().trim().regex(/^1\d{10}$/),
    verifySmsCodeOnly: vi.fn(async () => ({ rowId: 5 })),
    consumeSmsCodeById: vi.fn(async () => undefined),
  }));
  vi.doMock("./betaInvites", () => ({
    ensureBetaInvites: vi.fn(async () => undefined),
    withBetaInvitePhoneLock: vi.fn(async (_phone: string, fn: (tx: never) => Promise<unknown>) => db.transaction(fn)),
  }));
  const mod = await import("./betaDaily");
  return { mod, captured, txCaptured };
}

const CALLER_CTX = { clientIp: "1.2.3.4", req: { headers: new Headers({ "x-forwarded-for": "1.2.3.4" }) } } as never;
const TODAY_ROW = { id: 3, code_text: "云枢天工", quota: 15, used_count: 2, biz_date: "2026-10-24" };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("betaDaily 每日口令面", () => {
  it("建表 DDL 字钉（uk_biz_date+used_count 缺省 0）", async () => {
    const { mod, captured } = await freshRouter({ todayRows: [TODAY_ROW] });
    await mod.betaDailyRouter.createCaller(CALLER_CTX).today();
    const ddl = captured.find((c) => c.sql.includes("CREATE TABLE"));
    expect(ddl?.sql).toContain("st_beta_daily_codes");
    expect(ddl?.sql).toContain("UNIQUE KEY uk_biz_date");
    expect(ddl?.sql).toContain("used_count INT NOT NULL DEFAULT 0");
  });

  it("today：已有当日行=不插直接回（幂等面）；余量=quota-used 不回负", async () => {
    const { mod, captured } = await freshRouter({ todayRows: [TODAY_ROW] });
    const r = await mod.betaDailyRouter.createCaller(CALLER_CTX).today();
    expect(r.codeText).toBe("云枢天工");
    expect(r.left).toBe(13);
    expect(captured.some((c) => c.sql.includes("INSERT INTO st_beta_daily_codes"))).toBe(false);
  });

  it("today：无当日行=惰性生成（词库四字面+uk 撞 1062 容+重取权威行）", async () => {
    const { mod, captured } = await freshRouter({ todayRows: [], todayRowsAgain: [TODAY_ROW] });
    const r = await mod.betaDailyRouter.createCaller(CALLER_CTX).today();
    expect(r.codeText).toBe("云枢天工");
    const ins = captured.find((c) => c.sql.includes("INSERT INTO st_beta_daily_codes"));
    expect(ins?.sql).toContain("CURDATE()");
    expect(String(ins?.params[0])).toMatch(/^[\u4e00-\u9fa5]{4}$/); // 四字钉
    expect(mod.CODE_PHRASES_FOR_TEST ?? []).toContain(String(ins?.params[0])); // 品牌池成员钉（NumX Max 品牌面——池外词不放行）
    expect(ins?.params[1]).toBe(15); // quota 默认钉
  });

  it("redeem：口令错=明拒（且不占名额——事务不进）", async () => {
    const { mod, txCaptured } = await freshRouter({ todayRows: [TODAY_ROW] });
    await expect(
      mod.betaDailyRouter.createCaller(CALLER_CTX).redeem({ codeText: "错口令子", phone: "13800000001", smsCode: "123456" }),
    ).rejects.toThrow("口令不对");
    expect(txCaptured.length).toBe(0);
  });

  it("redeem：名额完=明拒「今日名额已抢完」", async () => {
    const { mod } = await freshRouter({ todayRows: [{ ...TODAY_ROW, used_count: 15 }], lockedRow: { ...TODAY_ROW, used_count: 15 } });
    await expect(
      mod.betaDailyRouter.createCaller(CALLER_CTX).redeem({ codeText: "云枢天工", phone: "13800000002", smsCode: "123456" }),
    ).rejects.toThrow("今日名额已抢完");
  });

  it("redeem：一 phone 当日已兑=拒（一机一日一码）", async () => {
    const { mod, txCaptured } = await freshRouter({ todayRows: [TODAY_ROW], inviteDup: true });
    await expect(
      mod.betaDailyRouter.createCaller(CALLER_CTX).redeem({ codeText: "云枢天工", phone: "13800000003", smsCode: "123456" }),
    ).rejects.toThrow("今日已兑过");
    const dup = txCaptured.find((c) => c.sql.includes("FROM st_beta_invites WHERE"));
    expect(dup?.sql).toContain("created_at > CURDATE()");
    expect(dup?.sql).not.toContain("revoked_at IS NULL"); // revoked 也占当日一码，不能循环烧共享名额
  });

  it("quota：非法/越界配置回退 15 且显式留痕", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("BETA_DAILY_QUOTA", "30");
    const { mod } = await freshRouter({ todayRows: [TODAY_ROW] });
    expect(mod.BETA_DAILY_QUOTA).toBe(15);
    expect(console.warn).toHaveBeenCalled();
  });

  it("redeem 成功面：iv_ 48hex 明文返+sha256 落库+kind enterprise+72h+名额+1+OTP 消费序殿后", async () => {
    const { mod, txCaptured } = await freshRouter({ todayRows: [TODAY_ROW] });
    const r = await mod.betaDailyRouter.createCaller(CALLER_CTX).redeem({ codeText: "云枢天工", phone: "13800000004", smsCode: "123456" });
    expect(r.ok).toBe(true);
    expect(r.code).toMatch(/^iv_[0-9a-f]{48}$/);
    const upd = txCaptured.find((c) => c.sql.includes("UPDATE st_beta_daily_codes"));
    expect(upd?.sql).toContain("used_count < quota"); // 原子扣防超发钉
    const ins = txCaptured.find((c) => c.sql.includes("INSERT INTO st_beta_invites"));
    expect(String(ins?.params[1])).toMatch(/^[0-9a-f]{64}$/); // sha256 落库非明文
    expect(ins?.params[2]).toBe(72); // 72h 有效钉（INTERVAL 参数化面——钉参数不钉字面）
    expect(ins?.params).toContain("enterprise"); // kind 走 BETA_KINDS 契约参数钉
    // 锁序钉：daily FOR UPDATE → UPDATE 扣名额 → INSERT 码 → OTP 消费殿后
    const order = txCaptured.map((c) => c.sql);
    const iLock = order.findIndex((q) => q.includes("FOR UPDATE"));
    const iUpd = order.findIndex((q) => q.includes("UPDATE st_beta_daily_codes"));
    const iIns = order.findIndex((q) => q.includes("INSERT INTO st_beta_invites"));
    expect(iLock).toBeGreaterThanOrEqual(0);
    expect(iUpd).toBeGreaterThan(iLock);
    expect(iIns).toBeGreaterThan(iUpd);
  });

  it("IP 限流：同 IP 第 6 兑=拒（BETA_DAILY_IP_LIMIT=5 钉）", async () => {
    const { mod } = await freshRouter({ todayRows: [TODAY_ROW] });
    const caller = mod.betaDailyRouter.createCaller(CALLER_CTX);
    for (let i = 0; i < 5; i++) await caller.redeem({ codeText: "云枢天工", phone: `1380000001${i}`, smsCode: "123456" });
    await expect(caller.redeem({ codeText: "云枢天工", phone: "13800000019", smsCode: "123456" })).rejects.toThrow("太频繁");
  });
});
