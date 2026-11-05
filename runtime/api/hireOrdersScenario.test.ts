/**
 * v177 雇佣工单闭环 · 沙箱全链演练（SQL 层 mock，不连库不碰模型）。
 * 演练：派单→执行→交付→验收→结算 五段全走通 + 验收才结算 + 驳回返工。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let execQueue: unknown[] = [];
let execLog: string[] = [];

function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return String(q);
  return chunks
    .map((c) => {
      if (typeof c === "string") return c;
      const v = (c as { value?: unknown })?.value;
      return v === undefined ? "" : String(v);
    })
    .join(" ");
}

vi.mock("./queries/connection", () => ({
  getDb: () => ({ execute: async (q: unknown) => { const text = sqlText(q); execLog.push(text); if (text.includes("ops_ip_blocklist")) return [[]]; return execQueue.shift() ?? [[]]; } }),
}));
vi.mock("./routers/modelGateway", () => ({
  callSlotChatFast: async () => ({ ok: true, content: "交付物：本周巡检报告已完成，3 处隐患已列整改建议。", provider: "test", providerLabel: "t", latencyMs: 10 }),
}));
vi.mock("./routers/wbSession", () => ({
  sessionMe: async () => ({ user: { id: 9001 }, factory: { id: 6290209 } }),
}));
vi.mock("./routers/tokenLedger", () => ({
  debitForPurchase: async () => ({ balanceBefore: 1000, balanceAfter: 990 }),
  creditUser: async () => ({ balanceAfter: 55 }),
}));

import { hireOrdersRouter } from "./routers/hireOrders";

const caller = hireOrdersRouter.createCaller({} as never);

// 工单实况行进中变化：每次读 st_hire_orders 按队列给
beforeEach(() => { execQueue = []; execLog = []; });

describe("雇佣工单全链（沙箱）", () => {
  it("派单→执行→交付→验收→结算 一单到底", async () => {
    // dispatch: 合约实况 → 序号 → 主人 → 插入 →（executeOrder: 读单→置running→读员工→置delivered→读factory）→ 汇报×2
    execQueue = [
      [[{ id: 42, agentId: 7, enterpriseId: 6290209, status: "active" }]],  // 合约有效
      [[{ c: 0 }]],                                                        // 序号 1
      [[{ o: 8801 }]],                                                     // 分身主人 8801
      [{}],                                                                // 插入工单
      // executeOrder(no) fire-and-forget:
      [[{ id: 1, agent_id: 7, title: "巡检周报", brief: null, status: "dispatched" }]], // 读单
      [{}],                                                              // 置 running
      [[{ name: "小灵枢" }]],                                              // 读员工名
      [{}],                                                              // 置 delivered
      [[{ factory_id: 6290209 }]],                                         // 读 factory 发汇报
      [{}], [{}],                                                        // 两条汇报
    ];
    const d = await caller.dispatch({ token: "t", hireRecordId: 42, title: "巡检周报" });
    expect(d.ok).toBe(true);
    expect(d.orderNo).toBe("HO-42-001");
    // 等 fire-and-forget 执行完
    await new Promise((r) => setTimeout(r, 100));
    expect(execLog.some((t) => t.includes("status='running'"))).toBe(true);
    expect(execLog.some((t) => t.includes("status='delivered'"))).toBe(true);
    expect(execLog.some((t) => t.includes("交付物：本周巡检报告"))).toBe(true);

    // review accept: 读单(delivered) → 验收落库 → 结算 → 置 accepted → 汇报主人
    execQueue = [
      [[{ factory_id: 6290209, status: "delivered", hire_record_id: 42, owner_user_id: 8801, deliverable: "交付物内容" }]],
      [{}], // 验收单
      [{}], // 置 accepted
      [{}], // 主人汇报
    ];
    const r = await caller.review({ token: "t", orderNo: "HO-42-001", verdict: "accept" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.settled).toBeGreaterThan(0);
    // 验收确权落北极星事实源（task_ref=ho:HO-42-001）
    expect(execLog.some((t) => t.includes("st_delivery_acceptances") && t.includes("ho:HO-42-001"))).toBe(true);
    expect(execLog.some((t) => t.includes("token_settle"))).toBe(true);
  });

  it("不交付不验收：running 状态不可验收", async () => {
    execQueue = [[[{ factory_id: 6290209, status: "running", hire_record_id: 42, owner_user_id: null, deliverable: null }]]];
    await expect(caller.review({ token: "t", orderNo: "HO-42-001", verdict: "accept" })).rejects.toThrow("不可验收");
  });

  it("驳回→返工回原单号重派", async () => {
    // reject
    execQueue = [[[{ factory_id: 6290209, status: "delivered", hire_record_id: 42, owner_user_id: null, deliverable: "x" }]], [{}]];
    const rj = await caller.review({ token: "t", orderNo: "HO-42-001", verdict: "reject" });
    expect(rj.ok).toBe(true);
    // redispatch
    execQueue = [
      [[{ status: "rejected", factory_id: 6290209 }]],
      [{}], // 置回 dispatched + 清交付
      // executeOrder 重跑
      [[{ id: 1, agent_id: 7, title: "巡检周报", brief: null, status: "dispatched" }]],
      [{}],
      [[{ name: "小灵枢" }]],
      [{}],
      [[{ factory_id: 6290209 }]],
      [{}],
    ];
    const rd = await caller.redispatch({ token: "t", orderNo: "HO-42-001" });
    expect(rd.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(execLog.filter((t) => t.includes("status='delivered'")).length).toBeGreaterThan(0);
  });

  it("他厂工单不可见不可验（跨厂隔离）", async () => {
    execQueue = [[[{ factory_id: 999999, status: "delivered", hire_record_id: 42, owner_user_id: null, deliverable: "x" }]]];
    await expect(caller.review({ token: "t", orderNo: "HO-42-001", verdict: "accept" })).rejects.toThrow("不属于本厂");
  });
});
