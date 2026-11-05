/**
 * 迭代 34 个人AI资产档案（wbProfile）测试（SQL 层 mock，不连库）。
 *
 * 断言：
 * 1. 无效 token → UNAUTHORIZED（sessionMe 拒绝）；
 * 2. 全新员工 myAssets → 空态正常（0 值 / 空数组 / 徽章未获得带进度提示）；
 * 3. 有数据员工 myAssets → 徽章规则触发（首任务/首收益等）+ 成长曲线 6 个月；
 * 4. profileCard 精简版：不含收入金额字段，含 hasIncome 布尔与徽章。
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

import { wbProfileRouter } from "./routers/wbProfile";

const caller = wbProfileRouter.createCaller({} as never);

const user = { id: 5, username: "u5", displayName: "小灵", role: "member", factoryId: 10 };
const factory = { id: 10, enterpriseName: "测试企业" };

beforeEach(() => {
  selectQueue = [];
  execQueue = [];
});

describe("wbProfile", () => {
  it("无效 token → UNAUTHORIZED", async () => {
    selectQueue.push([]); // sessionMe 查无用户
    await expect(caller.myAssets({ token: "nt_bad" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("全新员工 myAssets → 空态不报错，徽章未获得带提示", async () => {
    selectQueue.push([user], [factory]);
    const res = await caller.myAssets({ token: "nt_ok" });
    expect(res.abilityProfile.tasksDone).toBe(0);
    expect(res.abilityProfile.praiseRate).toBeNull();
    expect(res.income.accruedTotal).toBe(0);
    expect(res.creations).toEqual([]);
    expect(res.growth).toHaveLength(6);
    expect(res.badges).toHaveLength(6);
    expect(res.badges.every((b) => !b.earned)).toBe(true);
    expect(res.badges[0].hint).toContain("完成 1 个任务");
  });

  it("有数据员工 → 徽章触发 + 成长聚合", async () => {
    selectQueue.push([user], [factory]);
    const month = new Date().toISOString().slice(0, 7);
    execQueue.push(
      [[{ c: 12 }]], // tasksDone
      [[{ name: "工业制造", count: 12 }]], // categories
      [[{ name: "臻衡", tasks: 8 }]], // topAgents
      [[{ c: 2 }]], // hireCount
      [[{ total: 12, useful: 10 }]], // fbStat → praiseRate 83
      [[{ month, score: 4.5 }]], // fbMonthly
      [[{ month, tasks: 12 }]], // taskMonthly
      [[{ days7: 7 }]], // active 7d
      [[{ status: "accrued", amount: 30 }]], // incomeTotals
      [[{ id: 1, amount: 30, period: month, status: "accrued", created_at: null, pack_key: "SP-X", title: "包" }]], // incomeItems
      [[{ pack_key: "SP-X", title: "包", status: "listed", sales_count: 3, price_tokens: 100, listed_at: null }]], // creations
      [[{ c: 12 }]], // feedbackCount
    );
    const res = await caller.myAssets({ token: "nt_ok" });
    expect(res.abilityProfile.tasksDone).toBe(12);
    expect(res.abilityProfile.praiseRate).toBe(83);
    const earnedKeys = res.badges.filter((b) => b.earned).map((b) => b.key);
    expect(earnedKeys).toEqual(
      expect.arrayContaining(["first_task", "task_10", "first_listing", "first_income", "active_7d", "feedback_10"]),
    );
    const cur = res.growth.find((g) => g.month === month);
    expect(cur?.tasks).toBe(12);
    expect(cur?.score).toBe(4.5);
  });

  it("profileCard 精简版：hasIncome 布尔 + 徽章，不含金额字段", async () => {
    selectQueue.push([user], [factory]);
    execQueue.push(
      [[{ c: 1 }]], [[{ name: "工业制造", count: 1 }]], [[{ name: "臻衡", tasks: 1 }]],
      [[{ c: 1 }]], [[{ total: 0, useful: 0 }]], [[]], [[]], [[{ days7: 1 }]],
      [[{ status: "settled", amount: 20 }]], [[]], [[]], [[{ c: 0 }]],
    );
    const res = await caller.profileCard({ token: "nt_ok" });
    expect(res.hasIncome).toBe(true);
    expect(res.abilityTags).toEqual(["工业制造"]);
    expect(res.badges.find((b) => b.key === "first_income")?.earned).toBe(true);
    expect(JSON.stringify(res)).not.toContain("accruedTotal");
    expect(JSON.stringify(res)).not.toContain("settledTotal");
  });
});
