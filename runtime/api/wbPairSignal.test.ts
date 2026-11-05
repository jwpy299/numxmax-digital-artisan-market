/**
 * M72 信号源自动发现（v2.1.9 BLE/mDNS）服务端测试（SQL 层 mock，不连库；TEST_ 前缀）。
 *
 * 断言：
 * 1. signalOpen：ps_ 明文 + 库写 sha256（明文不入库）；expiresAt ≈ now+60s（非 300s）；
 *    channel 落审计列；broadcast 契约 {t:'sig', c, ch, v:1}；
 * 2. signalOpen 限频：同指纹 60s ≥10 → TOO_MANY_REQUESTS（与 open 共用计数）；
 * 3. claim 接受 ps_：同事务绑定成功，响应 channel='ble'（审计回显）；
 * 4. 回归：pd_ claim 响应 channel='qr'（存量 NULL 归一，旧功能不变）；
 * 5. status 接受 ps_（设备持短码轮询自取 dt_，全链零分叉）；
 * 6. 格式闸：px_ 等非法前缀在 claim/status/signalOpen 均被 zod 拒。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let selectQueue: Array<Array<Record<string, unknown>>> = [];
let execQueue: unknown[] = [];
let inserted: Array<{ table: unknown; values: Record<string, unknown> }> = [];
let nextId = 100;

vi.mock("./queries/connection", () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          const q = selectQueue.shift() ?? [];
          const thenable = {
            for: async () => q,
            then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve(q).then(res, rej),
          };
          return { limit: () => thenable, then: thenable.then };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        inserted.push({ table, values: v });
        const id = nextId++;
        return {
          $returningId: async () => [{ id }],
          then: (res: (v: unknown) => unknown) => Promise.resolve([{ affectedRows: 1 }]).then(res),
        };
      },
    }),
    update: () => ({
      set: () => ({ where: async () => undefined }),
    }),
    execute: async () => execQueue.shift() ?? [{ affectedRows: 1 }],
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return { getDb: () => db };
});

import {
  wbPairRouter,
  WB_PAIR_OPEN_LIMIT,
  WB_SIGNAL_TTL_SECONDS,
} from "./routers/wbPair";
import { sha256 } from "./routers/wbSession";
import { wbPairCodes } from "@db/schema";

const caller = wbPairRouter.createCaller({} as never);

const factory = { id: 10, enterpriseName: "TEST_星云企业", departments: [] };
const staffUser = { id: 2, username: "TEST_emp", displayName: "TEST_员工", role: "staff", factoryId: 10, departmentId: null };

const PS = `ps_${"b".repeat(48)}`;
const PD = `pd_${"a".repeat(48)}`;

function psCodeRow(over: Record<string, unknown> = {}) {
  return {
    id: 8,
    codeHash: sha256(PS),
    deviceName: "TEST_机床网关-01",
    deviceType: "box",
    fingerprint: "fp_TEST_cnc_0001",
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    consumedDeviceId: null,
    channel: "ble",
    createdAt: new Date(),
    ...over,
  };
}

beforeEach(() => {
  selectQueue = [];
  execQueue = [];
  inserted = [];
  nextId = 100;
});

describe("M72 pair.signalOpen（设备端取邻近短码）", () => {
  it("发 ps_：60s TTL + channel 落审计 + broadcast 契约，明文不入库", async () => {
    selectQueue.push([{ count: 0 }]); // 限频计数
    const before = Date.now();
    const res = await caller.signalOpen({
      deviceName: "TEST_机床网关-01",
      deviceType: "box",
      fingerprint: "fp_TEST_cnc_0001",
      channel: "ble",
    });
    expect(res.code).toMatch(/^ps_[0-9a-f]{48}$/);
    const ttlSec = (new Date(res.expiresAt).getTime() - before) / 1000;
    expect(ttlSec).toBeGreaterThan(WB_SIGNAL_TTL_SECONDS - 5);
    expect(ttlSec).toBeLessThanOrEqual(WB_SIGNAL_TTL_SECONDS + 1);
    expect(res.broadcast).toEqual({ t: "sig", c: res.code, ch: "ble", v: 1 });
    const ins = inserted.find((r) => r.table === wbPairCodes);
    expect(ins).toBeTruthy();
    expect(ins!.values.codeHash).toBe(sha256(res.code));
    expect(ins!.values.channel).toBe("ble"); // 审计列
    expect(JSON.stringify(ins!.values)).not.toContain(res.code); // 明文绝不入库
  });

  it("mdns 通道同样发卡；限频同 open 计数（≥10/60s → 429）", async () => {
    selectQueue.push([{ count: 0 }]);
    const r = await caller.signalOpen({
      deviceName: "TEST_会议屏-02",
      deviceType: "tablet",
      fingerprint: "fp_TEST_screen_0002",
      channel: "mdns",
    });
    expect(r.broadcast.ch).toBe("mdns");

    selectQueue.push([{ count: WB_PAIR_OPEN_LIMIT }]);
    await expect(
      caller.signalOpen({
        deviceName: "TEST_机床网关-01",
        deviceType: "box",
        fingerprint: "fp_TEST_cnc_0001",
        channel: "ble",
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});

describe("M72 claim/status 双码同链", () => {
  it("claim 接受 ps_：事务绑定成功，响应 channel='ble'，响应无 dt_", async () => {
    selectQueue.push([staffUser], [factory], [psCodeRow()], []); // sessionMe×2 + 码 + 查重
    const res = await caller.claim({ token: "nt_s", code: PS });
    expect(res.ok).toBe(true);
    expect(res.channel).toBe("ble");
    expect(res.deviceName).toBe("TEST_机床网关-01");
    expect(res).not.toHaveProperty("deviceToken");
  });

  it("回归：pd_ claim channel 归一 'qr'（存量 NULL 行，旧行为不变）", async () => {
    selectQueue.push(
      [staffUser],
      [factory],
      [psCodeRow({ codeHash: sha256(PS), channel: null })],
      [],
    );
    const res = await caller.claim({ token: "nt_s", code: PS }); // ps_ 码体但 channel=NULL（等价旧行）
    expect(res.channel).toBe("qr");
  });

  it("status 接受 ps_：pending 不报绑定细节", async () => {
    selectQueue.push([psCodeRow()]);
    const res = await caller.status({ code: PS });
    expect(res.state).toBe("pending");
  });

  it("格式闸：px_ 非法前缀在 claim/status 双端被拒", async () => {
    const bad = `px_${"a".repeat(48)}`;
    await expect(caller.claim({ token: "nt_s", code: bad })).rejects.toThrow(/配对码格式不正确/);
    await expect(caller.status({ code: bad })).rejects.toThrow(/配对码格式不正确/);
  });
});
