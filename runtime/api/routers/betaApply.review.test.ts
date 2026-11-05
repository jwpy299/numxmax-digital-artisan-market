/**
 * betaApply.review 审批流写入面钉（portal#56 NumX 终判 critical 钉——严面闸+写入方没落 kind=锁死用户面封死）：
 * ① 批准面 INSERT INTO st_beta_invites 带 kind 列且值='enterprise'（审批流=企业报名面——放行的码企业码）；
 * ② kind 非 NULL=严面闸可过（verifyBetaCode 闸假设[kind 非 NULL]成立——写入面统一落 kind）；
 * ③ 驳回面不写 st_beta_invites（拒=不签码面）。
 * mock 面：connection（execute 捕获+transaction 直跑回调）+terminal（requireAdmin 桩）+smsYxt（sendSmsNotice 吞）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const dialect = new MySqlDialect();
let captured: { sql: string; params: unknown[] }[] = [];
let applicationRows: Array<Record<string, unknown>> = [];

vi.mock("../queries/connection", () => ({
  getDb: () => ({
    execute: async (stmt: unknown) => {
      const q = dialect.sqlToQuery(stmt as never);
      captured.push({ sql: q.sql, params: q.params as unknown[] });
      if (q.sql.includes("FROM st_beta_applications")) return [applicationRows, []];
      return [{ affectedRows: 1, insertId: 77 }, []];
    },
    transaction: async (fn: (tx: { execute: (s: unknown) => Promise<unknown> }) => Promise<unknown>) =>
      fn({
        execute: async (stmt: unknown) => {
          const q = dialect.sqlToQuery(stmt as never);
          captured.push({ sql: q.sql, params: q.params as unknown[] });
          return [{ affectedRows: 1, insertId: 77 }, []];
        },
      }),
  }),
}));

vi.mock("./terminal", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./terminal")>();
  return { ...orig, requireAdmin: async () => ({ username: "TEST_admin" }) }; // 保真件（rawRows 等）——只覆 requireAdmin 闸（全替换 mock 会把 rawRows 掏空=钉教训）
});

vi.mock("./smsYxt", () => ({
  sendSmsNotice: async () => true, // 短信通道吞（本钉不验发送面——钉写入面 kind）
}));

vi.mock("./betaInvites", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./betaInvites")>();
  const { getDb } = await import("../queries/connection");
  return {
    ...orig,
    withBetaInvitePhoneLock: vi.fn(async (_phone: string, fn: (tx: never) => Promise<unknown>) => getDb().transaction(fn as never)),
  };
});

import { betaApplyRouter } from "./betaApply";

describe("betaApply.review 审批流写入面（portal#56 NumX 终判 critical 钉）", () => {
  beforeEach(() => {
    captured = [];
    applicationRows = [{ id: 1, status: "pending", contact_name: "TEST_张", phone: "13800001111" }];
  });

  it("① 批准 → INSERT st_beta_invites 带 kind='enterprise'（审批流=企业报名面——写入面统一落 kind=闸假设成立）", async () => {
    const r = await betaApplyRouter.createCaller({} as never).review({ token: "TEST_tok", id: 1, approve: true });
    expect(r.ok).toBe(true);
    expect(r.approved).toBe(true);
    const ins = captured.find((c) => c.sql.includes("INSERT INTO st_beta_invites"));
    expect(ins).toBeTruthy();
    expect(ins!.sql).toContain("kind"); // kind 列在 INSERT 列清单
    expect(ins!.params).toContain("enterprise"); // 值=enterprise（契约参数绑定面——BETA_KINDS[1] 单源；D3 票后值在 params 非 SQL 内联）
    // 闸假设钉：kind 落=严面闸可过（verifyBetaCode 闸四形态已在 smsVerify.betaGate.test.ts 钉——此处钉写入面落 kind）
  });

  it("② 驳回 → 不写 st_beta_invites（拒=不签码面）", async () => {
    const r = await betaApplyRouter.createCaller({} as never).review({ token: "TEST_tok", id: 1, approve: false, reason: "TEST_资料不全" });
    expect(r.ok).toBe(true);
    expect(r.approved).toBe(false);
    expect(captured.some((c) => c.sql.includes("INSERT INTO st_beta_invites"))).toBe(false); // 无 INSERT
    expect(captured.some((c) => c.sql.includes("status='rejected'"))).toBe(true); // 驳回台账落
  });

  it("③ 已审过 → BAD_REQUEST（pending 守卫——重复批准重签码面封死）", async () => {
    applicationRows = [{ id: 1, status: "approved", contact_name: "TEST_张", phone: "13800001111" }];
    await expect(
      betaApplyRouter.createCaller({} as never).review({ token: "TEST_tok", id: 1, approve: true }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "该申请已审过" });
    expect(captured.some((c) => c.sql.includes("INSERT INTO st_beta_invites"))).toBe(false);
  });
});
