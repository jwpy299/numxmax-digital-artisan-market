/**
 * M17 扫码绑设备（wbPair）测试（SQL 层 mock，不连库；测试数据 TEST_ 前缀）。
 *
 * 断言（设计 §7 测试矩阵 1-12）：
 * 1. open：pd_ 明文 + 库写 sha256（64 hex，明文不入库）；expiresAt ≈ now+300s；
 * 2. status：pending 无 token；claimed 首拉返回 dt_ 明文并原子置 tokenPulledAt；二次拉取不返回；过期/不存在 → expired；
 * 3. claim 成功：事务内消费 + 建设备（factoryId=用户企业、claimedBy 正确、tokenHash=sha256）；
 * 4. claim 并发消费：原子 UPDATE 影响行=0 → CONFLICT，败方无设备插入；
 * 5. 过期/不存在/已消费码 → 统一 BAD_REQUEST('配对码无效或已过期')；
 * 6. 重放：同码二次 claim → BAD_REQUEST；
 * 7. 跨企业：B 企业用户 claim 已消费码被拒；revoke 他企业 deviceId → NOT_FOUND；
 * 8. staff token 可 claim（设计内）；无效 token → UNAUTHORIZED；
 * 9. fingerprint 重复绑定 → CONFLICT；已 revoke 设备同 fingerprint 可重绑；
 * 10. list：staff → FORBIDDEN；manager/admin 通过；输出不含 tokenHash；online 判定（90s 边界）；
 * 11. revoke 幂等：重复 revoke → ok:true；staff/manager → FORBIDDEN；解绑后 heartbeat → UNAUTHORIZED；
 * 12. heartbeat：有效 dt_ 更新 lastSeenAt；revoked/未 pulled/错误 token → UNAUTHORIZED；token 只在 body。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let selectQueue: Array<Array<Record<string, unknown>>> = [];
let execQueue: unknown[] = [];
let executed: unknown[] = []; // db.execute 收到的 SQL 对象（断言 lazy 清理 DELETE）
let inserted: Array<{ table: unknown; values: Record<string, unknown> }> = [];
let updated: Array<Record<string, unknown>> = [];
let nextId = 100;

vi.mock("./queries/connection", () => {
  // tx 与 db 同形：事务回调直接复用同一 mock（回滚语义由"败方无写入断言"覆盖）
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          const q = selectQueue.shift() ?? [];
          const thenable = {
            // F2：mock 无真实行锁，for("update") 仅透传队列结果（锁语义由实现层 SQL 保证）
            for: async () => q,
            then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve(q).then(res, rej),
          };
          return {
            limit: () => thenable, // limit 后可继续链 .for("update")，也可直接 await
            then: thenable.then,
          };
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
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          updated.push(v);
        },
      }),
    }),
    execute: async (q: unknown) => {
      executed.push(q);
      return execQueue.shift() ?? [{ affectedRows: 1 }];
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return { getDb: () => db };
});

import { wbPairRouter, WB_PAIR_OPEN_LIMIT, WB_PAIR_TTL_SECONDS } from "./routers/wbPair";
import { sha256 } from "./routers/wbSession";
import { wbDevices, wbPairCodes } from "@db/schema";

const caller = wbPairRouter.createCaller({} as never);

const factory = {
  id: 10,
  enterpriseName: "TEST_星云企业",
  departments: [{ id: "sales", name: "销售部" }],
};
const factoryB = { id: 20, enterpriseName: "TEST_隔壁企业", departments: [] };
const adminUser = { id: 1, username: "TEST_boss", displayName: "TEST_老板", role: "owner", factoryId: 10, departmentId: null };
const staffUser = { id: 2, username: "TEST_emp", displayName: "TEST_员工", role: "staff", factoryId: 10, departmentId: "sales" };
const managerUser = { id: 3, username: "TEST_mgr", displayName: "TEST_负责人", role: "manager", factoryId: 10, departmentId: "sales" };
const otherFactoryUser = { id: 9, username: "TEST_out", displayName: "TEST_外人", role: "admin", factoryId: 20, departmentId: null };

const future = () => new Date(Date.now() + 300_000);
const past = () => new Date(Date.now() - 3600_000);
const PD = `pd_${"a".repeat(48)}`;

function codeRow(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    codeHash: sha256(PD),
    deviceName: "TEST_车间平板-03",
    deviceType: "tablet",
    fingerprint: "fp_TEST_device_0001",
    expiresAt: future(),
    consumedAt: null,
    consumedDeviceId: null, // F1 链接列：claim 事务内回写；未消费/旧数据为 NULL
    createdAt: new Date(),
    ...over,
  };
}

function deviceRow(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    factoryId: 10,
    name: "TEST_车间平板-03",
    deviceType: "tablet",
    fingerprint: "fp_TEST_device_0001",
    tokenHash: "h".repeat(64),
    claimedBy: 1,
    tokenPulledAt: new Date(),
    lastSeenAt: null,
    revokedAt: null,
    createdAt: new Date(),
    ...over,
  };
}

beforeEach(() => {
  selectQueue = [];
  execQueue = [];
  executed = [];
  inserted = [];
  updated = [];
  nextId = 100;
});

/** drizzle sql`` 模板对象 → 纯文本（仅含静态片段，占位符不展开） */
function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: Array<{ value?: unknown }> } | undefined)?.queryChunks ?? [];
  return chunks.map((c) => (Array.isArray(c?.value) ? (c.value as unknown[]).join("") : "")).join("");
}

describe("pair.open（公开）", () => {
  it("生成 pd_ 明文 + qrPayload，库写 sha256（不含明文），expiresAt ≈ now+300s", async () => {
    const res = await caller.open({
      deviceName: "TEST_车间平板-03",
      deviceType: "tablet",
      fingerprint: "fp_TEST_device_0001",
    });
    expect(res.code).toMatch(/^pd_[0-9a-f]{48}$/);
    expect(res.qrPayload).toEqual({ t: "pair", c: res.code, v: 1 });
    expect(new Date(res.expiresAt).getTime()).toBeGreaterThan(
      Date.now() + (WB_PAIR_TTL_SECONDS - 10) * 1000,
    );
    const ins = inserted.find((r) => r.table === wbPairCodes);
    expect(ins).toBeTruthy();
    expect(ins!.values.codeHash).toBe(sha256(res.code));
    expect(String(ins!.values.codeHash)).toHaveLength(64);
    expect(JSON.stringify(ins!.values)).not.toContain(res.code); // 明文绝不落库
    expect(ins!.values.deviceType).toBe("tablet");
  });

  it("限频：同指纹 60s 内已有 10 个码 → TOO_MANY_REQUESTS「操作太频繁，请稍后再试」，不落新码", async () => {
    selectQueue.push([{ count: WB_PAIR_OPEN_LIMIT }]); // count(*) 命中上限
    await expect(
      caller.open({ deviceName: "TEST_刷码机", deviceType: "box", fingerprint: "fp_TEST_spam_0001" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: "操作太频繁，请稍后再试" });
    expect(inserted.find((r) => r.table === wbPairCodes)).toBeUndefined();
  });

  it("限频不误伤：窗口内 9 个码（未达上限）/ 窗口外历史码（count=0）均正常开码", async () => {
    selectQueue.push([{ count: WB_PAIR_OPEN_LIMIT - 1 }]);
    const r1 = await caller.open({
      deviceName: "TEST_正常设备",
      deviceType: "desktop",
      fingerprint: "fp_TEST_normal_01",
    });
    expect(r1.code).toMatch(/^pd_[0-9a-f]{48}$/);
    // 窗口外历史码不计入（WHERE createdAt >= now-60s，mock 返回 0）
    selectQueue.push([{ count: 0 }]);
    const r2 = await caller.open({
      deviceName: "TEST_正常设备",
      deviceType: "desktop",
      fingerprint: "fp_TEST_normal_01",
    });
    expect(r2.code).toMatch(/^pd_[0-9a-f]{48}$/);
    expect(inserted.filter((r) => r.table === wbPairCodes)).toHaveLength(2);
  });

  it("lazy 清理：open 顺带 DELETE 全表过期码（expiresAt < NOW()），随后才限频计数与插码", async () => {
    selectQueue.push([{ count: 0 }]);
    await caller.open({ deviceName: "TEST_平板", deviceType: "tablet", fingerprint: "fp_TEST_clean_01" });
    expect(executed.length).toBeGreaterThanOrEqual(1);
    const text = sqlText(executed[0]);
    expect(text).toContain("DELETE FROM wb_pair_codes");
    expect(text).toContain("expiresAt < NOW()");
  });
});

describe("pair.status（公开轮询）", () => {
  it("pending → 无 token；claimed 首拉返回 dt_ 明文并原子置位；二次拉取不再返回；过期/不存在 → expired", async () => {
    // pending：未消费未过期，绝不带 token
    selectQueue.push([codeRow()]);
    const pending = await caller.status({ code: PD });
    expect(pending.state).toBe("pending");
    expect(pending).not.toHaveProperty("deviceToken");

    // claimed 且 tokenPulledAt IS NULL → 返回 dt_ 明文一次 + 原子置位
    selectQueue.push(
      [codeRow({ consumedAt: past(), consumedDeviceId: "42" })],
      [deviceRow({ tokenPulledAt: null })],
      [factory],
    );
    const first = await caller.status({ code: PD });
    expect(first).toMatchObject({
      state: "claimed",
      deviceId: 42,
      deviceName: "TEST_车间平板-03",
      factoryName: "TEST_星云企业",
    });
    expect("deviceToken" in first && first.deviceToken).toMatch(/^dt_[0-9a-f]{48}$/);

    // 二次拉取：tokenPulledAt 已置 → 只报告事实，绝不重发明文
    selectQueue.push([codeRow({ consumedAt: past(), consumedDeviceId: "42" })], [deviceRow()], [factory]);
    const second = await caller.status({ code: PD });
    expect(second.state).toBe("claimed");
    expect(second).not.toHaveProperty("deviceToken");

    // 并发轮询败方：原子 UPDATE 影响行=0 → 不返回明文
    selectQueue.push(
      [codeRow({ consumedAt: past(), consumedDeviceId: "42" })],
      [deviceRow({ tokenPulledAt: null })],
      [factory],
    );
    execQueue.push([{ affectedRows: 0 }]);
    const loser = await caller.status({ code: PD });
    expect(loser.state).toBe("claimed");
    expect(loser).not.toHaveProperty("deviceToken");

    // 过期（未消费）→ expired；不存在 → expired（不泄露码存在性）
    selectQueue.push([codeRow({ expiresAt: past() })]);
    expect((await caller.status({ code: PD })).state).toBe("expired");
    selectQueue.push([]);
    expect((await caller.status({ code: PD })).state).toBe("expired");
  });

  it("F1 时序：码A claim→设备 revoke→同指纹重绑新设备→旧码A status 不得返回新设备 dt_（expired 统一口径）", async () => {
    // 旧码A 已消费、链接列指向旧设备 42；旧设备已 revoke（WHERE id=42 AND revokedAt IS NULL 查空）。
    // 即使同指纹已有重绑新设备，status 只按 consumedDeviceId 精确找 → 绝不误领新设备 dt_
    selectQueue.push([codeRow({ consumedAt: past(), consumedDeviceId: "42" })], []);
    const st = await caller.status({ code: PD });
    expect(st.state).toBe("expired");
    expect(st).not.toHaveProperty("deviceToken");

    // 旧数据（链接列 NULL 的已消费码）→ 只报告 claimed 事实，绝不发 token
    selectQueue.push([codeRow({ consumedAt: past() })]);
    const legacy = await caller.status({ code: PD });
    expect(legacy.state).toBe("claimed");
    expect(legacy).not.toHaveProperty("deviceToken");
  });
});

describe("pair.claim（需登录，不挑角色）", () => {
  it("成功：事务内原子消费 + 建设备（factoryId=用户企业、claimedBy 正确、tokenHash=sha256 不含明文），响应无 dt_", async () => {
    selectQueue.push([adminUser], [factory], [codeRow()], []);
    const res = await caller.claim({ token: "nt_a", code: PD });
    expect(res).toEqual({
      ok: true,
      deviceId: 100,
      deviceName: "TEST_车间平板-03",
      deviceType: "tablet",
      enterpriseName: "TEST_星云企业",
      channel: "qr", // M72：存量扫码码 channel=NULL → 归一 'qr'
    });
    expect(res).not.toHaveProperty("deviceToken"); // App 不持设备凭证
    const ins = inserted.find((r) => r.table === wbDevices);
    expect(ins).toBeTruthy();
    expect(ins!.values.factoryId).toBe(10);
    expect(ins!.values.claimedBy).toBe(1);
    expect(ins!.values.name).toBe("TEST_车间平板-03");
    expect(String(ins!.values.tokenHash)).toHaveLength(64);
    expect(String(ins!.values.tokenHash)).not.toContain("dt_"); // 明文绝不落库
  });

  it("并发消费：原子 UPDATE 影响行=0 → CONFLICT，败方无设备插入", async () => {
    selectQueue.push([adminUser], [factory], [codeRow()]);
    execQueue.push([{ affectedRows: 0 }]);
    await expect(caller.claim({ token: "nt_a", code: PD })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(inserted.find((r) => r.table === wbDevices)).toBeUndefined();
  });

  it("过期 / 不存在 / 已消费码 → 统一 BAD_REQUEST('配对码无效或已过期')，不泄露细节", async () => {
    for (const rows of [
      [],
      [codeRow({ expiresAt: past() })],
      [codeRow({ consumedAt: past() })],
    ]) {
      selectQueue = [];
      selectQueue.push([adminUser], [factory], rows as Array<Record<string, unknown>>);
      await expect(caller.claim({ token: "nt_a", code: PD })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "配对码无效或已过期",
      });
    }
  });

  it("重放：同码二次 claim → BAD_REQUEST（已 consumed）；跨企业：B 企业用户 claim 已消费码同口径被拒", async () => {
    selectQueue.push([adminUser], [factory], [codeRow({ consumedAt: past() })]);
    await expect(caller.claim({ token: "nt_a", code: PD })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    selectQueue.push([otherFactoryUser], [factoryB], [codeRow({ consumedAt: past() })]);
    await expect(caller.claim({ token: "nt_b", code: PD })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("staff token 可 claim（设计内）；无效 token → UNAUTHORIZED", async () => {
    selectQueue.push([staffUser], [factory], [codeRow()], []);
    const res = await caller.claim({ token: "nt_s", code: PD });
    expect(res.ok).toBe(true);
    expect(inserted.find((r) => r.table === wbDevices)!.values.claimedBy).toBe(2);

    selectQueue.push([]); // sessionMe 查无用户
    await expect(caller.claim({ token: "nt_bad", code: PD })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("fingerprint 重复绑定 → CONFLICT；已 revoke 设备同 fingerprint 可重绑", async () => {
    // 在册同指纹 → CONFLICT，且不插入设备
    selectQueue.push([adminUser], [factory], [codeRow()], [deviceRow()]);
    await expect(caller.claim({ token: "nt_a", code: PD })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "该设备已绑定，请先解绑",
    });
    expect(inserted.find((r) => r.table === wbDevices)).toBeUndefined();

    // 同指纹但旧设备已解绑（WHERE revokedAt IS NULL 查空）→ 允许重绑
    selectQueue = [];
    inserted = [];
    selectQueue.push([adminUser], [factory], [codeRow()], []);
    const res = await caller.claim({ token: "nt_a", code: PD });
    expect(res.ok).toBe(true);
    expect(inserted.find((r) => r.table === wbDevices)).toBeTruthy();
    // F1：同事务回写码→设备链接列 consumedDeviceId=新设备 id
    expect(updated.some((v) => v.consumedDeviceId === String(res.deviceId))).toBe(true);
  });

  it("F2 并发：双 claim 同 fingerprint，FOR UPDATE 序列化后后进入者读到在册设备 → 其一 CONFLICT，仅一台落库", async () => {
    // claim1（码A）：消费成功 + 同指纹查空 → 建设备 id=100（同事务回写 consumedDeviceId）
    selectQueue.push([adminUser], [factory], [codeRow()], []);
    const r1 = await caller.claim({ token: "nt_a", code: PD });
    expect(r1.ok).toBe(true);
    expect(updated.some((v) => v.consumedDeviceId === "100")).toBe(true);
    // claim2（另一码B，同指纹）：真实库中 FOR UPDATE 等 claim1 提交后读到其设备（mock 层模拟该读结果）
    selectQueue.push([adminUser], [factory], [codeRow({ id: 8 })], [deviceRow({ id: 100 })]);
    await expect(
      caller.claim({ token: "nt_a", code: `pd_${"b".repeat(48)}` }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "该设备已绑定，请先解绑" });
    expect(inserted.filter((r) => r.table === wbDevices)).toHaveLength(1); // 双并发仅一台落库
  });
});

describe("pair.list（admin/manager）", () => {
  it("staff → FORBIDDEN；manager/admin 通过；输出不含 tokenHash；online 判定 90s 边界", async () => {
    // staff（非部门负责人）→ FORBIDDEN
    selectQueue.push([staffUser], [factory], []);
    await expect(caller.list({ token: "nt_s" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // manager 通过：online（30s 前心跳）/ offline（120s 前）/ revoked 三态
    selectQueue.push(
      [managerUser],
      [factory],
      [
        deviceRow({ id: 43, lastSeenAt: new Date(Date.now() - 30_000) }),
        deviceRow({ id: 44, lastSeenAt: new Date(Date.now() - 120_000) }),
        deviceRow({ id: 45, revokedAt: past() }),
      ],
      [{ id: 1, displayName: "TEST_老板" }],
    );
    const rows = await caller.list({ token: "nt_m" });
    expect(rows.map((r) => r.status)).toEqual(["revoked", "offline", "online"]); // id 倒序
    expect(rows[2].claimedByName).toBe("TEST_老板");
    const json = JSON.stringify(rows);
    expect(json).not.toContain("tokenHash");
    expect(json).not.toContain('"fingerprint"'); // 仅 fingerprintHint 前 8 位
    expect(rows[0].fingerprintHint).toBe("fp_TEST_");

    // admin 通过
    selectQueue.push([adminUser], [factory], [deviceRow({ lastSeenAt: new Date() })], []);
    const adminRows = await caller.list({ token: "nt_a" });
    expect(adminRows[0].status).toBe("online");
  });
});

describe("pair.revoke（仅 admin，C 级，幂等）", () => {
  it("已 revoke 重复调用 → ok:true 幂等；staff/manager → FORBIDDEN；他企业 deviceId → NOT_FOUND；解绑后 heartbeat → UNAUTHORIZED", async () => {
    // staff → FORBIDDEN（非部门负责人）
    selectQueue.push([staffUser], [factory], []);
    await expect(caller.revoke({ token: "nt_s", deviceId: 42 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // manager → FORBIDDEN（仅 admin）
    selectQueue.push([managerUser], [factory]);
    await expect(caller.revoke({ token: "nt_m", deviceId: 42 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // 他企业 deviceId → NOT_FOUND（不泄露跨企业存在性）
    selectQueue.push([adminUser], [factory], []);
    await expect(caller.revoke({ token: "nt_a", deviceId: 999 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    // 在册 → 解绑成功（写 revokedAt）
    selectQueue.push([adminUser], [factory], [deviceRow()]);
    const ok = await caller.revoke({ token: "nt_a", deviceId: 42 });
    expect(ok).toEqual({ ok: true, deviceId: 42 });
    expect(updated.some((v) => v.revokedAt instanceof Date)).toBe(true);

    // 已解绑 → 幂等 ok（不再写库）
    updated = [];
    selectQueue.push([adminUser], [factory], [deviceRow({ revokedAt: past() })]);
    const again = await caller.revoke({ token: "nt_a", deviceId: 42 });
    expect(again).toEqual({ ok: true, deviceId: 42 });
    expect(updated).toHaveLength(0);

    // 解绑后 dt_ heartbeat → UNAUTHORIZED
    selectQueue.push([deviceRow({ revokedAt: past() })]);
    await expect(
      caller.heartbeat({ deviceToken: `dt_${"d".repeat(48)}` }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("pair.heartbeat（dt_ 设备凭证，token 在 body）", () => {
  it("有效 dt_ 更新 lastSeenAt + serverTime；revoked / 未 pulled / 错误 token → UNAUTHORIZED", async () => {
    const dt = `dt_${"e".repeat(48)}`;
    selectQueue.push([deviceRow({ tokenHash: sha256(dt) })]);
    const res = await caller.heartbeat({ deviceToken: dt, meta: { version: "1.0.0" } });
    expect(res.ok).toBe(true);
    expect(res.serverTime).toBeInstanceOf(Date);
    expect(updated.some((v) => v.lastSeenAt instanceof Date)).toBe(true);

    // 凭证未被设备拉取（tokenPulledAt NULL）→ UNAUTHORIZED
    selectQueue.push([deviceRow({ tokenPulledAt: null })]);
    await expect(caller.heartbeat({ deviceToken: dt })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    // 错误 token（库无命中）→ UNAUTHORIZED
    selectQueue.push([]);
    await expect(
      caller.heartbeat({ deviceToken: `dt_${"f".repeat(48)}` }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
