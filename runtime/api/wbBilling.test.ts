/**
 * 迭代 34 Token 充值（wbBilling）权限与流程测试（SQL 层 mock，不连库）。
 *
 * 方法：vi.mock("./queries/connection") 注入可编程假 db
 * （select→from→where→limit 与 execute 均按调用顺序出队）。
 *
 * 断言：
 * 1. 普通员工（role='member'）调 topupRequest → FORBIDDEN「仅企业主可发起 Token 充值」；
 * 2. amount<100 → zod BAD_REQUEST（不进入业务逻辑）；
 * 3. 企业主 topupRequest → ok + status pending + 合规文案（结算兑换通道未来开放）；
 * 4. 非 admin 调 billingConfirm → UNAUTHORIZED；
 * 5. admin billingConfirm 全流程 → confirmed（topup 非 pending → BAD_REQUEST 幂等保护）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let selectQueue: Array<Array<Record<string, unknown>>> = [];
let execQueue: unknown[] = [];

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => selectQueue.shift() ?? [],
        }),
      }),
    }),
    execute: async (stmt: unknown) => {
      if (JSON.stringify(stmt).includes("markerN")) return [[{ markerN: 1, totalN: 1, legacyN: 0 }]]; // R7-c134-⑨：探针行（mock 层统钉——fail-loud 解包配套，队列槽位不再逐测试数）
      return execQueue.shift() ?? [[]];
    },
  }),
}));

import { wbBillingRouter } from "./routers/wbBilling";

const caller = wbBillingRouter.createCaller({} as never);

const HQ_ID = 6290209;
process.env.HQ_FACTORY_IDS = String(HQ_ID);

const memberUser = { id: 2, username: "member1", displayName: "员工", role: "member", factoryId: 10 };
const ownerUser = { id: 1, username: "boss", displayName: "老板", role: "owner", factoryId: 10 };
const adminUser = { id: 9, username: "admin", displayName: "管理员", role: "admin", factoryId: HQ_ID, passwordHash: "x", disabled: 0 }; // 七-c 接线：绊线补齐
const neighborAdmin = { id: 11, username: "nb_admin", displayName: "邻厂管理员", role: "admin", factoryId: 6350239, passwordHash: "x", disabled: 0 }; // 七-c 接线：绊线补齐

beforeEach(() => {
  selectQueue = [];
  execQueue = [];
});

describe("wbBilling", () => {
  it("普通员工发起充值 → FORBIDDEN", async () => {
    selectQueue.push([memberUser]);
    await expect(
      caller.topupRequest({ token: "nt_member", amount: 500 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("amount<100 → zod BAD_REQUEST", async () => {
    await expect(
      caller.topupRequest({ token: "nt_x", amount: 50 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("企业主 topupRequest → pending + 合规文案", async () => {
    selectQueue.push([ownerUser]);
    execQueue.push([{ insertId: 7 }]); // INSERT st_token_topups
    const res = await caller.topupRequest({ token: "nt_owner", amount: 500 });
    expect(res.ok).toBe(true);
    expect(res.topupId).toBe(7);
    expect(res.status).toBe("pending");
    expect(res.priceCny).toBe(500);
    expect(res.notice).toContain("结算兑换通道未来开放");
  });

  it("非 admin 调 billingConfirm → UNAUTHORIZED", async () => {
    selectQueue.push([memberUser]);
    await expect(
      caller.billingConfirm({ token: "nt_member", topupId: 7 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("admin billingConfirm 全流程 → confirmed；重复确认 → BAD_REQUEST", async () => {
    selectQueue.push([adminUser]); // R7-c22 产线取行即探针（吊销上提+取行合一，单一 select）
    execQueue.push(
      [[]], // R7-c20 吊销首查（复用恒一次）
      [[{ id: 7, factory_id: 10, amount: 500, price_cny: 500, status: "pending" }]], // topup
      [[{ enterpriseName: "测试企业", industry: "机械制造" }]], // wb_factories
      [[]], // UPSERT enterprises.tokenBalance
      [[]], // UPDATE st_token_topups confirmed
      [[]], // st_admin_audit（fire-and-forget）
      [[]], // st_ops_tickets 联动
    );
    const res = await caller.billingConfirm({ token: "nt_admin", topupId: 7 });
    expect(res.status).toBe("confirmed");
    expect(res.amount).toBe(500);
    expect(res.notice).toContain("结算兑换通道未来开放");

    selectQueue.push([adminUser]); // R7-c22 产线取行即探针（吊销上提+取行合一，单一 select）
    execQueue.push(
      [[]], // R7-c20 吊销首查（复用恒一次）
      [[{ id: 7, factory_id: 10, amount: 500, price_cny: 500, status: "confirmed" }]],
    );
    await expect(
      caller.billingConfirm({ token: "nt_admin", topupId: 7 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("admin billingReject → rejected，不加余额", async () => {
    selectQueue.push([adminUser]); // R7-c22 产线取行即探针（吊销上提+取行合一，单一 select）
    execQueue.push(
      [[]], // R7-c20 吊销首查（复用恒一次）
      [[{ id: 8, factory_id: 10, amount: 100, status: "pending", remark: "" }]],
      [[]], // UPDATE rejected
      [[]], // audit
      [[]], // ticket
    );
    const res = await caller.billingReject({ token: "nt_admin", topupId: 8, reason: "凭证不符" });
    expect(res.status).toBe("rejected");
    expect(res.reason).toBe("凭证不符");
  });

  it("他厂 admin 调 billingList/billingConfirm/billingReject → UNAUTHORIZED（跨厂财务隔离）", async () => {
    selectQueue.push([neighborAdmin]); // R7-c22 产线取行即探针（吊销上提+取行合一，单一 select）
    await expect(caller.billingList({ token: "nt_nb" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    selectQueue.push([neighborAdmin]); // R7-c22 产线取行即探针（吊销上提+取行合一，单一 select）
    await expect(caller.billingConfirm({ token: "nt_nb", topupId: 7 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    selectQueue.push([neighborAdmin]); // R7-c22 产线取行即探针（吊销上提+取行合一，单一 select）
    await expect(
      caller.billingReject({ token: "nt_nb", topupId: 7, reason: "x" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("本厂 admin billingList 正常出队", async () => {
    selectQueue.push([adminUser]); // R7-c22 产线取行即探针（吊销上提+取行合一，单一 select）
    execQueue.push(
      [[]], // R7-c20 吊销首查（复用恒一次）
      [[{ id: 7, factory_id: 10, enterpriseName: "测试企业", amount: 500, price_cny: 500, status: "pending", remark: "", proof: null, confirmed_by: null, confirmed_at: null, created_at: null }]],
    );
    const res = await caller.billingList({ token: "nt_admin" });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].factoryId).toBe(10);
  });

  it("M43 costBreakdown：本厂近 7 日按日 × 按技能聚合，合计与明细自洽", async () => {
    selectQueue.push([ownerUser]); // requireOwnerToken
    execQueue.push(
      [[{ day: "2026-08-13", calls: 3, tokens: 300 }, { day: "2026-08-14", calls: 2, tokens: 200 }]],
      [[{ skillName: "文书起草", calls: 4, tokens: 400 }, { skillName: "经营分析", calls: 1, tokens: 100 }]],
    );
    const r = await caller.costBreakdown({ token: "nt_owner" });
    expect(r.days).toHaveLength(2);
    expect(r.skills[0]).toEqual({ skillName: "文书起草", calls: 4, tokens: 400 });
    expect(r.total7d.calls).toBe(5);
    expect(r.total7d.tokens).toBe(500);
    expect(r.total7d.avgTokensPerDay).toBe(71.4);
  });

  it("M43 costBreakdown：普通员工 → FORBIDDEN", async () => {
    selectQueue.push([memberUser]);
    await expect(caller.costBreakdown({ token: "nt_member" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
