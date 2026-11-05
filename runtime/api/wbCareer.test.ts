/**
 * M21 数字职业档案（wbCareer）测试（SQL 层 mock，不连库；测试数据 TEST_ 前缀）。
 *
 * 断言（设计 §3/§4/§5 一期）：
 * 1. my：手机号 138****5678 / 身份证 前1***后1 / 实名姓名脱敏；shareMatrix 只计有效授权；
 * 2. share：目标企业不存在 → NOT_FOUND；成功插行；重复共享同 scope 幂等（alreadyShared，不重复插行）；
 * 3. revoke：幂等 ok:true（影响 0 行也 ok）；
 * 4. orgView：撤回后不可见（authorized:false + 该成员未共享档案）；
 * 5. orgView：部分授权只见授权类目（career 键存在、badges 键不存在）；
 * 6. orgView：完全未授权只返回脱敏姓名 + message，绝不输出 phone/idCard/realName；
 * 7. orgView：staff → FORBIDDEN；
 * 8. join 钩子：wbInvites.accept 同事务写 pending 履历；depart 置 departed+endedAt；
 * 9. orgView：跨企业 targetUserId → FORBIDDEN；
 * 10. my.currentFactory：factory 查得到 → 正常返回（role 归一 owner→admin）；
 *     factory 缺失（游离态 factoryId=0 占位）→ null 不抛错。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let selectQueue: Array<Array<Record<string, unknown>>> = [];
let inserted: Array<{ table: unknown; values: Record<string, unknown> }> = [];
let updated: Array<Record<string, unknown>> = [];
let nextId = 100;

vi.mock("./queries/connection", () => {
  // tx 与 db 同形：事务回调直接复用同一 mock（回滚语义由“败方无写入断言”覆盖）
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          const q = selectQueue.shift() ?? [];
          return {
            limit: async () => q,
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
    execute: async () => [{ affectedRows: 1 }],
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return { getDb: () => db };
});

import {
  maskIdCard,
  maskName,
  maskPhone,
  recordCareerEvent,
  wbCareerRouter,
} from "./routers/wbCareer";
import { wbInvitesRouter } from "./routers/wbInvites";
import { wbCareerEntries, wbCareerShares, wbUsers } from "@db/schema";

const career = wbCareerRouter.createCaller({} as never);
const invites = wbInvitesRouter.createCaller({} as never);

const factory = {
  id: 10,
  enterpriseName: "TEST_星云企业",
  departments: [
    { id: "sales", name: "销售部" },
    { id: "finance", name: "财务部" },
  ],
};
const personUser = {
  id: 2,
  username: "TEST_emp",
  displayName: "TEST_员工",
  realName: "张三丰",
  role: "staff",
  factoryId: 10,
  departmentId: "sales",
  phone: "13812345678",
  idCardMasked: "1101**********1234",
  kind: "person",
};
const adminUser = {
  id: 1,
  username: "TEST_boss",
  displayName: "TEST_老板",
  role: "owner",
  factoryId: 10,
  departmentId: null,
};
const managerUser = {
  id: 3,
  username: "TEST_mgr",
  displayName: "TEST_负责人",
  role: "manager",
  factoryId: 10,
  departmentId: "sales",
};

const past = () => new Date(Date.now() - 3600_000);

function entryRow(over: Record<string, unknown> = {}) {
  return {
    id: 21,
    userId: 2,
    factoryId: 10,
    deptName: "销售部",
    role: "staff",
    startedAt: past(),
    endedAt: null,
    status: "confirmed",
    createdAt: past(),
    ...over,
  };
}
function badgeRow(over: Record<string, unknown> = {}) {
  return {
    id: 31,
    userId: 2,
    skillKey: "welding-l2",
    name: "焊接二级",
    factoryId: 10,
    issuedAt: past(),
    ...over,
  };
}
function shareRow(over: Record<string, unknown> = {}) {
  return {
    id: 41,
    userId: 2,
    targetFactoryId: 10,
    scope: "career",
    createdAt: past(),
    revokedAt: null,
    ...over,
  };
}

beforeEach(() => {
  selectQueue = [];
  inserted = [];
  updated = [];
  nextId = 100;
});

describe("脱敏口径", () => {
  it("手机号 138****5678；身份证 前1***后1；姓名 前1字+*", () => {
    expect(maskPhone("13812345678")).toBe("138****5678");
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone("123")).toBe("1****"); // 异常短号也不回明文
    expect(maskIdCard("1101**********1234")).toBe("1***4");
    expect(maskIdCard(null)).toBeNull();
    expect(maskName("张三丰")).toBe("张**");
    expect(maskName("")).toBe("*");
  });
});

describe("career.my", () => {
  it("档案 = 脱敏实名 + 履历 + 徽章 + 授权矩阵（矩阵只计有效授权，且绝不回明文）", async () => {
    selectQueue.push(
      [personUser],
      [factory],
      [entryRow(), entryRow({ id: 22, factoryId: 20, status: "departed", endedAt: past() })],
      [badgeRow()],
      [shareRow(), shareRow({ id: 42, scope: "badges", revokedAt: past() })],
    );
    const res = await career.my({ token: "nt_p" });
    expect(res.profile.phoneMasked).toBe("138****5678");
    expect(res.profile.idCardMasked).toBe("1***4");
    expect(res.profile.realNameMasked).toBe("张**");
    expect(res.profile.displayName).toBe("TEST_员工"); // 本人看自己 displayName 不脱敏
    expect(res.entries).toHaveLength(2);
    expect(res.entries[0].entryId).toBe(22); // 倒序
    expect(res.badges[0].skillKey).toBe("welding-l2");
    // 矩阵：career 有效，badges 已撤回 → false
    expect(res.shareMatrix["10"]).toEqual({
      career: true,
      badges: false,
      achievements: false,
      proof: false,
    });
    expect(res.shares).toHaveLength(2); // shares 全量含撤回审计行
    // currentFactory：factory 查得到 → 正常返回（staff 归一原样）
    expect(res.currentFactory).toEqual({
      factoryId: 10,
      enterpriseName: "TEST_星云企业",
      role: "staff",
    });
    const json = JSON.stringify(res);
    expect(json).not.toContain("13812345678");
    expect(json).not.toContain("1101**********1234");
    expect(json).not.toContain("张三丰");
  });

  it("currentFactory：role 归一（owner→admin，与 sessionInfo orgRole 同口径）", async () => {
    selectQueue.push(
      [adminUser], // role=owner
      [factory],
      [], // entries
      [], // badges
      [], // shares
    );
    const res = await career.my({ token: "nt_a" });
    expect(res.currentFactory).toEqual({
      factoryId: 10,
      enterpriseName: "TEST_星云企业",
      role: "admin", // owner 归一为 admin
    });
  });

  it("currentFactory：factory 缺失（游离态 factoryId=0 占位）→ null 不抛错，档案其余字段照常", async () => {
    // registerPerson 形态个人账号：factoryId=0，wb_factories 无对应行
    selectQueue.push(
      [{ ...personUser, id: 9, factoryId: 0 }],
      [], // factory 查不到
      [entryRow({ userId: 9, factoryId: 0 })],
      [],
      [],
    );
    const res = await career.my({ token: "nt_free" });
    expect(res.currentFactory).toBeNull(); // 不抛错，游离态为 null
    expect(res.profile.userId).toBe(9);
    expect(res.entries).toHaveLength(1);
  });
});

describe("career.share（C 级，幂等）", () => {
  it("目标企业不存在 → NOT_FOUND；成功插行；重复共享同 scope 幂等不重复插行", async () => {
    // 目标企业不存在
    selectQueue.push([personUser], [factory], []);
    await expect(
      career.share({ token: "nt_p", targetFactoryId: 999, scopes: ["career"] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // 首次共享 career+badges：均无有效授权 → 各插一行
    selectQueue.push([personUser], [factory], [{ id: 10 }], [], []);
    const first = await career.share({
      token: "nt_p",
      targetFactoryId: 10,
      scopes: ["career", "badges", "career"], // 入参重复也幂等
    });
    expect(first.ok).toBe(true);
    expect(first.shared).toEqual(["career", "badges"]);
    expect(first.alreadyShared).toEqual([]);
    const shareInserts = inserted.filter((r) => r.table === wbCareerShares);
    expect(shareInserts).toHaveLength(2);
    expect(shareInserts[0].values).toMatchObject({ userId: 2, targetFactoryId: 10, scope: "career" });

    // 重复共享 career：已有有效授权 → alreadyShared，不重复插行
    inserted = [];
    selectQueue.push([personUser], [factory], [{ id: 10 }], [shareRow()]);
    const again = await career.share({ token: "nt_p", targetFactoryId: 10, scopes: ["career"] });
    expect(again.shared).toEqual([]);
    expect(again.alreadyShared).toEqual(["career"]);
    expect(inserted.filter((r) => r.table === wbCareerShares)).toHaveLength(0);
  });
});

describe("career.revoke（C 级，幂等）", () => {
  it("撤回置 revokedAt；重复撤回（影响 0 行）也 ok:true", async () => {
    selectQueue.push([personUser], [factory]);
    const first = await career.revoke({ token: "nt_p", targetFactoryId: 10, scope: "career" });
    expect(first).toEqual({ ok: true });
    expect(updated.some((v) => v.revokedAt instanceof Date)).toBe(true);

    selectQueue.push([personUser], [factory]);
    const again = await career.revoke({ token: "nt_p", targetFactoryId: 10, scope: "career" });
    expect(again).toEqual({ ok: true }); // 幂等：本就无有效授权也 ok
  });
});

describe("career.orgView（企业侧）", () => {
  it("部分授权只见授权类目：career 键存在、badges 键不存在；scopes 标记正确", async () => {
    selectQueue.push(
      [adminUser],
      [factory],
      [personUser], // target
      [shareRow()], // 仅 career 有效
      [entryRow()], // career 类目数据
    );
    const res = await career.orgView({ token: "nt_a", targetUserId: 2 });
    expect(res.authorized).toBe(true);
    expect(res.message).toBeNull();
    expect(res.scopes).toEqual({
      career: { authorized: true },
      badges: { authorized: false },
      achievements: { authorized: false },
      proof: { authorized: false },
    });
    expect(res).toHaveProperty("career");
    expect((res as { career: unknown[] }).career).toHaveLength(1);
    expect(res).not.toHaveProperty("badges"); // 未授权类目键不存在，不是空数组
    expect(JSON.stringify(res)).not.toContain("13812345678"); // 档案里绝不带手机号
  });

  it("撤回后不可见 + 完全未授权：只返回脱敏姓名 + 「该成员未共享档案」", async () => {
    // 撤回：SQL isNull 过滤之外 JS 侧再兜底（mock 直接返回带 revokedAt 的行验证兜底）
    selectQueue.push([adminUser], [factory], [personUser], [shareRow({ revokedAt: past() })]);
    const revoked = await career.orgView({ token: "nt_a", targetUserId: 2 });
    expect(revoked.authorized).toBe(false);
    expect(revoked.message).toBe("该成员未共享档案");
    expect(revoked.displayNameMasked).toBe("T******");
    expect(revoked).not.toHaveProperty("career");
    expect(revoked).not.toHaveProperty("badges");
    const json = JSON.stringify(revoked);
    expect(json).not.toContain("13812345678");
    expect(json).not.toContain("1101**********1234");
    expect(json).not.toContain("张三丰"); // realName 绝不输出
    expect(json).not.toContain("TEST_员工"); // 姓名恒脱敏

    // 完全无授权行
    selectQueue.push([managerUser], [factory], [personUser], []);
    const none = await career.orgView({ token: "nt_m", targetUserId: 2 });
    expect(none.authorized).toBe(false);
    expect(none.message).toBe("该成员未共享档案");
  });

  it("staff → FORBIDDEN；跨企业 targetUserId → FORBIDDEN", async () => {
    // staff：effectiveRoleOf 会查 wb_dept_heads（空 → 仍 staff）
    selectQueue.push(
      [{ ...personUser, id: 5, realName: null, phone: null, idCardMasked: null }],
      [factory],
      [], // dept_heads 未命中
    );
    await expect(career.orgView({ token: "nt_s", targetUserId: 2 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // 跨企业：target 属 factory 20，caller 属 factory 10 → FORBIDDEN（不泄露存在性）
    selectQueue.push([adminUser], [factory], [{ ...personUser, factoryId: 20 }]);
    await expect(career.orgView({ token: "nt_a", targetUserId: 2 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("recordCareerEvent 钩子", () => {
  it("join：wbInvites.accept 同事务写 pending 履历（deptName/role 快照）", async () => {
    const code = `iv_${"c".repeat(48)}`;
    const invite = {
      id: 7,
      factoryId: 10,
      codeHash: "h".repeat(64),
      displayName: "TEST_新人",
      deptId: "finance",
      role: "staff",
      inviterId: 1,
      expiresAt: new Date(Date.now() + 72 * 3600_000),
      consumedAt: null,
      revokedAt: null,
      createdAt: past(),
    };
    const newUser = {
      id: 100,
      username: "TEST_newbie",
      displayName: "TEST_新人",
      role: "staff",
      factoryId: 10,
      departmentId: "finance",
      kind: "person",
    };
    selectQueue.push([invite], [factory], [], [newUser]);
    const res = await invites.accept({ code, username: "TEST_newbie", password: "passw0rd!x" });
    expect(res.token).toMatch(/^nt_[0-9a-f]{48}$/);
    // join 钩子：同事务插入 pending 履历
    const entryInsert = inserted.find((r) => r.table === wbCareerEntries);
    expect(entryInsert).toBeTruthy();
    expect(entryInsert!.values).toMatchObject({
      userId: 100,
      factoryId: 10,
      deptName: "财务部",
      role: "staff",
      status: "pending", // 待本人确认
    });
    expect(entryInsert!.values.startedAt).toBeInstanceOf(Date);
  });

  it("depart：最新在职履历置 departed+endedAt；无在职履历幂等 no-op", async () => {
    selectQueue.push([entryRow({ id: 21, status: "confirmed" }), entryRow({ id: 9, status: "departed", endedAt: past() })]);
    const res = await recordCareerEvent(2, 10, "depart");
    expect(res).toEqual({ ok: true, entryId: 21 }); // 最新一条在职
    expect(updated.some((v) => v.status === "departed" && v.endedAt instanceof Date)).toBe(true);

    updated = [];
    selectQueue.push([entryRow({ status: "departed", endedAt: past() })]);
    const again = await recordCareerEvent(2, 10, "depart");
    expect(again).toEqual({ ok: true, entryId: null });
    expect(updated).toHaveLength(0);
  });
});
