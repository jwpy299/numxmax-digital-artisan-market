/**
 * M26 v1.4.0 呼叫信令（wbCalls + 灵枢来电）测试（SQL 层 mock，不连库；测试数据 TEST_ 前缀）。
 *
 * 断言矩阵（设计 §4 契约 + §7 安全红线 + §9 测试矩阵）：
 * 1. call.invite 全流程：ringing 落库 + roomId=call_{id} + 被叫 incoming_call 推送
 *    （content=JSON 载荷 {callId, media, callerName, persona:null}）+ callerSig dev 假签名；
 * 2. invite 不能呼叫自己 → BAD_REQUEST；
 * 3. invite 被叫非本企业成员/不存在 → BAD_REQUEST（不泄露他企业成员存在性）；
 * 4. call.accept：被叫接听 ringing→active + answeredAt + 返 calleeSig/roomId；
 * 5. accept 越权：主叫/第三人接听 → FORBIDDEN；
 * 6. accept 惰性 missed：ringing 超 60s（与 App 主叫等待 60s 对齐）→ 落 missed 且拒绝接听（BAD_REQUEST）；
 * 7. accept 幂等：active 重入仍返 calleeSig，不再写库；
 * 8. call.reject：仅被叫；ringing→rejected；第三人 FORBIDDEN；终态幂等 ok；
 * 9. call.hangup：主/被叫均可；active→ended + durationSec（answeredAt 起算）；第三人 FORBIDDEN；
 * 10. missed 惰性清扫：sweepMissedCalls WHERE 编译 SQL 断言（factoryId+ringing+startedAt<cutoff），
 *     wbProactive.poll 接线后顺带清扫；
 * 11. UserSig 官方算法对拍：固定输入（腾讯云官方 demo sdkappid/key/identifier + 固定时间）对拍
 *     独立参考实现（Python 按官方文档 647/17275 步骤计算）的签名值；解码 roundtrip 校验字段；
 *     env 未配置 → dev 假签名（仅开发）；env 配置 → 真签名格式；
 * 12. 灵枢来电触发：设备离线 → wb_calls ringing(callerId=0, persona=lingshu) +
 *     incoming_call 推送载荷（callerName=灵枢）；dedupeKey 命中 → 零写入；
 * 13. 星云来电触发：邀请临期 → persona=xingyun（callerName=星云）；
 * 14. 隐私红线：路由源码含「不录音不录像」声明注释；wb_calls 落库值绝不含音视频内容字段。
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { inflateSync } from "node:zlib";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

type Row = Record<string, unknown>;

let selectQueue: Row[][];
let inserted: Array<{ table: unknown; values: Row }>;
let updates: Row[];
let whereConds: unknown[];
let nextId: number;
let updateAffectedRows: number[]; // 逐次 update 的 affectedRows（默认 1；竞态用例压 0）

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
          return [{ affectedRows: updateAffectedRows.length > 0 ? updateAffectedRows.shift()! : 1 }];
        },
      }),
    }),
  };
  return { getDb: () => db };
});

import { wbCallsRouter, genUserSig, userSigFor, trtcSdkAppId, sweepMissedCalls, RING_TIMEOUT_MS } from "./routers/wbCalls";
import { wbProactiveRouter } from "./routers/wbProactive";
import { runProactiveSweep } from "./routers/proactiveJobs";
import { wbCalls, wbProactiveMsgs } from "@db/schema";

const callerApi = wbCallsRouter.createCaller({} as never);
const proactive = wbProactiveRouter.createCaller({} as never);

const factoryRow = { id: 10, enterpriseName: "TEST_星云企业", departments: [] };
const bossUser = { id: 1, username: "TEST_boss", displayName: "TEST_老板", role: "owner", factoryId: 10, authToken: "TEST_tok1" };
const empUser = { id: 2, username: "TEST_emp", displayName: "TEST_员工", role: "staff", factoryId: 10, authToken: "TEST_tok2" };
const thirdUser = { id: 3, username: "TEST_third", displayName: "TEST_路人", role: "staff", factoryId: 10, authToken: "TEST_tok3" };

function callRow(over: Row = {}): Row {
  return {
    id: 100,
    factoryId: 10,
    callerId: 1,
    calleeId: 2,
    media: "audio",
    roomId: "call_100",
    status: "ringing",
    startedAt: new Date(),
    answeredAt: null,
    endedAt: null,
    durationSec: 0,
    meta: null,
    ...over,
  };
}

beforeEach(() => {
  selectQueue = [];
  inserted = [];
  updates = [];
  whereConds = [];
  nextId = 100;
  updateAffectedRows = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("call.invite", () => {
  it("1. 全流程：ringing 落库 + roomId=call_{id} + 被叫 incoming_call 推送 + callerSig", async () => {
    selectQueue.push([bossUser], [factoryRow], [empUser]); // sessionMe×2 + 被叫校验
    const res = await callerApi.invite({ token: "TEST_tok1", calleeUserId: 2, media: "audio" });
    expect(res).toMatchObject({ ok: true, callId: 100, roomId: "call_100" });
    // 未配置 TRTC env → dev 假签名（仅开发），绝不含真实密钥
    expect(res.callerSig).toMatch(/^dev\..+\.dev$/);
    // 进房凭据：trtcUserId 与 UserSig 签发 identifier 同源（String(主叫 user.id)）；
    // sdkAppId 无 env 时兜底官方 demo 1600156498
    expect(res.trtcUserId).toBe("1");
    expect(res.sdkAppId).toBe(1600156498);

    const callInsert = inserted.find((r) => r.table === wbCalls);
    expect(callInsert).toBeTruthy();
    expect(callInsert!.values).toMatchObject({
      factoryId: 10,
      callerId: 1,
      calleeId: 2,
      media: "audio",
      status: "ringing",
    });
    // roomId 回填 call_{id}
    expect(updates.some((u) => u.roomId === "call_100")).toBe(true);

    const msgInsert = inserted.find((r) => r.table === wbProactiveMsgs);
    expect(msgInsert).toBeTruthy();
    expect(msgInsert!.values).toMatchObject({
      factoryId: 10,
      userId: 2, // 定向推送：仅被叫可见
      kind: "incoming_call",
      priority: "speak",
      dedupeKey: "call-invite-100",
    });
    const payload = JSON.parse(String(msgInsert!.values.content));
    expect(payload).toEqual({ callId: 100, media: "audio", callerName: "TEST_老板", persona: null });
  });

  it("2. 不能呼叫自己 → BAD_REQUEST", async () => {
    selectQueue.push([bossUser], [factoryRow]);
    await expect(
      callerApi.invite({ token: "TEST_tok1", calleeUserId: 1, media: "video" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "不能呼叫自己" });
    expect(inserted).toHaveLength(0);
  });

  it("3. 被叫非本企业成员/不存在 → BAD_REQUEST（不泄露他企业存在性）", async () => {
    selectQueue.push([bossUser], [factoryRow], []); // 被叫查询命中 0 行
    await expect(
      callerApi.invite({ token: "TEST_tok1", calleeUserId: 999, media: "audio" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "被叫用户不存在或非本企业成员" });
    expect(inserted).toHaveLength(0);
  });
});

describe("call.accept", () => {
  it("4. 被叫接听：ringing→active + answeredAt + 返 roomId/calleeSig", async () => {
    selectQueue.push([empUser], [factoryRow], [callRow()]);
    const res = await callerApi.accept({ token: "TEST_tok2", callId: 100 });
    expect(res).toMatchObject({ ok: true, roomId: "call_100" });
    expect(res.calleeSig).toMatch(/^dev\..+\.dev$/);
    // 进房凭据：trtcUserId = String(被叫 user.id)，与 calleeSig 签发 identifier 一致
    expect(res.trtcUserId).toBe("2");
    expect(res.sdkAppId).toBe(1600156498);
    const act = updates.find((u) => u.status === "active");
    expect(act).toBeTruthy();
    expect(act!.answeredAt).toBeInstanceOf(Date);
    // 竞态护栏：UPDATE 带 WHERE status='ringing' 条件（编译 SQL 断言）
    const q = compile(whereConds[whereConds.length - 1]);
    expect(q.sql).toContain("`status` = ?");
    expect(q.params).toContain("ringing");
  });

  it("5. 越权：主叫/第三人接听 → FORBIDDEN", async () => {
    selectQueue.push([bossUser], [factoryRow], [callRow()]);
    await expect(callerApi.accept({ token: "TEST_tok1", callId: 100 })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "仅被叫可接听",
    });
    selectQueue.push([thirdUser], [factoryRow], [callRow()]);
    await expect(callerApi.accept({ token: "TEST_tok3", callId: 100 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(updates).toHaveLength(0);
  });

  it("6. 惰性 missed：ringing 超 60s 接听 → 落 missed + BAD_REQUEST", async () => {
    selectQueue.push(
      [empUser],
      [factoryRow],
      [callRow({ startedAt: new Date(Date.now() - RING_TIMEOUT_MS - 1000) })],
    );
    await expect(callerApi.accept({ token: "TEST_tok2", callId: 100 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "呼叫已超时未接",
    });
    const missed = updates.find((u) => u.status === "missed");
    expect(missed).toBeTruthy();
    expect(missed!.endedAt).toBeInstanceOf(Date);
  });

  it("6b. 60s 口径（与 App 主叫等待对齐）：RING_TIMEOUT_MS=60s；59s 仍可接，61s 已 missed", async () => {
    expect(RING_TIMEOUT_MS).toBe(60_000);
    // 59s：未超时，正常接听
    selectQueue.push(
      [empUser],
      [factoryRow],
      [callRow({ startedAt: new Date(Date.now() - 59_000) })],
    );
    const ok = await callerApi.accept({ token: "TEST_tok2", callId: 100 });
    expect(ok).toMatchObject({ ok: true, trtcUserId: "2" });
    expect(updates.some((u) => u.status === "active")).toBe(true);
    // 61s：超 60s → missed + BAD_REQUEST
    updates = [];
    selectQueue.push(
      [empUser],
      [factoryRow],
      [callRow({ startedAt: new Date(Date.now() - 61_000) })],
    );
    await expect(callerApi.accept({ token: "TEST_tok2", callId: 100 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "呼叫已超时未接",
    });
    expect(updates.some((u) => u.status === "missed")).toBe(true);
  });

  it("7b. 竞态：accept 与 hangup 并发——UPDATE affectedRows=0（ended 已抢先落库）→ BAD_REQUEST，绝不复活 active", async () => {
    selectQueue.push([empUser], [factoryRow], [callRow()]);
    updateAffectedRows.push(0); // 模拟 hangup 抢先：ringing 条件不再命中
    await expect(callerApi.accept({ token: "TEST_tok2", callId: 100 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "呼叫已被挂断或结束",
    });
    // 只尝试了 1 次条件更新（带 WHERE status='ringing'），无后续写库
    expect(updates).toHaveLength(1);
    const q = compile(whereConds[whereConds.length - 1]);
    expect(q.sql).toContain("`id` = ?");
    expect(q.sql).toContain("`status` = ?");
    expect(q.params).toEqual([100, "ringing"]);
  });

  it("7. 幂等：active 重入仍返 calleeSig，不再写库；终态（ended）→ BAD_REQUEST", async () => {
    selectQueue.push([empUser], [factoryRow], [callRow({ status: "active", answeredAt: new Date() })]);
    const res = await callerApi.accept({ token: "TEST_tok2", callId: 100 });
    expect(res.ok).toBe(true);
    expect(res.calleeSig).toMatch(/^dev\./);
    expect(updates).toHaveLength(0);

    selectQueue.push([empUser], [factoryRow], [callRow({ status: "ended" })]);
    await expect(callerApi.accept({ token: "TEST_tok2", callId: 100 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "呼叫已结束",
    });
  });
});

describe("call.reject", () => {
  it("8. 仅被叫可拒：ringing→rejected；第三人 FORBIDDEN；终态幂等 ok", async () => {
    // 成功
    selectQueue.push([empUser], [factoryRow], [callRow()]);
    const ok = await callerApi.reject({ token: "TEST_tok2", callId: 100 });
    expect(ok).toEqual({ ok: true });
    const rej = updates.find((u) => u.status === "rejected");
    expect(rej).toBeTruthy();
    expect(rej!.endedAt).toBeInstanceOf(Date);

    // 第三人 → FORBIDDEN
    updates = [];
    selectQueue.push([thirdUser], [factoryRow], [callRow()]);
    await expect(callerApi.reject({ token: "TEST_tok3", callId: 100 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(updates).toHaveLength(0);

    // 终态幂等（已 rejected 重复拒接 → ok，不再写库）
    selectQueue.push([empUser], [factoryRow], [callRow({ status: "rejected" })]);
    const again = await callerApi.reject({ token: "TEST_tok2", callId: 100 });
    expect(again).toEqual({ ok: true });
    expect(updates).toHaveLength(0);
  });
});

describe("call.hangup", () => {
  it("9. active→ended + durationSec（answeredAt 起算）；主叫也可挂；第三人 FORBIDDEN；ringing 挂断时长 0", async () => {
    // 被叫挂断 active 通话：时长 ≈65s
    selectQueue.push(
      [empUser],
      [factoryRow],
      [callRow({ status: "active", answeredAt: new Date(Date.now() - 65_000) })],
    );
    const ok = await callerApi.hangup({ token: "TEST_tok2", callId: 100 });
    expect(ok).toEqual({ ok: true });
    const end = updates.find((u) => u.status === "ended");
    expect(end).toBeTruthy();
    expect(end!.durationSec).toBeGreaterThanOrEqual(64);
    expect(end!.durationSec).toBeLessThanOrEqual(66);

    // 主叫挂断 ringing（取消呼叫）→ ended，durationSec=0
    updates = [];
    selectQueue.push([bossUser], [factoryRow], [callRow()]);
    await callerApi.hangup({ token: "TEST_tok1", callId: 100 });
    const cancel = updates.find((u) => u.status === "ended");
    expect(cancel).toBeTruthy();
    expect(cancel!.durationSec).toBe(0);

    // 第三人 → FORBIDDEN
    updates = [];
    selectQueue.push([thirdUser], [factoryRow], [callRow({ status: "active", answeredAt: new Date() })]);
    await expect(callerApi.hangup({ token: "TEST_tok3", callId: 100 })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "仅通话双方可操作",
    });
    expect(updates).toHaveLength(0);
  });
});

describe("missed 惰性清扫（sweepMissedCalls + wbProactive.poll 接线）", () => {
  it("10. WHERE 编译 SQL 断言：本企业 + ringing + startedAt < NOW()-60s；poll 顺带清扫", async () => {
    const n = await sweepMissedCalls(10, new Date("2026-08-11T08:00:00Z"));
    expect(n).toBe(1); // mock affectedRows=1
    expect(updates[0]).toMatchObject({ status: "missed" });
    expect(updates[0]!.endedAt).toBeInstanceOf(Date);
    const q = compile(whereConds[0]);
    expect(q.sql).toContain("`factoryId` = ?");
    expect(q.sql).toContain("`status` = ?");
    expect(q.sql).toMatch(/`startedAt` < \?/);
    expect(q.params).toContain(10);
    expect(q.params).toContain("ringing");
    // 60s 口径：cutoff = now(08:00:00) - 60s = 07:59:00（sqlToQuery 序列化 Date 为串）
    const cutoff = q.params.find((p) => typeof p === "string" && /^\d{4}-\d{2}-\d{2} /.test(p));
    expect(String(cutoff)).toContain("2026-08-11 07:59:00");

    // wbProactive.poll 接线：sessionMe×2 select + sweep update + 消息 select
    updates = [];
    whereConds = [];
    selectQueue.push([empUser], [factoryRow], []);
    const r = await proactive.poll({ token: "TEST_tok2" });
    expect(r.items).toEqual([]);
    expect(updates.some((u) => u.status === "missed")).toBe(true); // poll 顺带清扫
  });
});

describe("UserSig（TLSSigAPI@v2 官方算法）", () => {
  // 官方 demo 固定输入（腾讯云 tls-sig-api-v2 全语言示例同组参数）+ 固定时间戳
  const SDK_APP_ID = 1400000000;
  const SECRET = "5bd2850fff3ecb11d7c805251c51ee463a25727bddc2385f3fa8bfee1bb93b5e";
  const IDENTIFIER = "xiaojun";
  const EXPIRE = 180 * 86400;
  const FIXED_TIME = 1754899200; // 2025-08-11T08:00:00Z
  // 对拍基准：独立参考实现（Python 按官方文档 647/17275 步骤：HMAC-SHA256→JSON→zlib deflate→
  // base64 转义）对同一固定输入的计算结果。deflate 压缩流随 zlib 构建版本不同可能有字节差异
  //（TRTC 服务端只做 inflate 校验，官方各语言 SDK 压缩流亦不完全同字节），故对拍口径 =
  // ① 确定性核心（sigDoc JSON 串 + HMAC sig）逐字节一致；② 参考实现产出的签名串在本实现可
  // 正确 inflate 出同一 sigDoc（跨实现互认，证明格式兼容）。
  const OFFICIAL_REFERENCE =
    "eJyrVgrxCdYrSy1SslIy0jNQ0gHzM1NS80oy0zLBwhWZiflZpXlQqeKU7MSCgswUJStDEwMogMikVhRkFqUCxU1NTY3goiWZuSAxc1MTC0tLI5hocWY60OTiHNMMbxfvSv9wt1KvcDfnUH8XX7OcvBIfD4PgUpdcv7z0EM9yfVP9-KhQW6VaALLgMiE_";
  // Python 参考实现算得的 sigDoc JSON（逐字节 golden）
  const GOLDEN_DOC_JSON =
    '{"TLS.ver":"2.0","TLS.identifier":"xiaojun","TLS.sdkappid":1400000000,"TLS.expire":15552000,"TLS.time":1754899200,"TLS.sig":"sl5hKDKyOWFuJWFCUODM6lntLH0SuDmNngTIw/5/oZU="}';

  const unescape = (sig: string) => sig.replace(/\*/g, "+").replace(/-/g, "/").replace(/_/g, "=");
  const inflateSig = (sig: string) =>
    inflateSync(Buffer.from(unescape(sig), "base64")).toString("utf8");

  it("11. 官方算法对拍：sigDoc JSON 与 HMAC sig 逐字节对拍参考实现 + 跨实现 inflate 互认", () => {
    const sig = genUserSig(SDK_APP_ID, SECRET, IDENTIFIER, EXPIRE, FIXED_TIME);
    // ① 本实现产出的签名串 inflate 后与 Python 参考实现的 sigDoc JSON 逐字节一致
    expect(inflateSig(sig)).toBe(GOLDEN_DOC_JSON);
    // ② 反向互认：Python 参考实现产出的签名串在本实现可正确 inflate 出同一 sigDoc
    //    （证明 deflate/base64 转义格式与官方生态互通，TRTC 服务端可验）
    expect(inflateSig(OFFICIAL_REFERENCE)).toBe(GOLDEN_DOC_JSON);

    const doc = JSON.parse(inflateSig(sig));
    expect(doc).toMatchObject({
      "TLS.ver": "2.0",
      "TLS.identifier": IDENTIFIER,
      "TLS.sdkappid": SDK_APP_ID,
      "TLS.expire": EXPIRE,
      "TLS.time": FIXED_TIME,
    });
    // TLS.sig = HMAC-SHA256 官方签名串（base64），对拍 Python 参考实现 golden 值
    const content =
      `TLS.identifier:${IDENTIFIER}\n` +
      `TLS.sdkappid:${SDK_APP_ID}\n` +
      `TLS.time:${FIXED_TIME}\n` +
      `TLS.expire:${EXPIRE}\n`;
    const expectedSig = createHmac("sha256", SECRET).update(content, "utf8").digest("base64");
    expect(expectedSig).toBe("sl5hKDKyOWFuJWFCUODM6lntLH0SuDmNngTIw/5/oZU="); // Python golden
    expect(doc["TLS.sig"]).toBe(expectedSig);
    // UserSig 字符集：base64 URL 转义后绝不含 + / =
    expect(sig).toMatch(/^[A-Za-z0-9*\-_]+$/);
  });

  it("11b. env 分支：无 key → dev 假签名（仅开发）；配置 env → 真签名", () => {
    delete process.env.TRTC_SDK_APP_ID;
    delete process.env.TRTC_SECRET_KEY;
    const dev = userSigFor(42);
    expect(dev).toBe(`dev.${Buffer.from("usersig:42", "utf8").toString("base64")}.dev`);
    expect(dev).not.toContain(SECRET);

    vi.stubEnv("TRTC_SDK_APP_ID", String(SDK_APP_ID));
    vi.stubEnv("TRTC_SECRET_KEY", SECRET);
    const real = userSigFor(42);
    expect(real).toMatch(/^[A-Za-z0-9*\-_]{20,}$/);
    expect(real).not.toContain("dev.");
    // 真签名可解码且 identifier 正确
    const b64 = real.replace(/\*/g, "+").replace(/-/g, "/").replace(/_/g, "=");
    const doc = JSON.parse(inflateSync(Buffer.from(b64, "base64")).toString("utf8"));
    expect(doc["TLS.identifier"]).toBe("42");
    expect(doc["TLS.sdkappid"]).toBe(SDK_APP_ID);
  });

  it("11c. trtcSdkAppId：单一事实源 env TRTC_SDK_APP_ID，无 env 兜底 1600156498；invite/accept 响应同源", async () => {
    delete process.env.TRTC_SDK_APP_ID;
    expect(trtcSdkAppId()).toBe(1600156498);
    vi.stubEnv("TRTC_SDK_APP_ID", String(SDK_APP_ID));
    vi.stubEnv("TRTC_SECRET_KEY", SECRET);
    expect(trtcSdkAppId()).toBe(SDK_APP_ID);
    // 配置 env 后 invite/accept 响应 sdkAppId=env 值，且真签名内嵌 sdkappid 与响应一致
    selectQueue.push([bossUser], [factoryRow], [empUser]);
    const inv = await callerApi.invite({ token: "TEST_tok1", calleeUserId: 2, media: "audio" });
    expect(inv.sdkAppId).toBe(SDK_APP_ID);
    expect(inv.trtcUserId).toBe("1");
    selectQueue.push([empUser], [factoryRow], [callRow()]);
    const acc = await callerApi.accept({ token: "TEST_tok2", callId: 100 });
    expect(acc.sdkAppId).toBe(SDK_APP_ID);
    expect(acc.trtcUserId).toBe("2");
    const b64 = acc.calleeSig.replace(/\*/g, "+").replace(/-/g, "/").replace(/_/g, "=");
    const doc = JSON.parse(inflateSync(Buffer.from(b64, "base64")).toString("utf8"));
    expect(doc["TLS.sdkappid"]).toBe(acc.sdkAppId); // 进房 sdkAppId 与签发内嵌必一致
    expect(doc["TLS.identifier"]).toBe(acc.trtcUserId); // 进房 userId 与签发 identifier 必一致
  });
});

describe("灵枢/星云来电触发（proactiveJobs → pushProactiveCall）", () => {
  const NOW = new Date("2025-01-02T12:00:00Z");

  it("12. 设备离线 → wb_calls ringing(callerId=0) + incoming_call 载荷 persona=lingshu；dedupe 命中零写入", async () => {
    selectQueue.push(
      [{ id: 3, factoryId: 10, name: "TEST_二号机床" }], // 离线设备候选
      [], // dedupe 未发过
      [], // 邀请候选：无
    );
    const r = await runProactiveSweep(NOW);
    expect(r).toEqual({ deviceAlerts: 1, inviteAlerts: 0 });

    const callInsert = inserted.find((x) => x.table === wbCalls);
    expect(callInsert).toBeTruthy();
    expect(callInsert!.values).toMatchObject({
      factoryId: 10,
      callerId: 0, // 数字人来电
      calleeId: null, // 全员广播
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
    expect(payload).toMatchObject({
      callId: 100,
      media: "audio",
      callerName: "灵枢",
      persona: "lingshu",
    });
    expect(String(payload.summary)).toContain("TEST_二号机床");

    // dedupe 命中 → 零写入
    inserted = [];
    selectQueue.push([{ id: 3, factoryId: 10, name: "TEST_二号机床" }], [{ id: 88 }], []);
    const r2 = await runProactiveSweep(NOW);
    expect(r2.deviceAlerts).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it("13. 邀请临期 → 星云来电（persona=xingyun，callerName=星云）", async () => {
    selectQueue.push(
      [], // 无离线设备
      [{ id: 9, factoryId: 10, displayName: "TEST_小张" }], // 临期邀请
      [], // dedupe 未发过
    );
    const r = await runProactiveSweep(NOW);
    expect(r).toEqual({ deviceAlerts: 0, inviteAlerts: 1 });
    const callInsert = inserted.find((x) => x.table === wbCalls);
    expect(callInsert!.values.meta).toMatchObject({ persona: "xingyun", kind: "invite_expire" });
    const msgInsert = inserted.find((x) => x.table === wbProactiveMsgs);
    expect(msgInsert!.values).toMatchObject({ kind: "incoming_call", dedupeKey: "invite-expire-9" });
    const payload = JSON.parse(String(msgInsert!.values.content));
    expect(payload).toMatchObject({ callerName: "星云", persona: "xingyun" });
    expect(String(payload.summary)).toContain("发给TEST_小张的邀请快过期了");
  });
});

describe("隐私红线", () => {
  it("14. 不录音不录像：源码显式声明；wb_calls 落库值绝不含音视频内容字段", async () => {
    const src = readFileSync(
      path.resolve(import.meta.dirname, "routers/wbCalls.ts"),
      "utf8",
    );
    expect(src).toContain("不录音不录像"); // 隐私红线明示声明注释
    // 实跑一通 invite + 灵枢来电，呼叫落库字段只含元数据（谁/何时/时长/类型），无任何媒体内容字段
    selectQueue.push([bossUser], [factoryRow], [empUser]);
    await callerApi.invite({ token: "TEST_tok1", calleeUserId: 2, media: "video" });
    selectQueue.push([{ id: 3, factoryId: 10, name: "TEST_二号机床" }], [], []);
    await runProactiveSweep(new Date("2025-01-02T12:00:00Z"));
    const callInserts = inserted.filter((entry) => entry.table === wbCalls);
    expect(callInserts.length).toBeGreaterThanOrEqual(2);
    for (const entry of callInserts) {
      const keys = Object.keys(entry.values);
      expect(keys).not.toContain("recording");
      expect(keys).not.toContain("recordingUrl");
      expect(keys).not.toContain("audioData");
      expect(keys).not.toContain("videoData");
    }
  });
});
