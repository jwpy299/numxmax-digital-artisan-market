/**
 * admin.marketPending / marketApprove 本厂闸回归（SQL 层 mock，不连库）。
 *
 * 背景：验收战役 S9 侦察发现技能市场审核两 endpoint 原走裸 requireAdmin，
 * 他厂 admin 可看全平台待审队列并批准/驳回他厂上架单——与 wbBilling P1 同类
 * 跨厂越权。修复为 requireHqAdmin fail-closed。
 *
 * 断言：
 * 1. 本厂 admin marketPending → 正常出队；
 * 2. 本厂 admin marketApprove → listed；
 * 3. 他厂 admin marketPending / marketApprove → UNAUTHORIZED。
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

import { adminRouter } from "./routers/admin";

const caller = adminRouter.createCaller({} as never);

const HQ_ID = 6290209;
process.env.HQ_FACTORY_IDS = String(HQ_ID);

const hqAdmin = { id: 9, username: "admin", displayName: "管理员", role: "admin", factoryId: HQ_ID };
const neighborAdmin = { id: 11, username: "nb_admin", displayName: "邻厂管理员", role: "admin", factoryId: 6350239 };

beforeEach(() => {
  selectQueue = [];
  execQueue = [];
});

describe("admin 技能市场审核本厂闸", () => {
  it("本厂 admin marketPending → 正常出队", async () => {
    selectQueue.push([hqAdmin]);
    execQueue.push(
      [[]],
      [[]], // requireAdmin disabled 检查
      [[{ id: 5, skillKey: "test_skill", title: "测试技能", industry: "通用", description: null, sourceFactoryId: 6350239, sourceEnterpriseName: "TEST_验收邻厂", priceTokens: 10, status: "pending", createdAt: null }]],
    );
    const res = await caller.marketPending({ token: "nt_admin" });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].skillKey).toBe("test_skill");
  });

  it("本厂 admin marketApprove → listed", async () => {
    selectQueue.push([hqAdmin]);
    execQueue.push([[]], [[]], [[]]); // disabled 检查 + UPDATE
    const res = await caller.marketApprove({ token: "nt_admin", id: 5, approve: true });
    expect(res.status).toBe("listed");
  });

  it("他厂 admin marketPending / marketApprove → UNAUTHORIZED", async () => {
    selectQueue.push([neighborAdmin]);
    await expect(caller.marketPending({ token: "nt_nb" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    selectQueue.push([neighborAdmin]);
    await expect(caller.marketApprove({ token: "nt_nb", id: 5, approve: true })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
