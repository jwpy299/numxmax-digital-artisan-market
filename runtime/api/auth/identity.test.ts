/**
 * 四层四锁·身份层产线测试（批七 R7-c12-⑤ test medium 收口）：authenticateAdmin 是唯一生产产证入口——
 *  DB 取行（mock 库层，同 revocation.test.ts 范式）+ mint 形状闸（role/disabled/passwordHash/factoryId）
 *  + MINTED 名册判决 + HQ 名单分工全链钉；武装窗运行期闸同钉（未开窗导出 mint 恒 null）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

let rows: unknown[] = [];
let revokedRows: unknown[] = [];
let ledgerDown = false;
let ledgerNoTable = false; // R7-c20-①：ER_NO_SUCH_TABLE 形态（errno 正本 1146——1149 是 ER_SYNTAX_ERROR）
let ledgerNoTableWrapped = false; // R7-c20-①：drizzle DrizzleQueryError 包装形态（code/errno 在 cause 链）

vi.mock("../queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows, // drizzle 链末 await 点（select→from→where→limit）
        }),
      }),
    }),
    execute: async (stmt: unknown) => { // R7-c14-②：isRevoked 台账查验（rawRows 元组形，同 revocation.test.ts 范式）
      if (ledgerNoTable) { const e = new Error("Table doesn't exist") as Error & { code: string; errno: number }; e.code = "ER_NO_SUCH_TABLE"; e.errno = 1146; throw e; } // errno 正本（R7-c20-①）
      if (JSON.stringify(stmt).includes("markerN")) return [[{ markerN: 1, totalN: 1, legacyN: 0 }], []]; // R7-c134-⑨：探针行（标记在场+台账非空——fail-loud 解包钉配套；1146/down 支先于本支=故障语义保持）
      if (ledgerNoTableWrapped) { const inner = { code: "ER_NO_SUCH_TABLE", errno: 1146 }; throw Object.assign(new Error("Failed query: SELECT id FROM st_token_revocations ..."), { cause: inner }); } // drizzle 包装形态
      if (ledgerDown) throw new Error("ledger down");
      return [revokedRows, []];
    },
  }),
}));

import { authenticateAdmin, assertNotRevoked, lockRoleOfWbUser, resolveRevocation, ADMIN_REQUIRED_MESSAGE, LEDGER_UNAVAILABLE_MESSAGE, REVOKED_DENIED_MESSAGE, type RevocationVerdict } from "./identity";
import { __asResolvedAdminIdentityForTest as asResolvedAdminIdentity } from "./identityTestHook"; // 哨兵口径：mint 面只经钩引

const adminRow = { id: 1, username: "boss", role: "admin", passwordHash: "x", disabled: false, factoryId: 1 };

beforeEach(() => { rows = []; revokedRows = []; ledgerDown = false; ledgerNoTable = false; ledgerNoTableWrapped = false; });

describe("authenticateAdmin（唯一生产产证入口）", () => {
  it("合法 admin token → 非空证据；HQ 名单内判 boss、名单外判 admin", async () => {
    rows = [adminRow];
    const r = await authenticateAdmin("nt_ok");
    expect(r.ok).toBe(true);
    if (!r.ok) return; // 类型收窄（判别联合）
    expect(lockRoleOfWbUser(r.evidence, [1])).toBe("boss");
    expect(lockRoleOfWbUser(r.evidence, [2])).toBe("admin");
    expect(lockRoleOfWbUser(r.evidence, [])).toBe("admin");
  });

  it("token 未命中（空行集）→ invalid（401 语义）", async () => {
    rows = [];
    expect(await authenticateAdmin("nt_miss")).toEqual({ ok: false, reason: "invalid", rowFound: false }); // R7-c74-⑥：无此行=死会话子态（401 语义）
  });

  it("形状闸逐条钉：disabled 双形态 / 空 passwordHash / 非 admin / factoryId 非数值 → null", async () => {
    rows = [{ ...adminRow, disabled: 1 }]; // raw SQL TINYINT 数字 1 形态
    expect(await authenticateAdmin("nt_dis")).toEqual({ ok: false, reason: "rejected" }); // R7-c23-③：admin 行形状闸不过=rejected（硬 401 不落回退支）
    rows = [{ ...adminRow, disabled: true }]; // drizzle boolean 形态
    expect(await authenticateAdmin("nt_dis2")).toEqual({ ok: false, reason: "rejected" }); // R7-c23-③：admin 行形状闸不过=rejected（硬 401 不落回退支）
    rows = [{ ...adminRow, passwordHash: "" }];
    expect(await authenticateAdmin("nt_nohash")).toEqual({ ok: false, reason: "rejected" }); // R7-c23-③：admin 行形状闸不过=rejected（硬 401 不落回退支）
    rows = [{ ...adminRow, role: "staff" }];
    expect(await authenticateAdmin("nt_staff")).toEqual({ ok: false, reason: "invalid", rowFound: true }); // R7-c74-⑥：活行非 admin（403 留页语义）
    rows = [{ ...adminRow, factoryId: "1" }]; // 运行期漂移：非数值厂号
    expect(await authenticateAdmin("nt_fid")).toEqual({ ok: false, reason: "rejected" }); // R7-c23-③：admin 行形状闸不过=rejected（硬 401 不落回退支）
  });

  it("吊销台账命中 → revoked（R7-c14-②：吊销 token 不铸证，账本不惰性）", async () => {
    rows = [adminRow];
    revokedRows = [{ id: 1 }];
    expect(await authenticateAdmin("nt_revoked")).toEqual({ ok: false, reason: "revoked" });
  });

  it("台账查验失败 → ledger_unavailable（R7-c18-①：infra 失败与吊销/无效三态分立——绝不折叠 401 清会话）", async () => {
    rows = [adminRow];
    ledgerDown = true;
    expect(await authenticateAdmin("nt_x")).toEqual({ ok: false, reason: "ledger_unavailable" });
  });
});

describe("武装窗运行期闸（R7-c10-②/R7-c12-②）", () => {
  it("导出 mint 未开窗恒 null——伪造字面量产证通道运行期拆除", () => {
    expect(asResolvedAdminIdentity(adminRow as never)).toBeNull();
  });

  it("authenticateAdmin 产证不经武装窗（生产路径不被误闸）", async () => {
    rows = [adminRow];
    const r = await authenticateAdmin("nt_ok");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(lockRoleOfWbUser(r.evidence, [1])).toBe("boss");
  });
});

describe("assertNotRevoked 吊销判决统一出口（R7-c19-①/R7-c22-①：三支凭证分派前统一查验，verdict 双验回退真查）", () => {
  it("未吊销 → 放行（resolve）", async () => {
    rows = [adminRow];
    await expect(assertNotRevoked("nt_ok")).resolves.toBeUndefined();
  });

  it("确已吊销 → UNAUTHORIZED（401 合理——确证拒绝，非 infra）", async () => {
    revokedRows = [{ id: 1 }];
    const err: unknown = await assertNotRevoked("nt_revoked").catch((e) => e);
    expect((err as { code: string }).code).toBe("UNAUTHORIZED");
  });

  it("infra 失败 → INTERNAL_SERVER_ERROR 且话术不触 isWbAuthError 正则（不清会话=M65 口径）", async () => {
    ledgerDown = true;
    const err: unknown = await assertNotRevoked("nt_x").catch((e) => e);
    expect((err as { code: string }).code).toBe("INTERNAL_SERVER_ERROR");
    expect(LEDGER_UNAVAILABLE_MESSAGE).not.toMatch(/token 无效|未登录|已失效/);
  });

  it("ER_NO_SUCH_TABLE + opt-in 旗在场 → 降级放行（无吊销可存，绝不 500——pre-migration 容忍口径）", async () => {
    process.env.REVOCATION_TABLE_OPTIONAL = "1"; // R7-c53-③：缺表降级改显式 opt-in——测试显式配旗
    ledgerNoTable = true;
    await expect(assertNotRevoked("nt_ok")).resolves.toBeUndefined();
    delete process.env.REVOCATION_TABLE_OPTIONAL;
  });

  it("drizzle 包装形态（DrizzleQueryError，code/errno 在 cause 链）+ opt-in 旗 → 同样降级——顶层直读生产恒 false 的回归钉", async () => {
    process.env.REVOCATION_TABLE_OPTIONAL = "1";
    ledgerNoTableWrapped = true;
    await expect(assertNotRevoked("nt_ok")).resolves.toBeUndefined();
    delete process.env.REVOCATION_TABLE_OPTIONAL;
  });

  it("ER_NO_SUCH_TABLE 无 opt-in 旗 → ledger_unavailable 500（R7-c53-③：已迁移环境 fail-closed——表曾被建后被删/错路由不再静默放行已吊销凭证）", async () => {
    delete process.env.REVOCATION_TABLE_OPTIONAL;
    ledgerNoTable = true;
    expect(await authenticateAdmin("nt_ok2")).toEqual({ ok: false, reason: "ledger_unavailable" });
  });
});

describe("吊销判别品牌结果（R7-c21-③：forgeable string 参数面封口）", () => {
  it("伪造判别对象（字面量 as 渗透）不被采信——回退真查，吊销命中仍拒（fail-closed 不放行）", async () => {
    rows = [adminRow];
    revokedRows = [{ id: 1 }];
    const forged = { state: "ok" } as unknown as RevocationVerdict; // 伪造 "ok" 试图跳过查验——品牌键验不过
    const r = await authenticateAdmin("nt_revoked", forged);
    expect(r).toEqual({ ok: false, reason: "revoked" }); // 真查兜底：吊销仍被拦
  });

  it("未吊销时伪造判别对象回退真查照常产证（行为不差于缺省路径）", async () => {
    rows = [adminRow];
    const forged = { state: "revoked" } as unknown as RevocationVerdict; // 伪造 "revoked" 也不能用来拒人——回退真查
    const r = await authenticateAdmin("nt_ok", forged);
    expect(r.ok).toBe(true);
  });
});

describe("判别结果指纹绑定（R7-c22-①：跨 token 复用=fail-open 钉死）", () => {
  it("A 的判别结果喂给 B → 指纹不符回退真查（B 已吊销仍拒，A 未吊销不能替 B 开脱）", async () => {
    rows = [adminRow];
    revokedRows = []; // A 未吊销
    const verdictA = await resolveRevocation("nt_a");
    revokedRows = [{ id: 1 }]; // B 实际已吊销
    await expect(assertNotRevoked("nt_b", verdictA)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("话术常量不变式（R7-c46-②：普通 401 与吊销 401 语义分立——今同值是有意，改其一者须过本钉）", () => {
  it("REVOKED_DENIED 与 ADMIN_REQUIRED 今同值（isWbAuthError 正则两话术皆不触）", () => {
    expect(ADMIN_REQUIRED_MESSAGE).toBe(REVOKED_DENIED_MESSAGE); // 分立≠分字面值——语义通道分立是意图
    expect(REVOKED_DENIED_MESSAGE).not.toMatch(/token 无效|未登录|已失效/); // 钉：不误触清会话正则
    expect(ADMIN_REQUIRED_MESSAGE).not.toMatch(/token 无效|未登录|已失效/);
  });
});
