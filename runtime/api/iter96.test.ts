/**
 * iter96 自主运行引擎（autoEngine）+ 适应度回写（fitnessUtil）测试（SQL 层 mock，不连库）。
 *
 * 方法同 iter92.test.ts：vi.mock("./queries/connection") 注入可编程假 db
 * （select→from→where→limit 与 execute 均按调用顺序出队）。
 *
 * 断言：
 * 1. constitutionSet 拒绝 C/D（zod 枚举，「C/D 级决策必须由人拍板」语义）；
 * 2. constitutionGet 无行 → 默认 'A'；
 * 3. runOnce 宪法分级：A→auto_done；B 但宪法仅 A→保持 open（needHuman）；C→pending_confirm；D→保持 open（needHuman）；
 * 4. runOnce 宪法 B 时 B 级→auto_done；
 * 5. confirm 仅 pending_confirm 可确认（open 拒绝）；
 * 6. getFactoryFitness 成功率 = successes/uses*100；
 * 7. recordFitness / emitSignal 库异常不 throw。
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
    execute: async () => {
      const next = execQueue.shift() ?? [[]];
      if (next instanceof Error) throw next;
      return next;
    },
  }),
}));

import { autoEngineRouter, emitSignal } from "./routers/autoEngine";
import { recordFitness, recordFeedback, getFactoryFitness } from "./routers/fitnessUtil";

const caller = autoEngineRouter.createCaller({} as never);

const ownerUser = { id: 1, username: "boss", displayName: "老板", role: "owner", factoryId: 10 };
const factory = { id: 10, enterpriseName: "测试企业A", industry: "工业制造", industryGroup: "工业制造" };

beforeEach(() => {
  selectQueue = [];
  execQueue = [];
});

describe("autoEngine.constitutionSet（宪法上限只能 A/B）", () => {
  it("拒绝 C/D 级（zod 枚举拦截）", async () => {
    await expect(
      caller.constitutionSet({ token: "nt_x", maxAutoLevel: "C" as never }),
    ).rejects.toThrow();
    await expect(
      caller.constitutionSet({ token: "nt_x", maxAutoLevel: "D" as never }),
    ).rejects.toThrow();
  });
  it("设为 B → upsert 落库", async () => {
    selectQueue.push([ownerUser], [factory]);
    const r = await caller.constitutionSet({ token: "nt_x", maxAutoLevel: "B" });
    expect(r).toEqual({ ok: true, maxAutoLevel: "B" });
  });
});

describe("autoEngine.constitutionGet", () => {
  it("无行 → 默认 A", async () => {
    selectQueue.push([ownerUser], [factory]);
    execQueue.push([[]]); // st_auto_constitution 无记录
    const r = await caller.constitutionGet({ token: "nt_x" });
    expect(r.maxAutoLevel).toBe("A");
  });
});

describe("autoEngine.runOnce（信号宪法分级处置）", () => {
  const openSignals = [
    [
      { id: 1, level: "A", title: "特训技能 采购跟单 毕业", detail: "已挂载军团" },
      { id: 2, level: "B", title: "告警提醒：llm_usage_80", detail: "用量 160/200" },
      { id: 3, level: "C", title: "套餐已欠费", detail: "建议续费" },
      { id: 4, level: "D", title: "退款申请", detail: "客户要求退款" },
    ],
  ];
  it("宪法 A：A→auto_done；B 保持 open；C→pending_confirm；D 保持 open", async () => {
    selectQueue.push([ownerUser], [factory]);
    execQueue.push(
      [[]], // constitution 无行 → A
      openSignals, // open 信号
      // 后续 UPDATE 均走默认 [[]]
    );
    const r = await caller.runOnce({ token: "nt_x" });
    expect(r).toEqual({ scanned: 4, autoDone: 1, pendingConfirm: 1, needHuman: 2 });
  });
  it("宪法 B：A+B 均 auto_done；C→pending_confirm；D 保持 open", async () => {
    selectQueue.push([ownerUser], [factory]);
    execQueue.push(
      [[{ maxAutoLevel: "B" }]],
      openSignals,
    );
    const r = await caller.runOnce({ token: "nt_x" });
    expect(r).toEqual({ scanned: 4, autoDone: 2, pendingConfirm: 1, needHuman: 1 });
  });
});

describe("autoEngine.confirm（仅 pending_confirm 可确认）", () => {
  it("open 信号 → BAD_REQUEST", async () => {
    selectQueue.push([ownerUser], [factory]);
    execQueue.push([[{ id: 3, status: "open" }]]);
    await expect(caller.confirm({ token: "nt_x", signalId: 3 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
  it("pending_confirm → resolved", async () => {
    selectQueue.push([ownerUser], [factory]);
    execQueue.push([[{ id: 3, status: "pending_confirm" }]], [[]]);
    const r = await caller.confirm({ token: "nt_x", signalId: 3 });
    expect(r).toEqual({ ok: true, signalId: 3, status: "resolved" });
  });
});

describe("fitnessUtil（适应度回写）", () => {
  it("getFactoryFitness 成功率 = successes/uses*100（0 次=0）", async () => {
    execQueue.push([
      [
        { skillKey: "purchase", uses: 10, successes: 9, thumbsUp: 2, thumbsDown: 1, lastAt: "2026-08-01 00:00:00" },
        { skillKey: "claw.dispatch", uses: 0, successes: 0, thumbsUp: 0, thumbsDown: 0, lastAt: null },
      ],
    ]);
    const rows = await getFactoryFitness(10);
    expect(rows[0]).toMatchObject({ skillKey: "purchase", uses: 10, successes: 9, successRate: 90 });
    expect(rows[1]).toMatchObject({ skillKey: "claw.dispatch", uses: 0, successRate: 0 });
  });
  it("recordFitness / recordFeedback / emitSignal 库异常不 throw", async () => {
    execQueue.push(new Error("db down"), new Error("db down"), new Error("db down"));
    await expect(recordFitness(10, "purchase", true)).resolves.toBeUndefined();
    await expect(recordFeedback(10, "purchase", false)).resolves.toBeUndefined();
    await expect(emitSignal(10, "alert", "B", "测试", null as never)).resolves.toBeUndefined();
  });
});
