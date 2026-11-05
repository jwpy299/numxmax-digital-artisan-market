/**
 * M45 Agent 支付闭环验收单测：
 * 1. maskAccount 脱敏（前3后4，短串兜底）。
 * 2. withdrawRequest：余额足 → pending；余额不足 → 拒；非负责人 → FORBIDDEN；<100 → zod 拒。
 * 3. withdrawReview：pending→approved 原子扣企业钱包+流水；approved→paid 须凭证；
 *    状态机外动作拒；驳回不扣钱。
 * 4. masterWallets / myWalletFlows / withdrawQueue 读取口径。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

// ─── 状态ful 假 DB ───────────────────────────────────────────────────────────
interface WithdrawalFake {
  id: number;
  ownerType: string;
  ownerId: number;
  amount: number;
  channel: string;
  accountMasked: string;
  status: string;
  requestedBy: string;
  reviewedBy: string | null;
  reviewNote: string | null;
  proof: string | null;
  createdAt: Date;
}
let withdrawals: WithdrawalFake[];
let enterpriseBalance: number;
let flows: Array<Record<string, unknown>>;
let wseq: number;
let wageDebits: Array<Record<string, unknown>>;

function sqlTextOf(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return String(q ?? "");
  return chunks
    .filter((c) => (c as { constructor?: { name?: string } })?.constructor?.name === "StringChunk")
    .map((c) => {
      const v = (c as { value?: unknown }).value;
      return Array.isArray(v) ? v.join("") : String(v ?? "");
    })
    .join("");
}
function sqlParamsOf(q: unknown): unknown[] {
  const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return [];
  const out: unknown[] = [];
  for (const c of chunks) {
    const isText = (c as { constructor?: { name?: string } })?.constructor?.name === "StringChunk";
    if (isText) continue;
    const rec = c as { value?: unknown };
    out.push(rec && typeof rec === "object" && "value" in rec ? rec.value : c);
  }
  return out;
}

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    execute: async (q: unknown) => {
      const t = sqlTextOf(q);
      const p = sqlParamsOf(q);
      if (/SELECT tokenBalance FROM enterprises/.test(t)) return [[{ tokenBalance: enterpriseBalance }]];
      if (/SELECT tokenBalance FROM masters/.test(t)) return [[{ tokenBalance: 0 }]];
      if (/INSERT INTO st_withdrawals/.test(t)) {
        const id = wseq++;
        // INSERT 列序：owner_type 为字面量 'enterprise'，参数从 owner_id 起
        withdrawals.push({
          id,
          ownerType: "enterprise",
          ownerId: Number(p[0]),
          amount: Number(p[1]),
          channel: String(p[2]),
          accountMasked: String(p[3]),
          status: "pending",
          requestedBy: String(p[4]),
          reviewedBy: null,
          reviewNote: null,
          proof: null,
          createdAt: new Date(),
        });
        return [{ insertId: id }];
      }
      if (/SELECT LAST_INSERT_ID/.test(t)) return [[{ id: wseq - 1 }]];
      if (/FROM st_withdrawals WHERE id/.test(t)) {
        const w = withdrawals.find((x) => x.id === Number(p[0]));
        return w ? [{ id: w.id, ownerType: w.ownerType, ownerId: w.ownerId, amount: w.amount, status: w.status }] : [];
      }
      if (/UPDATE st_withdrawals SET status = 'approved'/.test(t)) {
        const w = withdrawals.find((x) => x.id === Number(p[p.length - 1]) && x.status === "pending");
        if (w) { w.status = "approved"; w.reviewedBy = "admin"; }
        return [{ affectedRows: w ? 1 : 0 }];
      }
      if (/UPDATE st_withdrawals SET status = 'rejected'/.test(t)) {
        const w = withdrawals.find((x) => x.id === Number(p[p.length - 1]) && x.status === "pending");
        if (w) { w.status = "rejected"; }
        return [{ affectedRows: w ? 1 : 0 }];
      }
      if (/UPDATE st_withdrawals SET status = 'paid'/.test(t)) {
        const w = withdrawals.find((x) => x.id === Number(p[p.length - 2]) && x.status === "approved");
        if (w) { w.status = "paid"; w.proof = String(p[0]); }
        return [{ affectedRows: w ? 1 : 0 }];
      }
      if (/UPDATE enterprises SET tokenBalance = tokenBalance - /.test(t)) {
        const amount = Number(p[0]);
        const id = Number(p[1]);
        if (id === 10 && enterpriseBalance >= amount) {
          enterpriseBalance -= amount;
          return [{ affectedRows: 1 }];
        }
        return [{ affectedRows: 0 }];
      }
      if (/INSERT INTO st_wallet_flows/.test(t)) {
        // 列序：(owner_type, owner_id, direction, amount, balance_after, biz_type, ref_id, note)
        flows.push({ direction: p[2], amount: p[3], balanceAfter: p[4], bizType: p[5] });
        return [{ insertId: flows.length }];
      }
      if (/AS fOut/.test(t)) {
        // 只有包含工资台账的查询才按真实语义回包；旧查询会在这里得到 0，形成回归红灯。
        if (!/st_agent_wage_ledger/.test(t)) return [[{ fOut: 0, uIn: 0 }]];
        const flowSpend = flows.filter((f) => f.ownerType === 'enterprise' && f.ownerId === 10 && f.direction === 'out' && f.bizType !== 'agent_task_escrow_reserve').reduce((sum, f) => sum + Number(f.amount), 0);
        const wageSpend = wageDebits.filter((w) => w.factoryId === 10 && w.direction === 'debit' && w.walletOwnerType === 'enterprise' && w.walletOwnerId === 10).reduce((sum, w) => sum + Number(w.amount), 0);
        const userIncome = flows.filter((f) => f.ownerType === 'user' && f.ownerId === 1 && f.direction === 'in').reduce((sum, f) => sum + Number(f.amount), 0);
        return [[{ fOut: flowSpend + wageSpend, uIn: userIncome }]];
      }
      if (/FROM st_wallet_flows WHERE owner_type/.test(t)) return [flows.map((f, i) => ({ id: i + 1, ...f }))];
      if (/FROM masters m/.test(t)) return [[{ id: 1, name: "NumX Max 官方", title: "平台官方", tokenBalance: 0, credits: 0 }]];
      if (/FROM st_withdrawals ORDER BY/.test(t)) {
        return [withdrawals.map((w) => ({
          id: w.id, ownerType: w.ownerType, ownerId: w.ownerId, amount: w.amount, channel: w.channel,
          accountMasked: w.accountMasked, status: w.status, requestedBy: w.requestedBy,
          reviewNote: w.reviewNote, proof: w.proof, createdAt: w.createdAt,
        }))];
      }
      return [[]];
    },
  }),
}));

vi.mock("./routers/wbSession", () => ({
  sessionMe: async (token: string) => {
    if (token === "TEST_owner") return { user: { id: 1, username: "boss", role: "owner" }, factory: { id: 10 } };
    if (token === "TEST_staff") return { user: { id: 9, username: "staff", role: "member" }, factory: { id: 10 } };
    if (token === "TEST_admin") return { user: { id: 99, username: "platform", role: "admin" }, factory: { id: 0 } };
    throw new TRPCError({ code: "UNAUTHORIZED", message: "token 无效" });
  },
  normalizeRole: (r: string) => r,
}));

vi.mock("./routers/terminal", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/terminal")>();
  return {
    ...orig,
    requireAdmin: async (token: string) => {
      if (token !== "TEST_admin") throw new TRPCError({ code: "UNAUTHORIZED", message: "需要平台管理员" });
      return { id: 99, username: "platform", displayName: "平台运营" };
    },
    rawRows: (x: unknown) => (Array.isArray(x) && Array.isArray(x[0]) ? (x[0] as never) : (x as never)),
  };
});

vi.mock("./routers/adminAnalytics", () => ({
  writeAdminAudit: () => undefined,
  adminDisplayName: (a: { username?: string }) => String(a.username ?? "admin"),
}));

import { walletPayRouter, maskAccount } from "./routers/walletPay";

const caller = walletPayRouter.createCaller({} as never);

beforeEach(() => {
  withdrawals = [];
  flows = [];
  enterpriseBalance = 2000;
  wseq = 1;
  wageDebits = [];
});

describe("maskAccount 脱敏", () => {
  it("前3后4，中间打码；短串兜底", () => {
    expect(maskAccount("6222020200123456789")).toBe("622************6789");
    expect(maskAccount("12345")).toBe("12***");
  });
});

describe("withdrawRequest 提现申请", () => {
  it("余额足 → pending 落库，账号脱敏", async () => {
    const r = await caller.withdrawRequest({ token: "TEST_owner", amount: 500, channel: "ecny", account: "6222020200123456789" });
    expect(r.status).toBe("pending");
    expect(withdrawals[0]!.accountMasked).toBe("622************6789");
    expect(withdrawals[0]!.amount).toBe(500);
  });
  it("余额不足 → 拒；员工 → FORBIDDEN；低于 100 → zod 拒", async () => {
    await expect(caller.withdrawRequest({ token: "TEST_owner", amount: 5000, channel: "bank", account: "1234567" })).rejects.toThrowError(/余额不足/);
    await expect(caller.withdrawRequest({ token: "TEST_staff", amount: 500, channel: "bank", account: "1234567" })).rejects.toThrowError(/负责人/);
    await expect(caller.withdrawRequest({ token: "TEST_owner", amount: 50, channel: "bank", account: "1234567" })).rejects.toThrowError();
  });
});

describe("withdrawReview 复核状态机", () => {
  it("pending→approved 原子扣钱包+流水；approved→paid 须凭证；驳回不扣钱", async () => {
    await caller.withdrawRequest({ token: "TEST_owner", amount: 800, channel: "ecny", account: "6222020200123456789" });
    // 驳回一条新的（不扣钱）
    await caller.withdrawRequest({ token: "TEST_owner", amount: 200, channel: "bank", account: "12345678901" });
    const rej = await caller.withdrawReview({ token: "TEST_admin", id: 2, action: "rejected", note: "凭证不清" });
    expect(rej.status).toBe("rejected");
    expect(enterpriseBalance).toBe(2000);
    // 批准第一条：扣 800
    const ok = await caller.withdrawReview({ token: "TEST_admin", id: 1, action: "approved", note: "资料齐" });
    expect(ok.status).toBe("approved");
    expect(enterpriseBalance).toBe(1200);
    expect(flows.some((f) => f.bizType === "withdraw_debit" && f.amount === 800)).toBe(true);
    // paid 无凭证 → 拒；带凭证 → paid
    await expect(caller.withdrawReview({ token: "TEST_admin", id: 1, action: "paid" })).rejects.toThrowError(/凭证/);
    const paid = await caller.withdrawReview({ token: "TEST_admin", id: 1, action: "paid", proof: "回单号 ECNY-20260814-001" });
    expect(paid.status).toBe("paid");
    // 状态机外：再批准 → 拒
    await expect(caller.withdrawReview({ token: "TEST_admin", id: 1, action: "approved" })).rejects.toThrowError(/仅/);
  });
  it("余额不足时批准 → 拒（绝不透支出金）", async () => {
    enterpriseBalance = 100;
    await caller.withdrawRequest({ token: "TEST_owner", amount: 100, channel: "bank", account: "1234567" });
    // 申请时余额 100 够；批准前置 0 模拟被别的链路先花掉
    enterpriseBalance = 0;
    await expect(caller.withdrawReview({ token: "TEST_admin", id: 1, action: "approved" })).rejects.toThrowError(/余额已不足/);
    expect(withdrawals[0]!.status).toBe("pending");
  });
  it("非 admin → UNAUTHORIZED", async () => {
    await expect(caller.withdrawReview({ token: "TEST_owner", id: 1, action: "approved" })).rejects.toThrowError();
  });
});

describe("读取口径", () => {
  it("myWalletFlows / withdrawQueue / masterWallets", async () => {
    await caller.withdrawRequest({ token: "TEST_owner", amount: 300, channel: "ewallet", account: "13800138000" });
    await caller.withdrawReview({ token: "TEST_admin", id: 1, action: "approved" });
    const mine = await caller.myWalletFlows({ token: "TEST_owner" });
    expect(mine.balance).toBe(1700);
    expect(mine.flows[0]).toMatchObject({ bizType: "withdraw_debit" });
    const q = await caller.withdrawQueue({ token: "TEST_admin" });
    expect(q.items[0]).toMatchObject({ id: 1, status: "approved", accountMasked: "138****8000" });
    const mw = await caller.masterWallets({ token: "TEST_admin" });
    expect(mw.masters[0]).toMatchObject({ name: "NumX Max 官方" });
  });
});

describe("dualWallet 月度支出口径", () => {
  it("冻结不计支出，已验收工资 debit 计入，其他企业与 Agent credit 不混入", async () => {
    flows = [
      { ownerType: 'enterprise', ownerId: 10, direction: 'out', amount: 275, bizType: 'agent_task_escrow_reserve' },
      { ownerType: 'enterprise', ownerId: 10, direction: 'out', amount: 50, bizType: 'withdraw_debit' },
      { ownerType: 'enterprise', ownerId: 11, direction: 'out', amount: 900, bizType: 'withdraw_debit' },
      { ownerType: 'user', ownerId: 1, direction: 'in', amount: 25, bizType: 'sandbox_exchange' },
    ];
    wageDebits = [
      { factoryId: 10, direction: 'debit', walletOwnerType: 'enterprise', walletOwnerId: 10, amount: 175 },
      { factoryId: 11, direction: 'debit', walletOwnerType: 'enterprise', walletOwnerId: 11, amount: 900 },
      { factoryId: 10, direction: 'credit', walletOwnerType: 'agent', walletOwnerId: 1, amount: 500 },
    ];
    const result = await caller.dualWallet({ token: 'TEST_owner' });
    expect(result.factoryMonthSpend).toBe(225);
    expect(result.userMonthIncome).toBe(25);
  });
});
