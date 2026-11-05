/**
 * M16 组织邀请（wbInvites）测试（SQL 层 mock，不连库；测试数据 TEST_ 前缀）。
 *
 * 断言（设计 §6 wbInvites + 回归）：
 * 4. create：非 admin → FORBIDDEN；deptId 不在 factory.departments → BAD_REQUEST；
 *    同 displayName+deptId 未消耗 → BAD_REQUEST；成功返回 iv_ 明文且库写 sha256（64 hex，明文不入库）；
 * 5. list：staff → FORBIDDEN；manager 自动收敛本部门且脱敏（无 inviterName，输出绝不含 code/codeHash）；
 * 6. revoke：非本企业 inviteId → NOT_FOUND；重复吊销幂等 ok；已使用不可吊销；
 * 7. peek：不存在/过期/已用/吊销 → valid:false 且不泄露企业名（valid 对照组返回预填信息）；
 * 8. accept：成功建号（role/deptId/invitedBy/activatedAt）+ manager 双写 wb_dept_heads + nt_ token；
 *    并发抢用（UPDATE 影响行=0）→ CONFLICT；username 重复 → BAD_REQUEST；已用码 → BAD_REQUEST；
 * 9. 回归：sessionInfo 带 orgRole；存量 role='owner' 用户 authMe 归一为 admin；member 归一 staff。
 * 10. accept token 分支（M22 已登录个人入企）：成功落编（原子 UPDATE wb_users + manager 双写 +
 *    join 履历，不签发新 token）；factoryId≠0 → CONFLICT 且码未消耗；并发抢用/并发重复入企 →
 *    CONFLICT；无效 token → UNAUTHORIZED；staff 邀请无双写。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let selectQueue: Array<Array<Record<string, unknown>>> = [];
let execQueue: unknown[] = [];
let inserted: Array<{ table: unknown; values: Record<string, unknown> }> = [];
let updated: Array<Record<string, unknown>> = [];
let executedSql: string[] = [];
let nextId = 100;

/** 提取 drizzle sql`` 模板的文本（区分业务 SQL 与中间件 ops_access_log 日志写） */
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
            // drizzle 查询构建器是 thenable：无 .limit 的 select 直接 await
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
      const t = sqlTextOf(q);
      executedSql.push(t);
      // qr 第三轨分流（portal#86 钉随迁[wb#70 同律]：扫码会话查询不属本件面——返空=无 qr 会话，不吃 execQueue 脚本位）
      if (t.includes("st_qr_sessions")) return [[]];
      return execQueue.shift() ?? [{ affectedRows: 1 }];
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return { getDb: () => db };
});

import { wbInvitesRouter, WB_INVITE_CREATE_LIMIT } from "./routers/wbInvites";
import { agenticRouter } from "./routers/agentic";
import { sessionInfo, sha256 } from "./routers/wbSession";
import { authTokenHash } from "./auth/revocation"; // P3-6 指纹断言面同引
import { wbUsers, wbDeptHeads, wbInvites, wbCareerEntries } from "@db/schema";

const caller = wbInvitesRouter.createCaller({} as never);
const agentic = agenticRouter.createCaller({} as never);

const factory = {
  id: 10,
  enterpriseName: "TEST_星云企业",
  departments: [
    { id: "sales", name: "销售部" },
    { id: "finance", name: "财务部" },
  ],
};
const adminUser = { id: 1, username: "TEST_boss", displayName: "TEST_老板", role: "owner", factoryId: 10, departmentId: null };
const staffUser = { id: 2, username: "TEST_emp", displayName: "TEST_员工", role: "staff", factoryId: 10, departmentId: "sales" };
const managerUser = { id: 3, username: "TEST_mgr", displayName: "TEST_负责人", role: "manager", factoryId: 10, departmentId: "sales" };

const future = () => new Date(Date.now() + 72 * 3600_000);
const past = () => new Date(Date.now() - 3600_000);

function inviteRow(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    factoryId: 10,
    codeHash: "h".repeat(64),
    displayName: "TEST_新人",
    deptId: "finance",
    role: "manager",
    inviterId: 1,
    expiresAt: future(),
    consumedAt: null,
    revokedAt: null,
    createdAt: new Date(),
    ...over,
  };
}

beforeEach(() => {
  selectQueue = [];
  execQueue = [];
  inserted = [];
  updated = [];
  executedSql = [];
  nextId = 100;
});

describe("invites.create", () => {
  it("非 admin → FORBIDDEN；非法 deptId / 重名未消耗 → BAD_REQUEST；成功返回 iv_ 明文且库只存 sha256", async () => {
    // staff（非负责人）→ FORBIDDEN
    selectQueue.push([staffUser], [factory], []);
    await expect(
      caller.create({ token: "nt_s", displayName: "TEST_甲", deptId: "sales", role: "staff" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // deptId 不在企业部门中 → BAD_REQUEST
    selectQueue.push([adminUser], [factory]);
    await expect(
      caller.create({ token: "nt_a", displayName: "TEST_甲", deptId: "ghost", role: "staff" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // 同 displayName+deptId 未消耗邀请存在 → BAD_REQUEST（幂等防重）
    selectQueue.push([adminUser], [factory], [inviteRow({ deptId: "sales", displayName: "TEST_甲" })]);
    await expect(
      caller.create({ token: "nt_a", displayName: "TEST_甲", deptId: "sales", role: "staff" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // 成功路径：明文 iv_+48hex 仅响应出现；库写 sha256
    selectQueue.push([adminUser], [factory], []);
    const res = await caller.create({
      token: "nt_a",
      displayName: "TEST_乙",
      deptId: "sales",
      role: "manager",
    });
    expect(res.code).toMatch(/^iv_[0-9a-f]{48}$/);
    expect(res.inviteUrl).toBe(`/wb/invite?code=${res.code}`);
    expect(res.deptName).toBe("销售部");
    expect(res.role).toBe("manager");
    expect(new Date(res.expiresAt).getTime()).toBeGreaterThan(Date.now() + 71 * 3600_000);
    const invInsert = inserted.find((r) => r.table === wbInvites);
    expect(invInsert).toBeTruthy();
    expect(invInsert!.values.codeHash).toBe(sha256(res.code));
    expect(String(invInsert!.values.codeHash)).toHaveLength(64);
    expect(JSON.stringify(invInsert!.values)).not.toContain(res.code); // 明文绝不落库
    expect(invInsert!.values.role).toBe("manager");
    expect(invInsert!.values.inviterId).toBe(1);
  });

  it("闸开钉（彭总 2026-10-15 令——wb#83 同形搬入）：manager 邀进本部门=放行；跨部门=FORBIDDEN；manager 签 manager=FORBIDDEN；staff=FORBIDDEN", async () => {
    // manager 本部门（managerUser.departmentId='sales'）→ 放行签发
    selectQueue.push([managerUser], [factory], [], [{ count: 0 }]);
    const res = await caller.create({ token: "nt_m", displayName: "TEST_丙", deptId: "sales", role: "staff" });
    expect(res.code).toMatch(/^iv_[0-9a-f]{48}$/);
    expect(inserted.filter((r) => r.table === wbInvites)[0].values.inviterId).toBe(3);

    // manager 跨部门（finance≠sales）→ FORBIDDEN
    selectQueue.push([managerUser], [factory]);
    await expect(
      caller.create({ token: "nt_m", displayName: "TEST_丁", deptId: "finance", role: "staff" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // 权限后果钉：manager 签 role:'manager' → FORBIDDEN（任命同级负责人=权限授予仅 admin）
    selectQueue.push([managerUser], [factory]);
    await expect(
      caller.create({ token: "nt_m", displayName: "TEST_己", deptId: "sales", role: "manager" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "任命部门负责人需企业负责人签发" });

    // staff 本部门 → FORBIDDEN
    selectQueue.push([staffUser], [factory]);
    await expect(
      caller.create({ token: "nt_s", displayName: "TEST_戊", deptId: "sales", role: "staff" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("限频：本企业 60s 内已有 20 个邀请 → TOO_MANY_REQUESTS「操作太频繁，请稍后再试」，不落新邀请；未达上限不误伤", async () => {
    // 触发：角色/部门/幂等预检全过，限频计数命中上限 → 拒且不插入
    selectQueue.push([adminUser], [factory], [], [{ count: WB_INVITE_CREATE_LIMIT }]);
    await expect(
      caller.create({ token: "nt_a", displayName: "TEST_丙", deptId: "sales", role: "staff" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: "操作太频繁，请稍后再试" });
    expect(inserted.find((r) => r.table === wbInvites)).toBeUndefined();

    // 不误伤：窗口内 19 个（未达上限）正常创建
    selectQueue.push([adminUser], [factory], [], [{ count: WB_INVITE_CREATE_LIMIT - 1 }]);
    const res = await caller.create({
      token: "nt_a",
      displayName: "TEST_丁",
      deptId: "sales",
      role: "staff",
    });
    expect(res.code).toMatch(/^iv_[0-9a-f]{48}$/);
    expect(inserted.find((r) => r.table === wbInvites)).toBeTruthy();
  });
});

describe("invites.list", () => {
  it("staff → FORBIDDEN；manager 收敛本部门且脱敏（无 code/codeHash/inviterName）；admin 全量含 inviterName", async () => {
    // staff → FORBIDDEN
    selectQueue.push([staffUser], [factory], []);
    await expect(caller.list({ token: "nt_s" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // manager：即使传跨部门 deptId 也自动收敛本部门（WHERE 强制），输出脱敏
    selectQueue.push(
      [managerUser],
      [factory],
      [inviteRow({ id: 11, deptId: "sales", displayName: "TEST_丙", role: "staff" })],
    );
    const rows = await caller.list({ token: "nt_m", deptId: "finance" });
    expect(rows).toHaveLength(1);
    expect(rows[0].deptId).toBe("sales");
    expect(rows[0].inviterName).toBeNull(); // manager 脱敏
    const json = JSON.stringify(rows);
    expect(json).not.toContain("codeHash");
    expect(json).not.toContain("iv_");

    // admin：全量 + inviterName
    selectQueue.push(
      [adminUser],
      [factory],
      [inviteRow({ id: 12, displayName: "TEST_丁" })],
      [{ id: 1, displayName: "TEST_老板" }], // inviters
    );
    const adminRows = await caller.list({ token: "nt_a" });
    expect(adminRows[0].inviterName).toBe("TEST_老板");
    expect(adminRows[0].status).toBe("pending");
    expect(adminRows[0].deptName).toBe("财务部");
  });
});

describe("invites.revoke", () => {
  it("非本企业 → NOT_FOUND；重复吊销幂等；已使用 → BAD_REQUEST；待使用 → 吊销成功", async () => {
    // 非本企业 / 不存在 → NOT_FOUND
    selectQueue.push([adminUser], [factory], []);
    await expect(caller.revoke({ token: "nt_a", inviteId: 999 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    // 已吊销 → 幂等 ok（不再写库）
    selectQueue.push([adminUser], [factory], [inviteRow({ revokedAt: past() })]);
    const again = await caller.revoke({ token: "nt_a", inviteId: 7 });
    expect(again).toEqual({ ok: true, inviteId: 7 });
    expect(updated).toHaveLength(0);

    // 已使用 → BAD_REQUEST
    selectQueue.push([adminUser], [factory], [inviteRow({ consumedAt: past() })]);
    await expect(caller.revoke({ token: "nt_a", inviteId: 7 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });

    // 待使用 → 吊销成功（写 revokedAt）
    selectQueue.push([adminUser], [factory], [inviteRow()]);
    const ok = await caller.revoke({ token: "nt_a", inviteId: 7 });
    expect(ok).toEqual({ ok: true, inviteId: 7 });
    expect(updated.some((v) => v.revokedAt instanceof Date)).toBe(true);
  });
});

describe("invites.peek（公开）", () => {
  it("有效码返回预填信息；不存在/过期/已用/吊销 → valid:false 不泄露企业名", async () => {
    // 有效对照组
    selectQueue.push([inviteRow()], [factory]);
    const ok = await caller.peek({ code: `iv_${"a".repeat(48)}` });
    expect(ok).toMatchObject({
      valid: true,
      enterpriseName: "TEST_星云企业",
      displayName: "TEST_新人",
      deptName: "财务部",
      role: "manager",
    });

    // 不存在 / 过期 / 已用 / 吊销 → 统一 valid:false，无企业名
    const invalidRows = [
      [],
      [inviteRow({ expiresAt: past() })],
      [inviteRow({ consumedAt: past() })],
      [inviteRow({ revokedAt: past() })],
    ];
    for (const rows of invalidRows) {
      selectQueue.push(rows as Array<Record<string, unknown>>);
      const res = await caller.peek({ code: `iv_${"b".repeat(48)}` });
      expect(res.valid).toBe(false);
      expect(res).not.toHaveProperty("enterpriseName");
    }
  });
});

describe("invites.accept（公开，一次性）", () => {
  it("成功建号 + manager 双写 wb_dept_heads + 签发 nt_；并发抢用 → CONFLICT；username 重复/已用码 → BAD_REQUEST", async () => {
    const code = `iv_${"c".repeat(48)}`;
    // 成功路径：码校验 → 企业 → 用户名查重 → 建号 → 双写 → 原子消费 → 重颁 token → 读回用户
    const newUser = {
      id: 100,
      username: "TEST_newbie",
      displayName: "TEST_新人",
      role: "manager",
      factoryId: 10,
      departmentId: "finance",
      kind: "enterprise",
    };
    selectQueue.push([inviteRow()], [factory], [], [newUser]);
    const res = await caller.accept({ code, username: "TEST_newbie", password: "passw0rd!x" });
    expect(res.token).toMatch(/^nt_[0-9a-f]{48}$/);
    expect(res.orgRole).toBe("manager");
    expect(res.enterpriseName).toBe("TEST_星云企业");
    expect(res.deptName).toBe("财务部");
    expect(res.departmentId).toBe("finance");
    // 建号字段：role/deptId/invitedBy/activatedAt 审计
    const userInsert = inserted.find((r) => r.table === wbUsers);
    expect(userInsert).toBeTruthy();
    expect(userInsert!.values.role).toBe("manager");
    expect(userInsert!.values.departmentId).toBe("finance");
    expect(userInsert!.values.invitedBy).toBe(1);
    expect(userInsert!.values.activatedAt).toBeInstanceOf(Date);
    expect(userInsert!.values.kind).toBe("enterprise");
    // manager 双写 wb_dept_heads
    const headInsert = inserted.find((r) => r.table === wbDeptHeads);
    expect(headInsert).toBeTruthy();
    expect(headInsert!.values.userId).toBe(100);
    expect(headInsert!.values.deptId).toBe("finance");
    // nt_ token 同事务落库（单点有效）：成功路径 tx.update authToken 与响应 token 一致
    expect(updated.some((v) => v.authToken === authTokenHash(res.token as string))).toBe(true); // P3-6 指纹化：库值=authTokenHash(响应 token)（明文断言已随指纹化失效——wb 同义面）

    // 并发抢用：原子 UPDATE 影响行=0 → CONFLICT，且事务回滚无任何 wb_users/dept_heads 残留
    inserted = [];
    selectQueue = []; // 前段成功路径留有未消费队列项，逐段子用例重置防串扰
    execQueue = [];
    selectQueue.push([inviteRow()], [factory], []);
    execQueue.push([{ affectedRows: 0 }]);
    await expect(
      caller.accept({ code, username: "TEST_newbie2", password: "passw0rd!x" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(inserted.find((r) => r.table === wbUsers)).toBeUndefined(); // 败方无孤立用户行（F1）
    expect(inserted.find((r) => r.table === wbDeptHeads)).toBeUndefined();

    // username 重复 → BAD_REQUEST
    selectQueue = [];
    selectQueue.push([inviteRow()], [factory], [{ id: 55 }]);
    await expect(
      caller.accept({ code, username: "TEST_dup", password: "passw0rd!x" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "用户名已存在" });

    // 已用码 → BAD_REQUEST（不泄露具体原因）
    selectQueue = [];
    selectQueue.push([inviteRow({ consumedAt: past() })]);
    await expect(
      caller.accept({ code, username: "TEST_late", password: "passw0rd!x" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "邀请链接无效或已使用" });
  });
});

describe("invites.accept（M22 token 分支：已登录个人账号入企）", () => {
  const personUser = {
    id: 50,
    username: "13800001111",
    displayName: "TEST_游离个人",
    role: "member",
    factoryId: 0, // 占位：游离个人
    departmentId: null,
    kind: "person",
  };
  const joinedUser = {
    ...personUser,
    factoryId: 10,
    departmentId: "finance",
    role: "manager",
    activatedAt: new Date(),
  };

  it("成功入企：factoryId/dept/role 落库 + manager 双写 wb_dept_heads + join 履历；不签发新 token（原 token 回传）", async () => {
    const code = `iv_${"d".repeat(48)}`;
    // 码校验 → 企业 → authToken 取用户 → 事务内身份复核 → 事务后读回
    selectQueue.push([inviteRow()], [factory], [personUser], [personUser], [joinedUser]);
    const res = await caller.accept({ code, token: "nt_person" });
    expect(res).toMatchObject({ ok: true }); // token 分支响应含 ok:true
    expect(res.token).toBe("nt_person"); // 原 token 继续有效，不签发新 token
    expect(res.orgRole).toBe("manager");
    expect(res.enterpriseName).toBe("TEST_星云企业");
    expect(res.deptName).toBe("财务部");
    expect(res.departmentId).toBe("finance");
    // manager 双写 wb_dept_heads
    const headInsert = inserted.find((r) => r.table === wbDeptHeads);
    expect(headInsert).toBeTruthy();
    expect(headInsert!.values).toMatchObject({ factoryId: 10, deptId: "finance", userId: 50 });
    // M21 join 履历钩子（pending，同事务）
    const careerInsert = inserted.find((r) => r.table === wbCareerEntries);
    expect(careerInsert).toBeTruthy();
    expect(careerInsert!.values).toMatchObject({
      userId: 50,
      factoryId: 10,
      deptName: "财务部",
      role: "manager",
      status: "pending",
    });
    // 原子消费 + 原子落编均执行（UPDATE wb_invites / UPDATE wb_users，中间件 access log 不计）
    expect(executedSql.some((t) => t.includes("UPDATE wb_invites SET consumedAt"))).toBe(true);
    expect(executedSql.some((t) => t.includes("UPDATE wb_users SET factoryId"))).toBe(true);
    // 不建号、不发新 token：无 wb_users insert、无 authToken update
    expect(inserted.find((r) => r.table === wbUsers)).toBeUndefined();
    expect(updated.some((v) => typeof v.authToken === "string")).toBe(false);
    // 响应绝不泄露码细节
    expect(JSON.stringify(res)).not.toContain("codeHash");
    expect(JSON.stringify(res)).not.toContain("iv_");
  });

  it("factoryId≠0（已在企业）→ CONFLICT「你已在企业中，如需换企业请先离职」，码未被消耗", async () => {
    const code = `iv_${"e".repeat(48)}`;
    selectQueue.push([inviteRow()], [factory], [{ ...personUser, factoryId: 10 }]);
    await expect(caller.accept({ code, token: "nt_incorp" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "你已在企业中，如需换企业请先离职",
    });
    // 身份校验先于消费：消费/落编 UPDATE 均未执行，码不被消耗
    expect(executedSql.some((t) => t.includes("UPDATE wb_invites"))).toBe(false);
    expect(executedSql.some((t) => t.includes("UPDATE wb_users"))).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it("并发抢用：原子消费影响行=0 → CONFLICT，无双写/履历残留", async () => {
    const code = `iv_${"f".repeat(48)}`;
    selectQueue.push([inviteRow()], [factory], [personUser], [personUser]);
    execQueue.push([{ affectedRows: 0 }]); // 并发败方
    await expect(caller.accept({ code, token: "nt_person" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "邀请已被使用或已过期，请联系管理员重新邀请",
    });
    expect(inserted.find((r) => r.table === wbDeptHeads)).toBeUndefined();
    expect(inserted.find((r) => r.table === wbCareerEntries)).toBeUndefined();
  });

  it("并发重复入企：原子落编（WHERE factoryId=0）影响行=0 → CONFLICT，履历不回落", async () => {
    const code = `iv_${"0".repeat(48)}`;
    selectQueue.push([inviteRow()], [factory], [personUser], [personUser]);
    execQueue.push([{ affectedRows: 1 }], [{ affectedRows: 0 }]); // 消费成功、落编败北
    await expect(caller.accept({ code, token: "nt_person" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "你已在企业中，如需换企业请先离职",
    });
    expect(inserted.find((r) => r.table === wbCareerEntries)).toBeUndefined();
  });

  it("无效 token → UNAUTHORIZED，码未被消耗；staff 邀请无双写", async () => {
    const code = `iv_${"1".repeat(48)}`;
    selectQueue.push([inviteRow()], [factory], []); // authToken 查无用户
    await expect(caller.accept({ code, token: "nt_bad" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "token 无效或已过期",
    });
    // 未进入事务：消费/落编 UPDATE 均未执行，码不被消耗
    expect(executedSql.some((t) => t.includes("UPDATE wb_invites"))).toBe(false);
    expect(inserted).toHaveLength(0);

    // staff 角色邀请：落编成功但不双写 wb_dept_heads
    selectQueue = [];
    execQueue = [];
    inserted = [];
    selectQueue.push(
      [inviteRow({ role: "staff" })],
      [factory],
      [personUser],
      [personUser],
      [{ ...joinedUser, role: "staff" }],
    );
    const res = await caller.accept({ code, token: "nt_person" });
    expect(res).toMatchObject({ ok: true });
    expect(res.orgRole).toBe("staff");
    expect(inserted.find((r) => r.table === wbDeptHeads)).toBeUndefined();
    expect(inserted.find((r) => r.table === wbCareerEntries)).toBeTruthy();
  });
});

describe("orgMembers 收紧（M16 安全修复，reviewer-gate F4）", () => {
  it("异企业 factoryId 入参 → FORBIDDEN", async () => {
    selectQueue.push([{ ...adminUser, factoryId: 10 }], [factory]);
    await expect(agentic.orgMembers({ token: "nt_a", factoryId: 999 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("无效 token → UNAUTHORIZED（不再按 factoryId 公开）", async () => {
    selectQueue.push([]); // sessionMe 查无用户
    await expect(agentic.orgMembers({ token: "nt_bad", factoryId: 10 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("M16 回归：orgRole 输出与存量角色归一", () => {
  it("sessionInfo 带 orgRole；存量 owner/member 用户 authMe 归一为 admin/staff", () => {
    const info = sessionInfo(
      { ...adminUser, role: "owner" } as never,
      factory as never,
      "nt_x",
    );
    expect(info.role).toBe("owner"); // 原字段保留，旧前端不炸
    expect(info.orgRole).toBe("admin"); // 新字段归一
  });

  it("authMe：存量 role='owner' → orgRole=admin；role='member' → orgRole=staff", async () => {
    selectQueue.push([{ ...adminUser, kind: "enterprise" }], [factory]);
    const meOwner = await agentic.authMe({ token: "nt_owner" });
    expect(meOwner?.user.role).toBe("owner");
    expect(meOwner?.user.orgRole).toBe("admin");

    selectQueue.push([{ ...staffUser, role: "member", kind: "enterprise" }], [factory]);
    const meMember = await agentic.authMe({ token: "nt_member" });
    expect(meMember?.user.role).toBe("member");
    expect(meMember?.user.orgRole).toBe("staff");
  });
});
