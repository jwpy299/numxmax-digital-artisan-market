/**
 * admin.intentSignals 直测（portal#43 R2 票③）：意图信号只读面两路径钉死——
 * ① happy path：三读并行返回聚合+流+总数；② 表缺失/查询异常 → 空面回落（不炸面板）。
 * SQL 层 mock（不连库）；鉴权面 mock 本厂 admin。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let execQueue: Array<unknown> = [];
let execShouldThrow = false;

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: 9, username: "admin", role: "admin" }], // requireAdmin 面：本厂 admin 通过
        }),
      }),
    }),
    execute: async () => {
      if (execShouldThrow) throw new Error("table wb_intent_signals doesn't exist");
      return execQueue.shift() ?? [[]];
    },
  }),
}));

import { adminRouter } from "./routers/admin";

const caller = adminRouter.createCaller({} as never);

beforeEach(() => {
  execQueue = [];
  execShouldThrow = false;
});

describe("admin.intentSignals（意图信号只读面）", () => {
  it("① happy path：聚合+流+总数（三读并行）", async () => {
    execQueue = [
      [[]], // ipBlockGuard：空 IP 也核验封锁名单（空结果）
      [[{ disabled: 0 }]], // requireAdmin 的 disabled 复查（队列首位垫——鉴权面先消费）
      [[{ kind: "spirit_intent", action: "open_todos", cnt: 5, fails: 0, avgMs: 320 }]], // agg
      [[{ id: 1, actor: "老板", kind: "spirit_intent", action: "open_todos", ok: 1, latencyMs: 320, detail: "待办中心", createdAt: "2026-10-05 10:00:00" }]], // feed
      [[{ total: 5 }]], // total
    ];
    const r = await caller.intentSignals({ token: "nt_test" });
    expect(r.total24h).toBe(5);
    expect(r.agg).toHaveLength(1);
    expect(r.agg[0].action).toBe("open_todos");
    expect(r.feed).toHaveLength(1);
  });

  it("② 表缺失/查询异常 → 空面回落（不炸面板）", async () => {
    execShouldThrow = true;
    const r = await caller.intentSignals({ token: "nt_test" });
    expect(r).toEqual({ agg: [], feed: [], total24h: 0 });
  });
});
