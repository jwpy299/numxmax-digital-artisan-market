/**
 * approvals 统一审批中心权限测试（SQL 层 mock，不连库）。
 *
 * 背景：验收战役发现 inbox/decide 原走裸 requireAdmin，收件箱聚合全厂待办（含他厂
 * 充值单），他厂 admin 可跨厂探知/处置——P1 跨厂隔离缺口。修复为 requireHqAdmin
 * 本厂闸 fail-closed。
 *
 * 断言：
 * 1. 本厂 admin inbox → 正常聚合出队；
 * 2. 他厂 admin inbox → UNAUTHORIZED；
 * 3. 他厂 admin decide(topup) → UNAUTHORIZED（不触达 confirmTopup）；
 * 4. 非 admin decide → UNAUTHORIZED。
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
    execute: async () => execQueue.shift() ?? [[]],
  }),
}));

import { approvalsRouter } from "./routers/approvals";

const caller = approvalsRouter.createCaller({} as never);

const HQ_ID = 6290209;
process.env.HQ_FACTORY_IDS = String(HQ_ID);

const hqAdmin = { id: 9, username: "admin", displayName: "管理员", role: "admin", factoryId: HQ_ID };
const neighborAdmin = { id: 11, username: "nb_admin", displayName: "邻厂管理员", role: "admin", factoryId: 6350239 };
const memberUser = { id: 2, username: "member1", displayName: "员工", role: "member", factoryId: 10 };

beforeEach(() => {
  selectQueue = [];
  execQueue = [];
});

describe("approvals 跨厂隔离", () => {
  it("本厂 admin inbox → 正常聚合（claw + topup 两路）", async () => {
    selectQueue.push([hqAdmin]);
    execQueue.push(
      [[]],
      [[]], // requireAdmin disabled 检查
      [[]], // st_claw_operations pending
      [[{ id: 7, factoryId: 10, enterpriseName: "测试企业", amount: 500, priceCny: 500, remark: "", createdAt: "2026-08-23 10:00:00" }]],
    );
    const res = await caller.inbox({ token: "nt_admin" });
    expect(res.counts.topup).toBe(1);
    expect(res.items[0].kind).toBe("topup");
  });

  it("他厂 admin inbox → UNAUTHORIZED", async () => {
    selectQueue.push([neighborAdmin]);
    await expect(caller.inbox({ token: "nt_nb" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("他厂 admin decide(topup) → UNAUTHORIZED", async () => {
    selectQueue.push([neighborAdmin]);
    await expect(
      caller.decide({ token: "nt_nb", kind: "topup", refId: "7", action: "approve" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("非 admin decide → UNAUTHORIZED", async () => {
    selectQueue.push([memberUser]);
    await expect(
      caller.decide({ token: "nt_member", kind: "claw", refId: "OP-1", action: "approve" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
