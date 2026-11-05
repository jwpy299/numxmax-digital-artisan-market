/**
 * 迭代 21 账号分发权限化测试（SQL 层 mock）。
 *
 * 方法：vi.mock("./queries/connection") 注入可编程假 db（select→from→where→limit
 * 按调用顺序返回队列结果），从而在不连库的情况下驱动 sessionMe / deptHeadOf；
 * 用 agenticRouter.createCaller 直接调用 procedure。
 *
 * 断言：
 * 1. 无有效 token 调 headRegister → UNAUTHORIZED（sessionMe 拒绝）；
 *    （传空串 token 更早在 zod 层被 BAD_REQUEST 拦截，同样不可达业务逻辑。）
 * 2. 部门负责人跨部门 employeeRegister → FORBIDDEN「仅可为本部门分发员工账号」；
 * 3. 非负责人 member 调 headRegister → FORBIDDEN「仅企业负责人可分发部门负责人账号」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 按 select 调用顺序出队的假结果集 */
let queue: Array<Array<Record<string, unknown>>> = [];

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => queue.shift() ?? [],
        }),
      }),
    }),
    execute: async () => [[]],
    insert: () => ({ values: () => ({ $returningId: async () => [{ id: 1 }] }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  }),
}));

import { agenticRouter } from "./routers/agentic";

const caller = agenticRouter.createCaller({} as never);

const factory = {
  id: 10,
  enterpriseName: "测试企业",
  industry: "工业制造",
  industryText: null,
  headcount: "50",
  departments: [
    { id: "sales", name: "销售部" },
    { id: "finance", name: "财务部" },
  ],
  painPoints: null,
  profile: null,
  creditCode: null,
  industryGroup: "工业制造",
  createdAt: new Date(),
};

function wbUser(over: Record<string, unknown>) {
  return {
    id: 1,
    username: "u",
    passwordHash: "x",
    displayName: "U",
    role: "member",
    factoryId: 10,
    departmentId: null,
    authToken: "nt_x",
    phone: null,
    realName: null,
    idCardMasked: null,
    idCardHash: null,
    kind: "enterprise",
    createdAt: new Date(),
    ...over,
  };
}

beforeEach(() => {
  queue = [];
});

describe("迭代 21 账号分发权限化", () => {
  it("无有效 token 调 headRegister → UNAUTHORIZED", async () => {
    queue = [[]]; // sessionMe 查不到用户
    await expect(
      caller.headRegister({
        token: "nt_invalid",
        username: "newhead",
        password: "pass123456",
        displayName: "新负责人",
        factoryId: 10,
        deptId: "sales",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("非负责人 member 调 headRegister → FORBIDDEN 中文提示", async () => {
    queue = [[wbUser({ role: "member" })], [factory]];
    await expect(
      caller.headRegister({
        token: "nt_member",
        username: "newhead",
        password: "pass123456",
        displayName: "新负责人",
        factoryId: 10,
        deptId: "sales",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "仅企业负责人可分发部门负责人账号" });
  });

  it("部门负责人跨部门 employeeRegister → FORBIDDEN 仅可为本部门分发", async () => {
    queue = [
      [wbUser({ id: 2, role: "member", departmentId: "sales" })], // sessionMe user
      [factory], // sessionMe factory
      [{ id: 1 }], // wb_dept_heads 命中（本人是 sales 负责人）
    ];
    await expect(
      caller.employeeRegister({
        token: "nt_head",
        username: "newemp",
        password: "pass123456",
        displayName: "新员工",
        factoryId: 10,
        deptId: "finance", // 跨部门
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "仅可为本部门分发员工账号" });
  });

  it("非负责人 member 调 employeeRegister → FORBIDDEN", async () => {
    queue = [
      [wbUser({ id: 3, role: "member", departmentId: "sales" })],
      [factory],
      [], // wb_dept_heads 未命中
    ];
    await expect(
      caller.employeeRegister({
        token: "nt_member",
        username: "newemp",
        password: "pass123456",
        displayName: "新员工",
        factoryId: 10,
        deptId: "sales",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("admin 跨企业 headRegister（factoryId 不一致）→ FORBIDDEN", async () => {
    queue = [[wbUser({ role: "admin", factoryId: 10 })], [factory]];
    await expect(
      caller.headRegister({
        token: "nt_admin",
        username: "newhead",
        password: "pass123456",
        displayName: "新负责人",
        factoryId: 999,
        deptId: "sales",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "仅企业负责人可分发部门负责人账号" });
  });
});
