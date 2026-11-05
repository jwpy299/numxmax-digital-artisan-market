/**
 * M22 F1 hire.create / hire.list 鉴权收口测试（SQL 层 mock，不连库；测试数据 TEST_ 前缀）。
 *
 * 断言矩阵：
 * 1. create 无 token 字段 → zod BAD_REQUEST；无效 token → UNAUTHORIZED（匿名持 enterpriseId 不可雇佣）；
 * 2. create staff 雇佣 → FORBIDDEN「仅老板可雇佣」（effectiveRoleOf 查 deptHeads 后仍 staff）；
 * 3. create manager 雇佣 → FORBIDDEN（不触达任何业务写）；
 * 4. create enterpriseId ≠ caller factory.id → FORBIDDEN（守卫先于业务查询，insert 未触达）；
 * 5. create admin（owner→admin 归一）正常雇佣回归：佣金 15%/85% 流水 + weeklyHires+1 + 返回记录；
 * 6. list 无效 token → UNAUTHORIZED；
 * 7. list enterpriseId 跨企业 → FORBIDDEN（不泄露存在性）；
 * 8. list staff 本企业正常返回（admin/manager/staff 不挑角色）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

let selectQueue: Row[][] = [];
let inserted: Row[] = [];
let updated: Row[] = [];
let nextId = 100;

vi.mock("./queries/connection", () => {
  const db = {
    select: () => {
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.leftJoin = () => chain;
      chain.where = () => chain;
      chain.orderBy = () => chain;
      chain.limit = () => chain;
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(selectQueue.shift() ?? []).then(res, rej);
      return chain;
    },
    insert: () => ({
      values: (v: Row) => {
        inserted.push(v);
        const id = nextId++;
        return { $returningId: async () => [{ id }] };
      },
    }),
    update: () => ({
      set: (v: Row) => {
        updated.push(v);
        return { where: async () => [{ affectedRows: 1 }] };
      },
    }),
    // M45：钱包 SQL 通道（debitForPurchase/creditMaster/流水）走裸 execute
    execute: async (q: unknown) => {
      const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks ?? [];
      const text = chunks
        .filter((c) => (c as { constructor?: { name?: string } })?.constructor?.name === "StringChunk")
        .map((c) => {
          const v = (c as { value?: unknown }).value;
          return Array.isArray(v) ? v.join("") : String(v ?? "");
        })
        .join("");
      const params: unknown[] = [];
      for (const c of chunks) {
        if ((c as { constructor?: { name?: string } })?.constructor?.name === "StringChunk") continue;
        const rec = c as { value?: unknown };
        params.push(rec && typeof rec === "object" && "value" in rec ? rec.value : c);
      }
      if (/SELECT tokenBalance FROM enterprises/.test(text)) return [[{ tokenBalance: walletState.ent }]];
      if (/SELECT tokenBalance FROM masters/.test(text)) return [[{ tokenBalance: walletState.master }]];
      if (/UPDATE enterprises SET tokenBalance = tokenBalance - /.test(text)) {
        const amt = Number(params[0]);
        if (walletState.ent < amt) return [{ affectedRows: 0 }];
        walletState.ent -= amt;
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE enterprises SET tokenBalance = tokenBalance \+ /.test(text)) {
        walletState.ent += Number(params[0]);
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE masters SET tokenBalance = tokenBalance \+ /.test(text)) {
        walletState.master += Number(params[0]);
        return [{ affectedRows: 1 }];
      }
      if (/INSERT INTO st_wallet_flows/.test(text)) {
        flows.push(params);
        return [{ insertId: flows.length }];
      }
      return [[]];
    },
    transaction: async (callback: (tx: never) => Promise<unknown>) => callback(db as never),
  };
  return { getDb: () => db };
});

/** M45 测试钱包状态（beforeEach 归位） */
const walletState = { ent: 20000, master: 0 }; // M45：余额须盖过测试雇佣价 12800
const flows: unknown[][] = [];

import { hireRouter } from "./routers/hire";

const caller = hireRouter.createCaller({} as never);

const factory = { id: 10, enterpriseName: "TEST_星云企业", departments: [] };
const ownerUser = { id: 1, username: "TEST_boss", displayName: "TEST_老板", role: "owner", factoryId: 10, departmentId: null };
const staffUser = { id: 2, username: "TEST_emp", displayName: "TEST_员工", role: "staff", factoryId: 10, departmentId: "sales" };
const managerUser = { id: 3, username: "TEST_mgr", displayName: "TEST_负责人", role: "manager", factoryId: 10, departmentId: "sales" };

const agentRow = {
  id: 7,
  name: "TEST_振衡",
  status: "active",
  monthlyPrice: 12800,
  weeklyHires: 3,
};
const enterpriseRow = { id: 10, name: "TEST_星云企业" };

/** sessionMe 两段 select（user → factory） */
function queueSession(user: Row, fac: Row = factory) {
  selectQueue.push([user], [fac]);
}

beforeEach(() => {
  selectQueue = [];
  inserted = [];
  walletState.ent = 20000;
  walletState.master = 0;
  flows.length = 0;
  updated = [];
  nextId = 100;
});

describe("M22 F1 hire.create（仅 admin 可雇佣）", () => {
  it("1. 无 token 字段 → BAD_REQUEST；无效 token → UNAUTHORIZED", async () => {
    await expect(
      caller.create({ agentId: 7, enterpriseId: 10, periodMonths: 6 } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    selectQueue.push([]); // token 查无此人
    await expect(
      caller.create({ token: "nt_bad", agentId: 7, enterpriseId: 10, periodMonths: 6 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(inserted).toHaveLength(0);
  });

  it("2. staff 雇佣 → FORBIDDEN「仅老板可雇佣」", async () => {
    queueSession(staffUser);
    selectQueue.push([]); // effectiveRoleOf：staff → wb_dept_heads 空
    await expect(
      caller.create({ token: "tok", agentId: 7, enterpriseId: 10, periodMonths: 6 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "仅老板可雇佣" });
    expect(inserted).toHaveLength(0);
  });

  it("3. manager 雇佣 → FORBIDDEN，不触达业务写", async () => {
    queueSession(managerUser);
    await expect(
      caller.create({ token: "tok", agentId: 7, enterpriseId: 10, periodMonths: 6 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "仅老板可雇佣" });
    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it("4. enterpriseId ≠ caller factory.id → FORBIDDEN（守卫先于业务查询）", async () => {
    queueSession(ownerUser);
    await expect(
      caller.create({ token: "tok", agentId: 7, enterpriseId: 20, periodMonths: 6 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(inserted).toHaveLength(0); // 未触达 insert
  });

  it("5. admin（owner→admin 归一）正常雇佣回归：15%/85% 佣金流水 + weeklyHires+1", async () => {
    queueSession(ownerUser);
    selectQueue.push([agentRow]); // Agent 查询
    selectQueue.push([enterpriseRow]); // 企业查询
    const hireRecord = {
      id: 100,
      agentId: 7,
      enterpriseId: 10,
      periodMonths: 6,
      monthlyPrice: 12800,
      status: "active",
      startedAt: new Date(),
      endsAt: new Date(),
    };
    const txRow = {
      id: 101,
      type: "hire_commission",
      amount: 12800,
      platformFee: 1920,
      masterShare: 10880,
      hireRecordId: 100,
    };
    selectQueue.push([hireRecord]); // 回读雇佣记录
    selectQueue.push([txRow]); // 回读佣金流水

    const r = await caller.create({ token: "tok", agentId: 7, enterpriseId: 10, periodMonths: 6 });
    expect(r.record).toMatchObject({ id: 100, status: "active", monthlyPrice: 12800 });
    expect(r.transaction).toMatchObject({ type: "hire_commission", platformFee: 1920, masterShare: 10880 });

    // 业务逻辑零改动：insert 顺序 = 雇佣记录 → 佣金流水；抽佣 15%
    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toMatchObject({ agentId: 7, enterpriseId: 10, periodMonths: 6, monthlyPrice: 12800, status: "active" });
    expect(inserted[1]).toMatchObject({
      type: "hire_commission",
      amount: 12800,
      platformFee: Math.round(12800 * 0.15),
      masterShare: 12800 - Math.round(12800 * 0.15),
      agentId: 7,
      enterpriseId: 10,
      hireRecordId: 100,
    });
    expect(updated).toHaveLength(1); // weeklyHires + 1
  });
});

describe("M22 F1 hire.list（本企业可见，不挑角色）", () => {
  it("6. 无效 token → UNAUTHORIZED", async () => {
    selectQueue.push([]); // token 查无此人
    await expect(caller.list({ token: "nt_bad", enterpriseId: 10 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("7. enterpriseId 跨企业 → FORBIDDEN（不泄露存在性）", async () => {
    queueSession(staffUser);
    await expect(caller.list({ token: "tok", enterpriseId: 20 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("8. staff 本企业正常返回雇佣记录（admin/manager/staff 均可）", async () => {
    queueSession(staffUser);
    selectQueue.push([
      {
        hire: { id: 42, agentId: 7, enterpriseId: 10, status: "active", monthlyPrice: 12800 },
        agent: { id: 7, name: "TEST_振衡" },
      },
    ]);
    const rows = await caller.list({ token: "tok", enterpriseId: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 42, agentId: 7, status: "active" });
    expect(rows[0]?.agent).toMatchObject({ name: "TEST_振衡" });
  });
});

describe("验收战役 P1：hire.cancel / hire.review 鉴权收口", () => {
  it("cancel 无 token 字段 → zod BAD_REQUEST（匿名不可解约）", async () => {
    await expect(caller.cancel({ hireRecordId: 55 } as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("cancel 他厂记录 → FORBIDDEN（本厂闸先于状态机）", async () => {
    queueSession(ownerUser);
    selectQueue.push([{ id: 55, agentId: 7, enterpriseId: 999, status: "active" }]);
    await expect(caller.cancel({ token: "tok", hireRecordId: 55 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("cancel 本厂 admin → cancelled 正常回归", async () => {
    queueSession(ownerUser);
    selectQueue.push([{ id: 55, agentId: 7, enterpriseId: 10, status: "active" }]);
    const res = await caller.cancel({ token: "tok", hireRecordId: 55 });
    expect(res.status).toBe("cancelled");
  });

  it("review 无 token 字段 → zod BAD_REQUEST（匿名不可刷评分）", async () => {
    await expect(
      caller.review({ hireRecordId: 55, rating: 5, content: "x" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("review 他厂记录 → FORBIDDEN（不可跨厂刷评分）", async () => {
    queueSession(staffUser);
    selectQueue.push([{ id: 55, agentId: 7, enterpriseId: 999, status: "active", startedAt: new Date() }]);
    await expect(
      caller.review({ token: "tok", hireRecordId: 55, rating: 1, content: "恶意低分" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("review 本厂成员 → 正常出评价 + 重算评分", async () => {
    queueSession(staffUser);
    selectQueue.push(
      [{ id: 55, agentId: 7, enterpriseId: 10, status: "active", startedAt: new Date(Date.now() - 40 * 86400_000) }], // record
      [{ avgRating: 4, ratingCount: 2 }], // recompute: agent
      [{ rating: 5 }, { rating: 4 }], // recompute: recent reviews
      [{ id: 100, agentId: 7, rating: 5, content: "靠谱" }], // 新建 review 回读
      [{ avgRating: 4.67, ratingCount: 3, delistRisk: false }], // agent 回读
    );
    const res = await caller.review({ token: "tok", hireRecordId: 55, rating: 5, content: "靠谱" });
    expect(res.review).toMatchObject({ id: 100, rating: 5 });
    expect(res.agent).toMatchObject({ ratingCount: 3, delistRisk: false });
  });
});
