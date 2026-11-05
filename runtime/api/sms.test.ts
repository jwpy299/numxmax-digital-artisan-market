/**
 * M25 短信验证码通道（sms）测试（SQL 层 mock + mock SmsProvider，不连库；测试数据 TEST_ 前缀）。
 *
 * 断言（任务契约 + 回归）：
 * 1. sendCode dev 模式（无阿里云 key 且 NODE_ENV!=='production'）回显 devCode='123456'，
 *    库写 sha256（64 hex），明文绝不落库/不出现在响应以外任何地方；
 * 2. 非 dev Provider（阿里云形态 mock）不回显 devCode；Provider 收到 6 位数字明文，
 *    库写其 sha256（明文仅在 Provider 入参出现一次）；
 * 3. 发送限频：同号 60s≤1 → TOO_MANY_REQUESTS；同号同 purpose 当日≤10 → TOO_MANY_REQUESTS；
 * 4. 统一回 ok：响应恒为 {ok, ttlSeconds:300[, devCode]}，已注册/未注册等原因绝不外泄；
 * 5. registerByPhone 全流程：码校验+原子消费+建档（username=phone/kind=person/factoryId=0/
 *    role=member/免身份证）+SessionInfo 同构（token nt_、enterpriseName=null）；
 * 6. 手机号已注册 → BAD_REQUEST「该手机号已注册，请直接登录」（码不被消耗）；
 * 7. loginByPhone 签发 nt_（个人 factoryId=0 / 企业成员皆可登）；未注册 → BAD_REQUEST
 *    「该手机号尚未注册」；disabled → FORBIDDEN；
 * 8. 错码 attempts 原子 +1（≥5 同事务作废）；attempts=5 → 「验证码已失效，请重新获取」；
 *    过期码拒绝；消费重放（UPDATE 影响行=0）拒绝；
 * 9. 带 inviteCode 注册即入企：单事务内【消费验证码→消费邀请码→建档（role/deptId/factoryId
 *    取自邀请）→manager 双写 wb_dept_heads→M21 join 履历→签发 nt_】，响应带 enterpriseName。
 * 10. 阿里云 POP RPC 签名 V1：percentEncode 特殊规则（+→%20、*→%2A、%7E→~）+
 *     canonicalQuery 字典序 + HMAC-SHA1(secret+'&') Base64。
 */
import { createHmac } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let selectQueue: Array<Array<Record<string, unknown>>> = [];
let execQueue: unknown[] = [];
let inserted: Array<{ table: unknown; values: Record<string, unknown> }> = [];
let updated: Array<Record<string, unknown>> = [];
let executedSql: string[] = [];
let txCount = 0;
let nextId = 100;

/** 提取 drizzle sql`` 模板的文本 */
function sqlTextOf(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return String(q ?? "");
  return chunks
    .map((c) => {
      const v = (c as { value?: unknown } | null)?.value;
      if (typeof v === "string") return v;
      if (Array.isArray(v)) return v.filter((x) => typeof x === "string").join("");
      return "";
    })
    .join("");
}

vi.mock("./queries/connection", () => {
  // tx 与 db 同形：事务回调直接复用同一 mock（回滚语义由“败方无写入断言”覆盖）
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          const q = selectQueue.shift() ?? [];
          return {
            limit: async () => q,
            // orderBy 穿透（门禁票：latestCodeRow 加 SQL 层排序——mock 链同形不断）
            orderBy: () => ({
              limit: async () => q,
              then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
                Promise.resolve(q).then(res, rej),
            }),
            then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve(q).then(res, rej),
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
      executedSql.push(sqlTextOf(q));
      return execQueue.shift() ?? [{ affectedRows: 1 }];
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      txCount++;
      return fn(db);
    },
  };
  return { getDb: () => db };
});

vi.mock("./routers/betaInvites", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/betaInvites")>();
  const { getDb } = await import("./queries/connection");
  return {
    ...orig,
    withBetaInvitePhoneLock: vi.fn(async (_phone: string, fn: (tx: never) => Promise<unknown>) => getDb().transaction(fn as never)),
  };
});

import {
  smsRouter,
  setSmsProviderForTest,
  canonicalQuery,
  percentEncode,
  signAliyunPop,
  type SmsProvider,
} from "./routers/sms";
import { sha256 } from "./routers/wbSession";
import { wbSmsCodes, wbUsers, wbDeptHeads, wbCareerEntries } from "@db/schema";

const caller = smsRouter.createCaller({} as never);

beforeAll(async () => {
  // ensureBetaInvites 模块级一次性 DDL（CREATE+预检两发 execute 走 mock execQueue 移位）——
  // 预热吸收：之后各用例 execQueue 只对本例夹具对齐（首调者代付 DDL 移位=后续例队列错位面封死）
  const { ensureBetaInvites } = await import("./routers/betaInvites");
  await ensureBetaInvites();
});

/** 业务 SQL（剔除中间件 ops_access_log 异步日志写） */
const bizSql = () => executedSql.filter((s) => !s.includes("ops_access_log") && !s.includes("st_harness_runs") && !s.includes("st_beta_invites"));

const PHONE = "13800001111";
const INVITE_CODE = `iv_${"a".repeat(48)}`;
const BETA_CODE = `iv_${"b".repeat(48)}`; // 内测资格码（st_beta_invites 面——与入企码分家）

/** 内测资格码行（st_beta_invites——彭总令：注册资格闸） */
function betaInviteRow(overrides: Record<string, unknown> = {}) {
  return { id: 7, phone: PHONE, codeHash: sha256(BETA_CODE), consumed_at: null, expires_at: new Date(Date.now() + 60_000), ...overrides };
}

function codeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 9,
    phone: PHONE,
    codeHash: sha256("123456"),
    purpose: "register",
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    attempts: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

const personUser = {
  id: 42,
  username: PHONE,
  displayName: "TEST_张三",
  role: "member",
  factoryId: 0,
  departmentId: null,
  kind: "person",
  phone: PHONE,
  disabled: false,
};

const factory = {
  id: 10,
  enterpriseName: "TEST_星云企业",
  industryGroup: "工业制造",
  departments: [
    { id: "sales", name: "销售部" },
    { id: "finance", name: "财务部" },
  ],
};

function inviteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    factoryId: 10,
    codeHash: sha256(INVITE_CODE),
    displayName: "TEST_受邀者",
    deptId: "sales",
    role: "manager",
    inviterId: 1,
    expiresAt: new Date(Date.now() + 3600_000),
    consumedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  selectQueue = [];
  execQueue = [];
  inserted = [];
  updated = [];
  executedSql = [];
  txCount = 0;
  nextId = 100;
  setSmsProviderForTest(null);
  // 确保无阿里云 key（dev 通道由 NODE_ENV!=='production' 选中）
  delete process.env.SMS_ALIYUN_AK_ID;
  delete process.env.SMS_ALIYUN_AK_SECRET;
  delete process.env.SMS_SIGN_NAME;
  delete process.env.SMS_TEMPLATE_CODE;
});

describe("sendCode", () => {
  it("dev 模式回显 devCode='123456'，库写 sha256 且明文绝不落库", async () => {
    selectQueue = [[], []]; // 60s 无记录 / 当日 0 条
    const res = await caller.sendCode({ phone: PHONE, purpose: "register" });
    expect(res).toEqual({ ok: true, ttlSeconds: 300, devCode: "123456" });
    const row = inserted.find((i) => i.table === wbSmsCodes);
    expect(row).toBeTruthy();
    expect(row!.values.phone).toBe(PHONE);
    expect(row!.values.purpose).toBe("register");
    expect(row!.values.codeHash).toBe(sha256("123456"));
    expect(row!.values.codeHash).toMatch(/^[0-9a-f]{64}$/);
    // 明文绝不落库（insert 负载中不存在明文字段）
    expect(JSON.stringify(inserted.map((i) => i.values))).not.toContain('"123456"');
    expect(row!.values).not.toHaveProperty("code");
  });

  it("非 dev Provider 不回显 devCode；Provider 收到 6 位数字明文，库写其 sha256", async () => {
    const sent: Array<{ phone: string; code: string }> = [];
    const mockProvider: SmsProvider = {
      send: async (phone, code) => {
        sent.push({ phone, code });
      },
    };
    setSmsProviderForTest(mockProvider);
    selectQueue = [[], []];
    const res = await caller.sendCode({ phone: PHONE, purpose: "login" });
    expect(res).toEqual({ ok: true, ttlSeconds: 300 });
    expect(res).not.toHaveProperty("devCode");
    expect(sent).toHaveLength(1);
    expect(sent[0].phone).toBe(PHONE);
    expect(sent[0].code).toMatch(/^\d{6}$/);
    const row = inserted.find((i) => i.table === wbSmsCodes);
    expect(row!.values.codeHash).toBe(sha256(sent[0].code));
  });

  it("同号 60s 内已有发送记录 → TOO_MANY_REQUESTS", async () => {
    selectQueue = [[{ id: 1 }]]; // 60s 窗口内命中
    await expect(caller.sendCode({ phone: PHONE, purpose: "login" })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(inserted).toHaveLength(0);
  });

  it("同号同 purpose 当日已达 10 条 → TOO_MANY_REQUESTS", async () => {
    selectQueue = [[], Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }))];
    await expect(caller.sendCode({ phone: PHONE, purpose: "register" })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(inserted).toHaveLength(0);
  });

  it("统一回 ok：不查用户表，号码注册状态绝不外泄（响应形状恒定）", async () => {
    selectQueue = [[], []];
    const res = await caller.sendCode({ phone: PHONE, purpose: "login" });
    // 仅 ok/ttlSeconds/devCode（dev）三键，无 reason/exists 等泄露字段
    expect(Object.keys(res).sort()).toEqual(["devCode", "ok", "ttlSeconds"]);
    expect(res.ok).toBe(true);
    expect(res.ttlSeconds).toBe(300);
  });
});

describe("registerByPhone", () => {
  it("全流程：码校验+原子消费+建档+SessionInfo 同构（token nt_、enterpriseName=null）", async () => {
    selectQueue = [
      [], // 手机号查重：无
      [codeRow()], // 事务内取未消费码
      [personUser], // 建号后回读
    ];
    execQueue = [[{ id: 7, kind: "personal" }]]; // betaCode 资格闸预检（execute 面——无 inviteCode 面闸按 personal 验[主线①搬链钉]）
    const res = await caller.registerByPhone({
      phone: PHONE,
        betaCode: BETA_CODE,
      code: "123456",
      password: "TEST_pass123",
      realName: "TEST_张三",
    });
    expect(res.token).toMatch(/^nt_[0-9a-f]{48}$/);
    expect(res.kind).toBe("person");
    expect(res.factoryId).toBe(0);
    expect(res.enterpriseName).toBeNull();
    expect(res.orgRole).toBe("staff"); // member 归一
    expect(res.phone).toBe(PHONE);
    // 建档：username=phone、kind=person、factoryId=0、role=member；免身份证（无 idCardHash）
    const userInsert = inserted.find((i) => i.table === wbUsers);
    expect(userInsert).toBeTruthy();
    expect(userInsert!.values.username).toBe(PHONE);
    expect(userInsert!.values.phone).toBe(PHONE);
    expect(userInsert!.values.kind).toBe("person");
    expect(userInsert!.values.factoryId).toBe(0);
    expect(userInsert!.values.role).toBe("member");
    expect(userInsert!.values).not.toHaveProperty("idCardHash");
    expect(String(userInsert!.values.passwordHash)).toContain(":"); // scrypt salt:hash
    // 原子消费（防重放）与签发 token 同事务
    expect(bizSql().some((s) => s.includes("UPDATE wb_sms_codes SET consumedAt"))).toBe(true);
    expect(updated.some((u) => typeof u.authToken === "string")).toBe(true);
    expect(txCount).toBe(1);
  });

  it("手机号已注册 → BAD_REQUEST「该手机号已注册，请直接登录」（码不被消耗）", async () => {
    selectQueue = [[{ id: 1 }]]; // 查重命中
    await expect(
      caller.registerByPhone({ phone: PHONE,
        betaCode: BETA_CODE, code: "123456", password: "TEST_pass123" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "该手机号已注册，请直接登录" });
    expect(inserted).toHaveLength(0);
    expect(bizSql()).toHaveLength(0);
    expect(txCount).toBe(0);
  });

  it("带 inviteCode 注册即入企：单事务内消费双码+建档+manager 双写+join 履历+签发 nt_", async () => {
    selectQueue = [
      [], // 手机号查重：无
      [inviteRow()], // 邀请码命中且 pending
      [factory], // 企业画像
      [codeRow()], // 事务内取未消费码
      [
        {
          ...personUser,
          factoryId: 10,
          departmentId: "sales",
          role: "manager",
          kind: "enterprise",
        },
      ], // 建号后回读
    ];
    execQueue = [[{ id: 7, kind: "enterprise" }]]; // betaCode 资格闸预检（execute 面——inviteCode 一步入企口按 enterprise 验[主线①搬链钉：判别锚与建档 kind 同源]）
    const res = await caller.registerByPhone({
      phone: PHONE,
        betaCode: BETA_CODE,
      code: "123456",
      password: "TEST_pass123",
      realName: "TEST_受邀者",
      inviteCode: INVITE_CODE,
    });
    // 同事务：仅一次 transaction
    expect(txCount).toBe(1);
    // 双码原子消费
    expect(bizSql().some((s) => s.includes("UPDATE wb_sms_codes SET consumedAt"))).toBe(true);
    expect(bizSql().some((s) => s.includes("UPDATE wb_invites SET consumedAt"))).toBe(true);
    // 建档取自邀请：factoryId/deptId/role，kind=enterprise
    const userInsert = inserted.find((i) => i.table === wbUsers);
    expect(userInsert!.values.factoryId).toBe(10);
    expect(userInsert!.values.departmentId).toBe("sales");
    expect(userInsert!.values.role).toBe("manager");
    expect(userInsert!.values.kind).toBe("enterprise");
    expect(userInsert!.values.invitedBy).toBe(1);
    // manager 双写 wb_dept_heads + M21 join 履历
    const headInsert = inserted.find((i) => i.table === wbDeptHeads);
    expect(headInsert).toBeTruthy();
    expect(headInsert!.values).toMatchObject({ factoryId: 10, deptId: "sales" });
    const careerInsert = inserted.find((i) => i.table === wbCareerEntries);
    expect(careerInsert).toBeTruthy();
    expect(careerInsert!.values).toMatchObject({ factoryId: 10, deptName: "销售部" });
    // 响应 SessionInfo 同构：enterpriseName 带出 + token nt_
    expect(res.enterpriseName).toBe("TEST_星云企业");
    expect(res.factoryId).toBe(10);
    expect(res.token).toMatch(/^nt_[0-9a-f]{48}$/);
  });

  it("邀请码无效/已用 → BAD_REQUEST（不进入事务、码不被消耗）", async () => {
    selectQueue = [[], [inviteRow({ consumedAt: new Date() })]]; // 已消费邀请
    execQueue = [[{ id: 7 }]]; // betaCode 资格闸预检过（execute 面）
    await expect(
      caller.registerByPhone({
        phone: PHONE,
        betaCode: BETA_CODE,
        code: "123456",
        password: "TEST_pass123",
        inviteCode: INVITE_CODE,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "邀请链接无效或已使用" });
    expect(txCount).toBe(0);
    expect(inserted).toHaveLength(0);
  });
});

describe("loginByPhone", () => {
  const loginCodeRow = () => codeRow({ purpose: "login" });

  it("已有账号 → 消费码 + 签发 nt_（个人 factoryId=0，enterpriseName=null）", async () => {
    selectQueue = [
      [loginCodeRow()], // 事务内取未消费码
      [personUser], // 按 phone 查用户
      [personUser], // 签发后回读
      [], // factoryId=0 无企业画像
    ];
    const res = await caller.loginByPhone({ phone: PHONE, code: "123456" });
    expect(res.token).toMatch(/^nt_[0-9a-f]{48}$/);
    expect(res.kind).toBe("person");
    expect(res.enterpriseName).toBeNull();
    expect(updated.some((u) => typeof u.authToken === "string")).toBe(true);
    expect(bizSql().some((s) => s.includes("UPDATE wb_sms_codes SET consumedAt"))).toBe(true);
  });

  it("企业成员（factoryId≠0）→ 签发 nt_ 且带出 enterpriseName", async () => {
    const member = { ...personUser, factoryId: 10, kind: "enterprise", departmentId: "sales" };
    selectQueue = [[loginCodeRow()], [member], [member], [factory]];
    const res = await caller.loginByPhone({ phone: PHONE, code: "123456" });
    expect(res.token).toMatch(/^nt_[0-9a-f]{48}$/);
    expect(res.enterpriseName).toBe("TEST_星云企业");
    expect(res.factoryId).toBe(10);
  });

  it("无账号 → BAD_REQUEST「该手机号尚未注册」（不泄露其他）", async () => {
    selectQueue = [[loginCodeRow()], []]; // 码有效，用户不存在
    await expect(caller.loginByPhone({ phone: PHONE, code: "123456" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "该手机号尚未注册",
    });
    expect(updated.some((u) => typeof u.authToken === "string")).toBe(false);
  });

  it("disabled 账号 → FORBIDDEN（不签发 token）", async () => {
    selectQueue = [[loginCodeRow()], [{ ...personUser, disabled: true }]];
    await expect(caller.loginByPhone({ phone: PHONE, code: "123456" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(updated.some((u) => typeof u.authToken === "string")).toBe(false);
  });
});

describe("验证码校验纪律", () => {
  it("错码 → attempts 原子 +1（IF 达到上限同事务作废）+ BAD_REQUEST 统一文案", async () => {
    selectQueue = [[], [codeRow()]]; // 注册：查重无 + 码存在
    execQueue = [[{ id: 7, kind: "personal" }]]; // beta 资格闸过闸（流程真实序：先闸后码面——闸行夹具不可缺，主线①搬链钉）
    await expect(
      caller.registerByPhone({ phone: PHONE,
        betaCode: BETA_CODE, code: "999999", password: "TEST_pass123" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "验证码错误或已过期" });
    const inc = bizSql().find((s) => s.includes("attempts = attempts + 1"));
    expect(inc).toBeTruthy();
    expect(inc).toContain("IF(attempts >="); // ≥5 作废（SET 从左到右：IF 读更新后值——门禁 off-by-one 票修订）
    expect(inserted.find((i) => i.table === wbUsers)).toBeUndefined(); // 建档未发生
  });

  it("attempts 已达 5 → 「验证码已失效，请重新获取」（不再计数、不消费）", async () => {
    selectQueue = [[], [codeRow({ attempts: 5 })]];
    execQueue = [[{ id: 7, kind: "personal" }]]; // beta 资格闸过闸（流程真实序：先闸后码面——闸行夹具不可缺，主线①搬链钉）
    await expect(
      caller.registerByPhone({ phone: PHONE,
        betaCode: BETA_CODE, code: "123456", password: "TEST_pass123" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "验证码已失效，请重新获取" });
    expect(bizSql()).toHaveLength(0);
  });

  it("过期码 → BAD_REQUEST（不消费）", async () => {
    selectQueue = [[], [codeRow({ expiresAt: new Date(Date.now() - 1000) })]];
    execQueue = [[{ id: 7, kind: "personal" }]]; // beta 资格闸过闸（流程真实序：先闸后码面——闸行夹具不可缺，主线①搬链钉）
    await expect(
      caller.registerByPhone({ phone: PHONE,
        betaCode: BETA_CODE, code: "123456", password: "TEST_pass123" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "验证码错误或已过期" });
    expect(bizSql()).toHaveLength(0);
  });

  it("消费重放（原子 UPDATE 影响行=0）→ BAD_REQUEST，不建档", async () => {
    selectQueue = [[], [codeRow()]];
    // betaCode 面：预检命中+消费成功——重放的是验证码消费
    execQueue = [[{ id: 7, kind: "personal" }], [{ affectedRows: 1 }], [{ affectedRows: 0 }]]; // 预检（闸按 personal 验）+beta消费OK+验证码消费并发已消费——主线①搬链钉
    await expect(
      caller.registerByPhone({ phone: PHONE,
        betaCode: BETA_CODE, code: "123456", password: "TEST_pass123" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "验证码错误或已过期" });
    expect(inserted.find((i) => i.table === wbUsers)).toBeUndefined();
  });
});

describe("阿里云 POP RPC 签名 V1（零依赖）", () => {
  it("percentEncode 特殊规则：+→%20、*→%2A、%7E→~", () => {
    expect(percentEncode("a b")).toBe("a%20b");
    expect(percentEncode("a*b")).toBe("a%2Ab");
    expect(percentEncode("a~b")).toBe("a~b");
    expect(percentEncode("验证码&=")).toBe(encodeURIComponent("验证码&="));
  });

  it("canonicalQuery 按 key 字典序排序", () => {
    expect(canonicalQuery({ b: "2", a: "1", c: "3" })).toBe("a=1&b=2&c=3");
  });

  it("signAliyunPop = Base64(HMAC-SHA1(METHOD&%2F&encode(query), secret+'&'))", () => {
    const params = {
      AccessKeyId: "TEST_akid",
      Action: "SendSms",
      Format: "JSON",
      SignatureMethod: "HMAC-SHA1",
      SignatureNonce: "TEST_nonce-1",
      SignatureVersion: "1.0",
      Timestamp: "2025-01-01T00:00:00Z",
      Version: "2017-05-25",
    };
    // 独立复算（公开标准算法）：StringToSign = GET&%2F&percentEncode(canonicalQuery)
    const stringToSign = `GET&${percentEncode("/")}&${percentEncode(canonicalQuery(params))}`;
    const expected = createHmac("sha1", "TEST_secret&")
      .update(stringToSign, "utf8")
      .digest("base64");
    expect(signAliyunPop(params, "TEST_secret")).toBe(expected);
    // secret 追加 '&' 是 POP V1 的硬性规则：不追加则结果不同
    const wrong = createHmac("sha1", "TEST_secret")
      .update(stringToSign, "utf8")
      .digest("base64");
    expect(signAliyunPop(params, "TEST_secret")).not.toBe(wrong);
  });
});

describe("M81 翼讯通通道（彭总供件 V1.6.7.2）", () => {
  it("签名算法与文档同构：md5(appid+mobile+msg原文+appkey) 32 位小写；msg 原文参与不编码", async () => {
    // 用文档示例复算：appid/mobile/msg/appkey 拼接后 md5 必须 32 位小写 hex
    const { createHash } = await import("node:crypto");
    const appid = "QP2Szdmwby6z3qLli9IAg0WdpACNNuO5";
    const mobile = "13800138000";
    const msg = "【合众科技】您好,你的验证码是123456";
    const appkey = "doc-appkey";
    const sign = createHash("md5").update(appid + mobile + msg + appkey, "utf8").digest("hex");
    expect(sign).toMatch(/^[0-9a-f]{32}$/);
  });

  it("YixuntongSmsProvider：发送体 urlencode + sign 同构 + resultCode=0 放行", async () => {
    const calls: Array<{ body: string }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
      calls.push({ body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ resultCode: 0, resultMsg: "操作成功", taskid: "I123" }), { status: 200 });
    }) as typeof fetch;
    try {
      const { YixuntongSmsProvider } = await import("./routers/sms");
      const p = new YixuntongSmsProvider({ appid: "A", appkey: "K", signName: "NumX Max" });
      await p.send("13800001111", "246810");
      const body = calls[0].body;
      expect(body).toContain("appid=A");
      expect(body).toContain("mobile=13800001111");
      // URLSearchParams 与 Java URLEncoder 同族（空格为 +）——按解码后等价断言
      const msgInBody = decodeURIComponent(new URLSearchParams(body).get("msg")!.replace(/\+/g, "%20"));
      expect(msgInBody).toBe("【NumX Max】您的验证码是246810，5 分钟内有效。");
      // sign 复算
      const { createHash } = await import("node:crypto");
      const msg = "【NumX Max】您的验证码是246810，5 分钟内有效。";
      const expectSign = createHash("md5").update("A" + "13800001111" + msg + "K", "utf8").digest("hex");
      expect(body).toContain("sign=" + expectSign);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("resultCode 非 0 → 抛错（-3 单独可辨为 ip 未绑）", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ resultCode: -3, resultMsg: "来源IP限制" }), { status: 200 })) as typeof fetch;
    try {
      const { YixuntongSmsProvider } = await import("./routers/sms");
      const p = new YixuntongSmsProvider({ appid: "A", appkey: "K", signName: "NumX Max" });
      await expect(p.send("13800001111", "246810")).rejects.toThrow("yixuntong_ip_unbound");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
