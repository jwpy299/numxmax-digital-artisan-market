/**
 * requireAdmin 单源回归钉（批七-c R7-c23-③/F9）：rejected 语义——wb_users admin 行形状闸不过（disabled=1）
 *  硬 401 不落入委派/原生回退支（停用不给复活通道——旧支内即拒语义回归钉）；invalid 行照常走回退（口径不破）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

let rows: unknown[] = [];
let execLog: string[] = [];
let ledgerDown = false;
let staffRowsQ: unknown[] = []; // R7-c139-⑥：委派席夹具（id 轨钉用）

vi.mock("../queries/connection", async () => {
  const { MySqlDialect } = await import("drizzle-orm/mysql-core");
  const dialect = new MySqlDialect();
  return {
    getDb: () => ({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
      execute: async (stmt: unknown) => {
        if (ledgerDown) throw new Error("ledger down"); // R7-c31-⑥：infra 全链 500 钉用
        execLog.push(JSON.stringify(stmt)); // SQL 留痕（参数在对象内——断言支路触达与否）
        const s = JSON.stringify(stmt);
        if (s.includes("markerN")) return [[{ markerN: 1, totalN: 1, legacyN: 0 }], []]; // R7-c134-⑨：探针行（fail-loud 解包钉配套）
        if (s.includes("st_staff_accounts")) {
          // R7-c139-⑥：委派支夹具——双键谓词真模拟（参数=[token, ...键值]；id IN 数字键 OR username IN 字符串键）
          const q = dialect.sqlToQuery(stmt as never);
          const keys = (q.params as unknown[]).slice(1);
          const numKeys = keys.filter((k) => typeof k === "number").map(Number);
          const strKeys = keys.filter((k) => typeof k === "string").map(String);
          return [staffRowsQ.filter((r) => numKeys.includes(Number((r as Record<string, unknown>).id)) || strKeys.includes(String((r as Record<string, unknown>).username))), []];
        }
        return [[], []];
      },
    }),
  };
});

import { requireAdmin, collectDelegateBindings } from "./adminGate";

beforeEach(() => { rows = []; execLog = []; ledgerDown = false; staffRowsQ = []; process.env.ADMIN_DELEGATE_USERNAMES = "delegate_coo_test"; }); // R7-c25-①/R7-c35-④：名单 env 调用时读，测试显式配（夹具脱敏）
afterEach(() => { delete process.env.ADMIN_DELEGATE_USERNAMES; delete process.env.ADMIN_DELEGATE_IDS; }); // R7-c139-⑥：id 轨 env 同复位

describe("requireAdmin rejected 语义（R7-c23-③：「无此 token」与「admin 行被闸拒」分立）", () => {
  it("disabled=1 的 wb_users admin 行 → 硬 401；委派/原生回退支零查询（复活通道封死）", async () => {
    rows = [{ id: 1, username: "boss", role: "admin", passwordHash: "x", disabled: 1, factoryId: 1 }];
    await expect(requireAdmin("nt_dis")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const q = execLog.join("\n");
    expect(q).toContain("st_token_revocations"); // 吊销查验在前
    expect(q).not.toContain("st_staff_accounts"); // 委派支未触
    expect(q).not.toContain("st_admin_accounts"); // 原生支未触
  });

  it("非 admin 行（member）→ invalid 走回退：委派支照常查询（旧口径不破——requireAdmin 系 invalid→401 既有契约不动，R7-c99-② 分流支已回退）", async () => {
    rows = [{ id: 2, username: "m", role: "member", passwordHash: "x", disabled: 0, factoryId: 10 }];
    await expect(requireAdmin("nt_m")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(execLog.join("\n")).toContain("st_staff_accounts"); // 回退支正常触达
  });

  it("wb_users 无此行 → invalid 走回退（同上口径）", async () => {
    rows = [];
    await expect(requireAdmin("nt_none")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(execLog.join("\n")).toContain("st_staff_accounts");
  });

  it("台账 infra 失败 → 500 显因绝不折叠 401（R7-c31-⑥：requireAdmin 全链 500-never-folds-to-401 活性钉——死支的等价物，行在也白搭分派前判决先炸）", async () => {
    rows = [{ id: 1, username: "boss", role: "admin", passwordHash: "x", disabled: 0, factoryId: 1 }];
    ledgerDown = true;
    const err: unknown = await requireAdmin("nt_x").catch((e) => e);
    expect((err as { code: string }).code).toBe("INTERNAL_SERVER_ERROR");
  });
});

describe("collectDelegateBindings（R7-c136-②：委派归集单源钉——报告与闸同判决）", () => {
  it("分区+双轨缺员归集", async () => {
    const rows = [
      { id: 1, username: "coo_t", displayName: "COO", role: "head", disabled: 0, createdAt: "t" },
      { id: 2, username: "cmo_t", displayName: "CMO", role: "staff", disabled: 0, createdAt: "t" }, // role 非 head→不授予
      { id: 3, username: "cio_t", displayName: "CIO", role: "head", disabled: 1, createdAt: "t" }, // 停用→不授予
    ];
    const db = { execute: async () => [rows, []] };
    const r = await collectDelegateBindings(db as never, ["coo_t", "cmo_t", "ghost_t"], [1, 99]);
    expect(r.grants.map((x) => x.username)).toEqual(["coo_t"]);
    expect(r.nonGrants.map((x) => x.username)).toEqual(["cmo_t", "cio_t"]);
    expect(r.missingNames).toEqual(["ghost_t"]);
    expect(r.missingIds).toEqual([99]);
  });
});

describe("委派 id 轨（ADMIN_DELEGATE_IDS——R7-c139-⑥ test：P-DELEGATE-IDBIND 落地件钉）", () => {
  it("id 独中即授予（username 名单空）/同名异 id 不授予（删号重建面钉死）", async () => {
    rows = []; // wb 无行——落回退支
    delete process.env.ADMIN_DELEGATE_USERNAMES; // 纯 id 轨
    process.env.ADMIN_DELEGATE_IDS = "9";
    staffRowsQ = [{ id: 9, username: "coo_x", displayName: "COO", role: "head", disabled: 0 }];
    const ok = await requireAdmin("nt_delegate");
    expect(ok).toMatchObject({ id: 9, delegated: true }); // id 独中即授予
    // 同名异 id（删号重建）→ 不授予
    staffRowsQ = [{ id: 99, username: "coo_x", displayName: "COO", role: "head", disabled: 0 }];
    await expect(requireAdmin("nt_delegate2")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("非纯十进制/越界条目剔除+告警（静默缺员面钉）", async () => {
    rows = [];
    delete process.env.ADMIN_DELEGATE_USERNAMES;
    process.env.ADMIN_DELEGATE_IDS = "1e3,abc,9x"; // 全剔——通道整支关闭
    staffRowsQ = [{ id: 9, username: "coo_x", displayName: "COO", role: "head", disabled: 0 }];
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(requireAdmin("nt_delegate3")).rejects.toMatchObject({ code: "UNAUTHORIZED" }); // 名单全剔=委派通道关=401
      const warns = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warns).toContain("ADMIN_DELEGATE_IDS 条目被剔"); // 剔除可见（静默缺员面封死）
    } finally {
      spy.mockRestore();
    }
  });
});
