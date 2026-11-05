/**
 * iter100 M3 验收单测（中枢强化）：
 * 1. 公证节点：HMAC 签名/验签一致性与篡改检测。
 * 2. 宪法独立部署：CONSTITUTION_URL 指向不可达服务 → fail-safe 反对票 + D 级信号（铁律2）。
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
import { amendmentPayload, notarySign, notaryVerify } from "./constitutionNotary";

const owner = { username: "boss", role: "owner", factoryId: 10 };

beforeEach(() => {
  execQueue = [];
  delete process.env.CONSTITUTION_URL;
});

describe("M3-2：公证节点签名", () => {
  it("签名可验，篡改 payload 验签失败", () => {
    const p = amendmentPayload(7, 6320219, "A", "B", "boss");
    const sig = notarySign(p);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(notaryVerify(p, sig)).toBe(true);
    expect(notaryVerify(amendmentPayload(7, 6320219, "A", "A", "boss"), sig)).toBe(false);
    expect(notaryVerify(amendmentPayload(8, 6320219, "A", "B", "boss"), sig)).toBe(false);
  });
});

describe("M3-2：宪法服务独立部署 fail-safe", () => {
  it("CONSTITUTION_URL 不可达 → 反对票 + D 级信号（引擎宕机=反对）", async () => {
    process.env.CONSTITUTION_URL = "http://127.0.0.1:9/unreachable";
    execQueue = [
      [[]], // frozen check
      [[{ code: "device_rehearsal", name: "设备预演工单", level: "B", status: "active" }]],
      [[]], // insert intent
      [[{ id: 300 }]],
      // policyVote owner 根授权，无查询
      // constitutionVote: 远程 fetch 抛错 → catch → emitSignal(D) + 反对票
      [[]], // emitSignal insert
      [[]], // update intent rejected
    ];
    await expect(
      submitIntent({ actor: owner, actionType: "device_rehearsal", payload: { deviceName: "X" } }),
    ).rejects.toThrow(/宪法引擎拒签|fail-safe/);
  });
});
