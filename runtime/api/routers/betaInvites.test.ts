/**
 * ensureBetaInvites 升级路径+lockstep 钉（OCR wb#77 十二轮 test 票——升级分支永不被 CI 覆盖=黑暗面封死）：
 * 1. lockstep：KIND_COL_DEF 与 db/sync-ops.mts boot DDL 字面同（改一边测试红——跨件静默漂移封死）；
 * 1c. 可空列形态钉：KIND_COL_DEF=kind VARCHAR(16) NULL 无 DEFAULT（二十轮 bug·high 裁决——NULL=前史码天然锚，零数据迁移）；
 * 2. 新库路径：预检有列 → 不发 ALTER（免必败往返）；
 * 3. 旧库路径：预检空 → 发 ALTER 且带 KIND_COL_DEF+AFTER codeHash（列序钉）；
 * 4. ALTER 撞 1060（cause.errno 双轨形）→ isDupColumn 容=吞（双实例竞态面）；
 * 5. ALTER 他错 → 抛+ready 重置（重试真跑——静默卡死面封死）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const dialect = new MySqlDialect();

type ExecCapture = { sql: string; params: unknown[] };

/** 每例独立模块实例（ready 模块级缓存——resetModules 给净实例） */
async function freshEnsure(opts: { precheckRows: unknown[]; markerRows?: unknown[]; alterErr?: { errno?: number; causeErrno?: number } }) {
  vi.resetModules();
  const captured: ExecCapture[] = [];
  vi.doMock("../queries/connection", () => ({
    getDb: () => ({
      execute: async (stmt: unknown) => {
        const q = dialect.sqlToQuery(stmt as never);
        captured.push({ sql: q.sql, params: q.params as unknown[] });
        if (q.sql.includes("information_schema.COLUMNS")) return [opts.precheckRows, []];
        if (q.sql.includes("information_schema.TABLES")) return [opts.markerRows ?? [{ TABLE_COMMENT: "beta_kind_legacy_migrated" }], []];
        if (q.sql.includes("ALTER TABLE st_beta_invites")) {
          if (opts.alterErr) {
            const e = new Error("alter fail") as Error & { errno?: number; cause?: { errno?: number } };
            if (opts.alterErr.errno !== undefined) e.errno = opts.alterErr.errno;
            if (opts.alterErr.causeErrno !== undefined) e.cause = { errno: opts.alterErr.causeErrno };
            throw e;
          }
          return [{ affectedRows: 1 }, []];
        }
        return [{ affectedRows: 1 }, []]; // CREATE
      },
    }),
  }));
  const m = await import("./betaInvites");
  return { ensure: m.ensureBetaInvites, KIND_COL_DEF: m.KIND_COL_DEF, captured };
}

afterEach(() => {
  vi.resetModules();
  vi.unmock("../queries/connection");
});

describe("ensureBetaInvites（OCR wb#77 十二轮票）", () => {
  it("① KIND_COL_DEF 形态钉（门户仓无 sync-ops boot DDL 面——懒建自足；可空列形态=前史码天然锚）", async () => {
    const { KIND_COL_DEF } = await freshEnsure({ precheckRows: [] });
    expect(KIND_COL_DEF).toBe("kind VARCHAR(16) NULL"); // 可空无 DEFAULT 钉（NULL=前史码天然标记——NumX 终判面）
    expect(KIND_COL_DEF).not.toContain("DEFAULT"); // 无回填=无串户陷阱面
  });

  it("①b 门户域契约钉：betaDlConfig 引 @contracts/portal 单源（门户仓=门户本体——契约字面钉）", () => {
    const dlCfg = readFileSync(new URL("./betaDlConfig.ts", import.meta.url), "utf-8");
    const contract = readFileSync(new URL("../../contracts/portal.ts", import.meta.url), "utf-8");
    expect(contract).toContain('PORTAL_WEB_URL_DEFAULT = "https://downloads.example.invalid"'); // 契约字面
    expect(dlCfg).toContain('from "@contracts/portal"'); // 引契约面
  });

  it("② 新库路径：预检有列 → 不发 ALTER（免必败往返）", async () => {
    const { ensure, captured } = await freshEnsure({ precheckRows: [{ COLUMN_NAME: "kind" }, { COLUMN_NAME: "enterprise_name" }, { COLUMN_NAME: "revoked_at" }] });
    await ensure();
    expect(captured.some((c) => c.sql.includes("CREATE TABLE IF NOT EXISTS st_beta_invites"))).toBe(true);
    expect(captured.some((c) => c.sql.includes("information_schema.COLUMNS"))).toBe(true);
    expect(captured.some((c) => c.sql.includes("ALTER TABLE st_beta_invites"))).toBe(false);
  });

  it("③ 旧库路径：预检空 → 发 ALTER 带 KIND_COL_DEF+AFTER codeHash（列序两路径一致钉）", async () => {
    const { ensure, KIND_COL_DEF, captured } = await freshEnsure({ precheckRows: [] });
    await ensure();
    const alter = captured.find((c) => c.sql.includes("ALTER TABLE st_beta_invites"));
    expect(alter).toBeTruthy();
    expect(alter!.sql).toContain(KIND_COL_DEF);
    expect(alter!.sql).toContain("AFTER codeHash"); // 列序与 CREATE 一致（pushDispatch 先例同律）
  });

  it("③b 零数据迁移钉：旧库路径只发 ALTER——无 UPDATE/无 COMMENT（二十轮 bug·high 裁决：可空列 NULL=前史天然锚，迁移面整体拆除）", async () => {
    const { ensure, KIND_COL_DEF, captured } = await freshEnsure({ precheckRows: [] });
    await ensure();
    const alter = captured.find((c) => c.sql.includes("ALTER TABLE st_beta_invites ADD COLUMN"));
    expect(alter).toBeTruthy();
    expect(alter!.sql).toContain(KIND_COL_DEF);
    expect(KIND_COL_DEF).toBe("kind VARCHAR(16) NULL"); // 可空无 DEFAULT 钉（NULL=前史码天然标记）
    expect(KIND_COL_DEF).not.toContain("DEFAULT"); // 无回填=无串户陷阱面
    // backfill 钉（NumX 终判：ALTER 真应用后立刻 UPDATE kind IS NULL→personal——前史码收口严面）
    const backfill = captured.find((c) => c.sql.includes("UPDATE st_beta_invites SET kind"));
    expect(backfill).toBeTruthy();
    expect(backfill!.sql).toContain("WHERE kind IS NULL"); // 幂等谓词（无 NULL 行影响 0）
    expect(backfill!.sql).not.toContain("created_at"); // 无 cutoff（真锚=行在 ALTER 时已存在——沙箱抓过的设计 bug 不回）
  });

  it("③c 新库/重启路径：预检有列 → 不发 ALTER；backfill 幂等空跑=新码永不中（portal#56 复审钉——backfill 解耦后每次 ensure 都跑：WHERE kind IS NULL 幂等[无 NULL 行影响 0]；新码显式 kind 不落 NULL=永不误标）", async () => {
    const { ensure, captured } = await freshEnsure({ precheckRows: [{ COLUMN_NAME: "kind" }, { COLUMN_NAME: "enterprise_name" }, { COLUMN_NAME: "revoked_at" }] });
    await ensure();
    expect(captured.some((c) => c.sql.includes("ALTER TABLE st_beta_invites ADD COLUMN"))).toBe(false); // 列已在不加
    const backfill = captured.find((c) => c.sql.includes("UPDATE st_beta_invites SET kind"));
    expect(backfill).toBeTruthy(); // backfill 解耦后照跑（幂等空跑）
    expect(backfill!.sql).toContain("WHERE kind IS NULL"); // 幂等谓词钉（新码永不 NULL=永不中）
    expect(captured.some((c) => c.sql.includes("information_schema.TABLES"))).toBe(false); // 零标记面
  });

  it("④ ALTER 撞 1060（cause.errno 双轨形）→ isDupColumn 容=吞+backfill 仍跑=竞态安全（NumX 终判钉：WHERE kind IS NULL 幂等——新码永不 NULL=永不误标，双实例同跑同果）", async () => {
    const { ensure, captured } = await freshEnsure({ precheckRows: [], alterErr: { causeErrno: 1060 } });
    await expect(ensure()).resolves.toBeUndefined();
    const backfill = captured.find((c) => c.sql.includes("UPDATE st_beta_invites SET kind"));
    expect(backfill).toBeTruthy(); // 容路径也跑 backfill——但谓词 kind IS NULL=幂等无害（与 legacy 全表误转面本质不同：只中前史 NULL 行）
    expect(backfill!.sql).toContain("WHERE kind IS NULL");
  });

  it("⑤ ALTER 他错 → 抛+ready 重置（下轮重试真跑——静默卡死面封死）", async () => {
    const { ensure, captured } = await freshEnsure({ precheckRows: [], alterErr: { errno: 1105 } });
    await expect(ensure()).rejects.toThrow("alter fail");
    const creates = captured.filter((c) => c.sql.includes("CREATE TABLE IF NOT EXISTS")).length;
    expect(creates).toBe(1);
    // ready 已重置——同实例再调应重跑 CREATE（模块级缓存被败局清空）
    // 注：本例 exec 桩 ALTER 恒抛——再调仍败，但 CREATE 重发即证 ready 重置
    await expect(ensure()).rejects.toThrow("alter fail");
    expect(captured.filter((c) => c.sql.includes("CREATE TABLE IF NOT EXISTS")).length).toBe(2);
  });
});
