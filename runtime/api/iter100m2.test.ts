/**
 * iter100 M2 验收单测（组织中枢·织网）：
 * 1. admin 平台根授权：admin 代提 B 级协议可出票执行（M2-3）。
 * 2. C 级两段式：admin 可 confirm（M2-3）；member 即使持链 confirm 仍被拒（铁律3不变）。
 * 3. 评审流白名单：非 active（draft/rejected/deprecated）协议提交意图 → 拒（M2-1）。
 * 4. device_rehearsal 执行器已注册并可走通 prepare→execute（M2-4）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let execQueue: unknown[] = [];

vi.mock("./queries/connection", () => ({
  getDb: () => {
    const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
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

import { submitIntent } from "./routers/gate";

const owner = { username: "boss", role: "owner", factoryId: 10 };
const admin = { username: "admin:ops", role: "admin", factoryId: 10 };
const member = { username: "worker", role: "member", factoryId: 10 };
const future = new Date(Date.now() + 60_000).toISOString();

beforeEach(() => {
  execQueue = [];
});

describe("M2-3：admin 平台根授权", () => {
  it("admin 代提 B 级协议 → 出票执行", async () => {
    execQueue = [
      [[]], // frozen check
      [[{ code: "device_rehearsal", name: "设备预演工单", level: "B", status: "active" }]],
      [[]], // insert intent
      [[{ id: 200 }]], // LAST_INSERT_ID
      // policyVote: admin 根授权，无查询
      [[{ lv: "B" }]], // constitutionVote: 本厂宪法 B
      [[]], // issueTicket insert
      [[{ id: 60 }]], // LAST_INSERT_ID
      [[{ id: 60, usedAt: null, expiresAt: future }]], // consumeTicket select
      [[]], // consumeTicket update
      // prepare: 校验 payload，无查询
      [[]], // wal prepare
      [[]], // execute: insert st_device_rehearsals
      [[{ id: 9 }]], // LAST_INSERT_ID
      [[]], // wal execute
      [[]], // wal commit
      [[]], // update intent executed
    ];
    const r = await submitIntent({
      actor: admin,
      actionType: "device_rehearsal",
      payload: { deviceName: "CNC-01", script: "空跑 10 分钟" },
    });
    expect(r.status).toBe("executed");
    expect(r.ticketId).toBe(60);
    expect((r.result as { rehearsalId: number }).rehearsalId).toBe(9);
    expect(r.votes?.policy).toMatch(/admin 平台授权/);
  });

  it("admin 代提 C 级协议 confirm=true → 允许确认并执行", async () => {
    execQueue = [
      [[]], // frozen
      [[{ code: "llm_limit_adjust", name: "限额调整", level: "C", status: "active" }]],
      [[]], // insert intent
      [[{ id: 201 }]],
      // policyVote admin 根授权
      // constitutionVote C → needConfirm，无查询
      [[]], // issueTicket
      [[{ id: 61 }]],
      [[{ id: 61, usedAt: null, expiresAt: future }]],
      [[]], // consume update
      [[{ lim: 1000 }]], // prepare: select plan
      [[]], // wal prepare
      [[]], // execute update plan
      [[]], // wal execute
      [[]], // wal commit
      [[]], // update intent
    ];
    const r = await submitIntent({
      actor: admin,
      actionType: "llm_limit_adjust",
      payload: { newLimit: 500 },
      confirm: true,
    });
    expect(r.status).toBe("executed");
    expect((r.result as { newLimit: number }).newLimit).toBe(500);
  });
});

describe("铁律3 回归：member 持链 confirm C 级仍被拒", () => {
  it("member confirm=true → FORBIDDEN", async () => {
    execQueue = [
      [[]], // frozen
      [[{ code: "llm_limit_adjust", name: "限额调整", level: "C", status: "active" }]],
      [[]], // insert intent
      [[{ id: 202 }]],
      [[{ scope: '["llm_limit_adjust"]' }]], // policyVote: member 持链命中
      [[]], // update intent rejected
    ];
    await expect(
      submitIntent({ actor: member, actionType: "llm_limit_adjust", payload: { newLimit: 500 }, confirm: true }),
    ).rejects.toThrow(/C 级协议确认必须由企业主/);
  });
});

describe("M2-1：评审流白名单（非 active 协议拒绝）", () => {
  it("draft 协议提交意图 → BAD_REQUEST", async () => {
    // loadProtocol SQL 带 status='active' 过滤 → draft 协议返回空行
    execQueue = [[[]], [[]]];
    await expect(
      submitIntent({ actor: owner, actionType: "device_rehearsal", payload: {} }),
    ).rejects.toThrow(/未知动作类型/);
  });
});

describe("M2-4：device_rehearsal 执行器", () => {
  it("缺 deviceName → prepare 抛错并回滚", async () => {
    execQueue = [
      [[]], // frozen
      [[{ code: "device_rehearsal", name: "设备预演工单", level: "B", status: "active" }]],
      [[]], // insert intent
      [[{ id: 203 }]],
      [[{ lv: "B" }]], // constitution B
      [[]], // issueTicket
      [[{ id: 62 }]],
      [[{ id: 62, usedAt: null, expiresAt: future }]],
      [[]], // consume update
      // prepare 抛错（无查询）
      [[]], // undo（cancel 无行，仍执行 update）
      [[]], // wal rollback
      [[]], // update intent failed
      [[]], // emitSignal insert
    ];
    await expect(
      submitIntent({ actor: owner, actionType: "device_rehearsal", payload: {} }),
    ).rejects.toThrow(/deviceName 必填/);
  });
});
