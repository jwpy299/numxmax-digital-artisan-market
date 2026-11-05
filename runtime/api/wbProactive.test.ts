/**
 * M23b 主动服务（wbProactive + proactiveJobs）测试（SQL 层 mock，不连库；测试数据 TEST_ 前缀）。
 *
 * 断言矩阵：
 * 1. poll：本人定向未读 + 全员广播时间窗内消息可见（broadcast 标记区分），倒序，出参 items；
 * 2. poll 广播语义：24h 内多设备（不同用户）同收同一广播；WHERE 编译 SQL 断言——
 *    广播分支仅「userId IS NULL AND createdAt > NOW()-24h」（不依赖 readAt，超 24h 不再出）；
 * 3. markRead：readAt 置位 + 幂等 ok:true；WHERE 编译 SQL 断言仅命中 userId=本人定向行
 *    （不含广播分支 isNull(userId)，markRead 不影响广播）；
 * 4. 设备离线触发：lastSeenAt 超 30min → speak 全员广播，dedupeKey=dev-offline-{id}-{YYYY-MM-DD}；
 * 5. 设备离线去重：同 dedupeKey 已存在 → 跳过不插（同事件每日历天(UTC)最多一次，主动≠骚扰）；
 * 6. 邀请临期触发：card 优先级，dedupeKey=invite-expire-{id}，文案带受邀者名；
 * 7. 邀请临期去重 + 无候选时零写入。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

type Row = Record<string, unknown>;

let selectQueue: Row[][];
let inserted: Array<{ table: unknown; values: Row }>;
let updates: Row[];
let whereConds: unknown[]; // 捕获 select/update 的 WHERE 条件，编译 SQL 断言语义
let nextId: number;

const dialect = new MySqlDialect();
function compile(cond: unknown) {
  return dialect.sqlToQuery(cond as never);
}

vi.mock("./queries/connection", () => {
  const thenable = (rows: Row[]) => ({
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej),
  });
  const db = {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          whereConds.push(cond);
          const rows = selectQueue.shift() ?? [];
          return {
            then: thenable(rows).then,
            limit: () => thenable(rows),
            orderBy: () => ({ then: thenable(rows).then, limit: () => thenable(rows) }),
          };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (v: Row) => {
        inserted.push({ table, values: v });
        const id = nextId++;
        return {
          $returningId: async () => [{ id }],
          then: (res: (v: unknown) => unknown) => Promise.resolve([{ affectedRows: 1 }]).then(res),
        };
      },
    }),
    update: () => ({
      set: (v: Row) => ({
        where: async (cond: unknown) => {
          whereConds.push(cond);
          updates.push(v);
          return [{ affectedRows: 1 }];
        },
      }),
    }),
  };
  return { getDb: () => db };
});

import { wbProactiveRouter } from "./routers/wbProactive";
import { runProactiveSweep } from "./routers/proactiveJobs";
import { wbCalls, wbProactiveMsgs } from "@db/schema";

const caller = wbProactiveRouter.createCaller({} as never);

const factoryRow = { id: 10, enterpriseName: "TEST_星云企业", departments: [] };
const userRow = { id: 1, username: "TEST_boss", displayName: "TEST_老板", role: "owner", factoryId: 10, authToken: "TEST_tok" };

function msgRow(over: Row = {}): Row {
  return {
    id: 50,
    factoryId: 10,
    userId: null,
    kind: "device_offline",
    content: "TEST_设备离线提醒",
    priority: "speak",
    dedupeKey: "dev-offline-3-2025-01-02",
    createdAt: new Date("2025-01-02T00:00:00Z"),
    readAt: null,
    ...over,
  };
}

beforeEach(() => {
  selectQueue = [];
  inserted = [];
  updates = [];
  whereConds = [];
  nextId = 100;
});

describe("wbProactive.poll / markRead", () => {
  it("1. poll：全员广播 + 本人定向均可见（出参 items），broadcast 标记区分", async () => {
    selectQueue.push(
      [userRow], [factoryRow],
      [msgRow({ id: 52, userId: 1, kind: "invite_expire", priority: "card" }), msgRow({ id: 50 })],
    );
    const r = await caller.poll({ token: "TEST_tok" });
    expect(r.items.map((m) => m.msgId)).toEqual([52, 50]);
    expect(r.items[0]).toMatchObject({ broadcast: false, priority: "card", kind: "invite_expire" });
    expect(r.items[1]).toMatchObject({ broadcast: true, priority: "speak" });
  });

  it("2. 广播时间窗语义：多设备同收同一广播；WHERE 仅 userId IS NULL AND createdAt > NOW()-24h", async () => {
    // 另一台设备（另一用户 userId=2）也能 poll 到同一广播行（广播不依赖 readAt 已读状态）
    const userRow2 = { ...userRow, id: 2, authToken: "TEST_tok2" };
    selectQueue.push([userRow], [factoryRow], [msgRow({ id: 50 })]);
    const r1 = await caller.poll({ token: "TEST_tok" });
    selectQueue.push([userRow2], [factoryRow], [msgRow({ id: 50 })]);
    const r2 = await caller.poll({ token: "TEST_tok2" });
    expect(r1.items[0]).toMatchObject({ msgId: 50, broadcast: true });
    expect(r2.items[0]).toMatchObject({ msgId: 50, broadcast: true });

    const q = compile(whereConds[3]); // [user][factory][v1.4.0 missed 清扫 update][消息 select]
    expect(q.sql).toMatch(/`userId` is null and `wb_proactive_msgs`.`createdAt` > \?/);
    // 定向分支仍维持 readAt 已读语义
    expect(q.sql).toMatch(/`userId` = \? and `wb_proactive_msgs`.`readAt` is null/);
    // 时间窗参数 ≈ NOW()-24h（超 24h 的广播不再出）；drizzle timestamp 驱动值为本机时区字符串
    const cutoffStr = q.params.find(
      (p) => typeof p === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(p),
    ) as string;
    expect(typeof cutoffStr).toBe("string");
    // 驱动字符串不带时区：本机/UTC 两种解释容认（语义断言目标 = 24h 窗口本身）
    const asLocal = new Date(cutoffStr.replace(" ", "T")).getTime();
    const asUtc = new Date(`${cutoffStr.replace(" ", "T")}Z`).getTime();
    const target = Date.now() - 24 * 3600 * 1000;
    expect(Math.min(Math.abs(asLocal - target), Math.abs(asUtc - target))).toBeLessThan(10_000);
  });

  it("3. markRead：readAt 置位 + 幂等 ok:true；仅本人定向行生效（不影响广播）", async () => {
    selectQueue.push([userRow], [factoryRow]);
    const r1 = await caller.markRead({ token: "TEST_tok", ids: [50, 52] });
    expect(r1.ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.readAt).toBeInstanceOf(Date);

    // WHERE 编译 SQL 断言：仅 userId=本人，无广播分支（isNull(userId) 不出现）
    const q = compile(whereConds[2]); // [user][factory][update]
    expect(q.sql).toContain("`userId` = ?");
    expect(q.sql).not.toContain("`userId` is null");
    expect(q.sql).toContain("`readAt` is null"); // 仅未读行置位（幂等）
    expect(q.params).toContain(1);

    selectQueue.push([userRow], [factoryRow]);
    const r2 = await caller.markRead({ token: "TEST_tok", ids: [50, 52] }); // 幂等
    expect(r2.ok).toBe(true);
  });
});

describe("proactiveJobs 触发器（主动≠骚扰：dedupeKey 查重）", () => {
  const NOW = new Date("2025-01-02T12:00:00Z");

  it("4. 设备离线 → v1.4.0 灵枢来电：wb_calls ringing(callerId=0) + incoming_call 推送（persona=lingshu）", async () => {
    selectQueue.push(
      [{ id: 3, factoryId: 10, name: "TEST_一号工作台" }], // 离线设备候选
      [], // dedupe 查重：未发过
      [], // 邀请候选：无
    );
    const r = await runProactiveSweep(NOW);
    expect(r).toEqual({ deviceAlerts: 1, inviteAlerts: 0 });
    expect(inserted).toHaveLength(2); // wb_calls + wb_proactive_msgs 各一
    const callInsert = inserted.find((x) => x.table === wbCalls);
    expect(callInsert).toBeTruthy();
    expect(callInsert!.values).toMatchObject({
      factoryId: 10,
      callerId: 0, // 数字人来电
      calleeId: null, // 全员广播：设备台账是厂级事项
      media: "audio",
      status: "ringing",
    });
    expect(callInsert!.values.meta).toMatchObject({ persona: "lingshu", kind: "device_offline" });
    const msgInsert = inserted.find((x) => x.table === wbProactiveMsgs);
    expect(msgInsert).toBeTruthy();
    expect(msgInsert!.values).toMatchObject({
      factoryId: 10,
      userId: null,
      kind: "incoming_call",
      priority: "speak",
      dedupeKey: "dev-offline-3-2025-01-02",
    });
    const payload = JSON.parse(String(msgInsert!.values.content));
    expect(payload).toMatchObject({ media: "audio", callerName: "灵枢", persona: "lingshu" });
    expect(String(payload.summary)).toBe("老板，设备「TEST_一号工作台」已离线超过 30 分钟，去设备台账看看？");
  });

  it("5. 设备离线去重（每日历天(UTC)最多一次）：同 dedupeKey 已存在 → 跳过不插", async () => {
    selectQueue.push(
      [{ id: 3, factoryId: 10, name: "TEST_一号工作台" }],
      [{ id: 88 }], // dedupe 命中：今日已提醒
      [],
    );
    const r = await runProactiveSweep(NOW);
    expect(r.deviceAlerts).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it("6. 邀请临期 → v1.4.0 星云来电（persona=xingyun），口播文案带受邀者名", async () => {
    selectQueue.push(
      [], // 无离线设备
      [{ id: 9, factoryId: 10, displayName: "TEST_小张" }], // 临期邀请候选
      [], // dedupe 未发过
    );
    const r = await runProactiveSweep(NOW);
    expect(r).toEqual({ deviceAlerts: 0, inviteAlerts: 1 });
    const callInsert = inserted.find((x) => x.table === wbCalls);
    expect(callInsert).toBeTruthy();
    expect(callInsert!.values.meta).toMatchObject({ persona: "xingyun", kind: "invite_expire" });
    const msgInsert = inserted.find((x) => x.table === wbProactiveMsgs);
    expect(msgInsert).toBeTruthy();
    expect(msgInsert!.values).toMatchObject({
      kind: "incoming_call",
      priority: "speak",
      dedupeKey: "invite-expire-9",
    });
    const payload = JSON.parse(String(msgInsert!.values.content));
    expect(payload).toMatchObject({ callerName: "星云", persona: "xingyun" });
    expect(String(payload.summary)).toContain("发给TEST_小张的邀请快过期了");
  });

  it("7. 邀请临期去重 + 全无候选时零写入", async () => {
    selectQueue.push(
      [],
      [{ id: 9, factoryId: 10, displayName: "TEST_小张" }],
      [{ id: 77 }], // dedupe 命中
    );
    const r = await runProactiveSweep(NOW);
    expect(r.inviteAlerts).toBe(0);
    expect(inserted).toHaveLength(0);

    selectQueue.push([], []);
    const r2 = await runProactiveSweep(NOW);
    expect(r2).toEqual({ deviceAlerts: 0, inviteAlerts: 0 });
    expect(inserted).toHaveLength(0);
  });
});
