/**
 * M16 组织角色三级归一与守卫测试（纯函数 + SQL 层 mock，不连库）。
 *
 * 断言（设计 §6 wbRoles 三条）：
 * 1. normalizeRole：owner→admin / admin→admin / member→staff / manager/staff 直通 / null/未知→staff；
 * 2. dataScopeOf：admin→factory；manager+deptHead 命中→dept；manager 无 departmentId→self；staff→self；
 * 3. requireWbRole：角色不符 FORBIDDEN、token 无效 UNAUTHORIZED、存量 member 负责人（dept_heads 命中）
 *    按 manager 放行；requireDeptScope：manager 跨部门拒绝、本部门放行。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let selectQueue: Array<Array<Record<string, unknown>>> = [];

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => selectQueue.shift() ?? [],
        }),
      }),
    }),
  }),
}));

import {
  normalizeRole,
  dataScopeOf,
  requireWbRole,
  requireDeptScope,
} from "./routers/wbSession";

beforeEach(() => {
  selectQueue = [];
});

const factory = { id: 10, enterpriseName: "TEST_企业" };

describe("normalizeRole 归一", () => {
  it("owner→admin / admin→admin / member→staff / manager/staff 直通 / null/未知→staff", () => {
    expect(normalizeRole("owner")).toBe("admin");
    expect(normalizeRole("admin")).toBe("admin");
    expect(normalizeRole("member")).toBe("staff");
    expect(normalizeRole("manager")).toBe("manager");
    expect(normalizeRole("staff")).toBe("staff");
    expect(normalizeRole(null)).toBe("staff");
    expect(normalizeRole(undefined)).toBe("staff");
    expect(normalizeRole("superuser")).toBe("staff"); // 未知历史值兜底
  });
});

describe("dataScopeOf 数据范围", () => {
  it("admin→factory；manager 命中→dept；manager 无部门→self；staff→self", () => {
    expect(dataScopeOf({ role: "owner", departmentId: null }, [])).toEqual({ scope: "factory" });
    expect(dataScopeOf({ role: "admin", departmentId: "d1" }, [])).toEqual({ scope: "factory" });
    // manager + deptHead 命中本部门 → dept
    expect(dataScopeOf({ role: "manager", departmentId: "d1" }, ["d1"])).toEqual({
      scope: "dept",
      deptId: "d1",
    });
    // 新写 manager（无 heads 行，headDeptIds 空）凭 departmentId → dept
    expect(dataScopeOf({ role: "manager", departmentId: "d2" }, [])).toEqual({
      scope: "dept",
      deptId: "d2",
    });
    // manager 无 departmentId → self 兜底
    expect(dataScopeOf({ role: "manager", departmentId: null }, [])).toEqual({ scope: "self" });
    // staff → self
    expect(dataScopeOf({ role: "member", departmentId: "d1" }, [])).toEqual({ scope: "self" });
    expect(dataScopeOf({ role: "staff", departmentId: "d1" }, [])).toEqual({ scope: "self" });
  });
});

describe("requireWbRole / requireDeptScope 守卫", () => {
  it("token 无效 → UNAUTHORIZED；角色不符 → FORBIDDEN；存量 member 负责人按 manager 放行", async () => {
    // token 无效：sessionMe 查无用户
    selectQueue.push([]);
    await expect(requireWbRole("nt_bad", ["admin"], "denied")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    // staff（存量 member 且非负责人）调 admin-only → FORBIDDEN
    selectQueue.push(
      [{ id: 1, role: "member", factoryId: 10, departmentId: "d1" }], // sessionMe 用户
      [factory], // sessionMe 企业
      [], // dept_heads 未命中
    );
    await expect(requireWbRole("nt_staff", ["admin"], "denied")).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "denied",
    });

    // 存量 member + dept_heads 命中 → 并集视为 manager，调 ['admin','manager'] 放行
    selectQueue.push(
      [{ id: 2, role: "member", factoryId: 10, departmentId: "d1" }],
      [factory],
      [{ id: 9 }], // dept_heads 命中
    );
    const session = await requireWbRole("nt_head", ["admin", "manager"], "denied");
    expect(session.user.id).toBe(2);

    // 新写 manager 角色直通（不再查 dept_heads）
    selectQueue.push([{ id: 3, role: "manager", factoryId: 10, departmentId: "d1" }], [factory]);
    const s2 = await requireWbRole("nt_mgr", ["manager"], "denied");
    expect(s2.user.id).toBe(3);

    // requireDeptScope：manager 跨部门 → FORBIDDEN；本部门 → 放行；admin 直通
    selectQueue.push([{ id: 3, role: "manager", factoryId: 10, departmentId: "d1" }], [factory]);
    await expect(requireDeptScope("nt_mgr", "d2")).rejects.toMatchObject({ code: "FORBIDDEN" });
    selectQueue.push([{ id: 3, role: "manager", factoryId: 10, departmentId: "d1" }], [factory]);
    const s3 = await requireDeptScope("nt_mgr", "d1");
    expect(s3.user.id).toBe(3);
    selectQueue.push([{ id: 4, role: "owner", factoryId: 10, departmentId: null }], [factory]);
    const s4 = await requireDeptScope("nt_owner", "d2");
    expect(s4.user.id).toBe(4);
  });
});
