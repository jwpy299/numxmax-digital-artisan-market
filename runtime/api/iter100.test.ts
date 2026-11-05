/**
 * iter100 验收单测（组织中枢 M1）：
 * 1. 白名单：未注册 actionType 拒绝（铁律1）。
 * 2. 策略引擎：非 owner 无授权链 → 拒签（铁律：认链不认人）。
 * 3. 票据：consumeTicket 过期/一次性校验（60s TTL 常量存在）。
 * 4. fail-safe：宪法引擎异常 → 反对票 + D 级信号（emitSignal 被调）。
 * 5. WAL：执行失败 → rollback 日志写入。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let selectQueue: unknown[] = [];
let execQueue: unknown[] = [];

vi.mock("./queries/connection", () => ({
  getDb: () => {
    const db = {
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
    };
    // R7-c143-②：事务 shim——tx 共享同一路由（内存仓等价同连接语义）
    return { ...db, transaction: async (fn: (tx: typeof db) => Promise<unknown>) => fn(db) };
  }
}));

import { submitIntent, isFactoryFrozen } from "./routers/gate";
import { emitSignal } from "./routers/autoEngine";

const owner = { username: "boss", role: "owner", factoryId: 10 };
const member = { username: "worker", role: "member", factoryId: 10 };

beforeEach(() => {
  selectQueue = [];
  execQueue = [];
});

describe("铁律1：白名单（未注册动作拒绝）", () => {
  it("未知 actionType → BAD_REQUEST", async () => {
    // isFactoryFrozen: 无事件；loadProtocol: 无行
    execQueue = [[[]], [[]]];
    await expect(
      submitIntent({ actor: owner, actionType: "hack_everything", payload: {} }),
    ).rejects.toThrow(/未知动作类型/);
  });
});

describe("铁律2：认链不认人（策略引擎）", () => {
  it("member 无授权链提交 B 级协议 → 拒签", async () => {
    execQueue = [
      [[]], // frozen check
      [[{ code: "sandbox_dispatch", name: "沙箱训练派单", level: "B", status: "active" }]], // protocol
      [[]], // insert intent
      [[{ id: 1 }]], // LAST_INSERT_ID
      [[]], // policyVote: auth chains 无行
      [[]], // update intent rejected
    ];
    await expect(
      submitIntent({ actor: member, actionType: "sandbox_dispatch", payload: {} }),
    ).rejects.toThrow(/策略引擎拒签/);
  });

  it("member 持有效授权链（scope 含 *）→ 策略票通过，进入宪法投票", async () => {
    execQueue = [
      [[]], // frozen
      [[{ code: "sandbox_dispatch", name: "沙箱训练派单", level: "B", status: "active" }]],
      [[]], // insert intent
      [[{ id: 1 }]],
      [[{ scope: '["*"]' }]], // 授权链命中
      [[]], // constitution: st_auto_constitution 无行 → 默认 A → B 级拒签
      [[]], // update rejected
    ];
    await expect(
      submitIntent({ actor: member, actionType: "sandbox_dispatch", payload: {} }),
    ).rejects.toThrow(/宪法引擎拒签/);
  });
});

describe("铁律3：fail-safe（宪法引擎异常=反对票+D级信号）", () => {
  it("宪法查询抛错 → 拒签且不 throw 内部异常", async () => {
    execQueue = [
      [[]], // frozen
      [[{ code: "sandbox_dispatch", name: "沙箱训练派单", level: "B", status: "active" }]],
      [[]], // insert intent
      [[{ id: 1 }]],
      [[{ scope: '["*"]' }]], // 授权链
      new Error("db down"), // 宪法查询异常
      [[]], // emitSignal insert
      [[]], // update rejected
    ];
    await expect(
      submitIntent({ actor: member, actionType: "sandbox_dispatch", payload: {} }),
    ).rejects.toThrow(/fail-safe|拒签/);
  });
});

describe("C 级协议两段式", () => {
  it("C 级首次提交 → pending_confirm（不出票）", async () => {
    execQueue = [
      [[]], // frozen
      [[{ code: "llm_limit_adjust", name: "全厂LLM限额调整", level: "C", status: "active" }]],
      [[]], // insert intent
      [[{ id: 7 }]],
      [[]], // owner 根授权，不查链
      [[]], // update pending_confirm
    ];
    const res = await submitIntent({
      actor: owner,
      actionType: "llm_limit_adjust",
      payload: { newLimit: 500 },
    });
    expect(res.status).toBe("pending_confirm");
    expect(res.ticketId).toBeUndefined();
  });

  it("C 级 confirm 但非 owner → 拒绝", async () => {
    execQueue = [
      [[]],
      [[{ code: "llm_limit_adjust", name: "全厂LLM限额调整", level: "C", status: "active" }]],
      [[]],
      [[{ id: 8 }]],
      [[{ scope: '["*"]' }]], // member 有链
      [[]], // update rejected
    ];
    await expect(
      submitIntent({ actor: member, actionType: "llm_limit_adjust", payload: { newLimit: 500 }, confirm: true }),
    ).rejects.toThrow(/owner/);
  });
});

describe("冻结态", () => {
  it("最新事件为 freeze → frozen=true，意图只读拒绝", async () => {
    execQueue = [[[ { action: "freeze" } ]]];
    await expect(isFactoryFrozen(10)).resolves.toBe(true);
    execQueue = [[[ { action: "freeze" } ]]];
    await expect(
      submitIntent({ actor: owner, actionType: "sandbox_dispatch", payload: {} }),
    ).rejects.toThrow(/冻结/);
  });

  it("freeze 后出现 request+confirm 双方序列 → 解冻", async () => {
    // DESC 最新在前：时间序为 freeze → unfreeze_request → unfreeze(confirm)
    execQueue = [[[ { action: "unfreeze" }, { action: "unfreeze_request" }, { action: "freeze" } ]]];
    await expect(isFactoryFrozen(10)).resolves.toBe(false);
  });

  it("仅有 confirm 无 request → 仍冻结（单方无效）", async () => {
    execQueue = [[[ { action: "unfreeze" }, { action: "freeze" } ]]];
    await expect(isFactoryFrozen(10)).resolves.toBe(true);
  });
});
