/**
 * M22a 通用设备资产台账（wbAssets）测试（SQL 层 mock，不连库；测试数据 TEST_ 前缀）。
 *
 * 断言矩阵：
 * 1. lookup 命中 active → found:true/retired:false，资产卡不含 boundBy 等人员字段；
 * 2. lookup 未命中 → {found:false}；
 * 3. lookup 已退役 → found:true/retired:true + 「已退役」提示文案（C 级语义）；
 * 4. lookup 大小写敏感：仅大小写不同的码值不命中（JS === 精确复核，防御 collation 漂移）；
 * 5. 跨企业 lookup 不见：他企业码一律 {found:false}，不泄露存在性（factoryId 过滤语义由
 *    SQL 保证，mock 用 factoryId 过滤重演 DB 行为）；
 * 6. register 成功：assetNo 缺省自动生成 AS-{factoryId}-{6位随机大写字数}；insert 带
 *    factoryId/boundBy；staff 可登记（员工发现新设备可报备）；
 * 7. register 幂等：同 factoryId+codeValue 已有 active → already:true 返回已有资产，无 insert；
 * 8. category 白名单：非法 category / name 过短 → zod BAD_REQUEST；
 * 9. list 按 category 分组排序（production 在前）；category 过滤生效；
 * 10. retire 幂等：首次 alreadyRetired:false，二次（影响 0 行）alreadyRetired:true 不报错；
 * 11. retire 仅 admin：staff/manager → FORBIDDEN。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type SelectBatch = { rows: Row[]; factoryId?: number }; // factoryId 设定时重演 DB 层企业隔离过滤

let selectQueue: SelectBatch[] = [];
let updateQueue: number[] = []; // retire UPDATE 的 affectedRows
let inserted: Array<{ values: Row }> = [];
let updated: Array<Row> = [];
let nextId = 100;

vi.mock("./queries/connection", () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          const batch = selectQueue.shift() ?? { rows: [] };
          const rows =
            batch.factoryId === undefined
              ? batch.rows
              : batch.rows.filter((r) => r.factoryId === batch.factoryId); // 重演 SQL factoryId 过滤
          const thenable = {
            then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve(rows).then(res, rej),
          };
          return {
            limit: () => thenable,
            then: thenable.then,
          };
        },
      }),
    }),
    insert: () => ({
      values: (v: Row) => {
        inserted.push({ values: v });
        const id = nextId++;
        return { $returningId: async () => [{ id }] };
      },
    }),
    update: () => ({
      set: (v: Row) => ({
        where: async () => {
          updated.push(v);
          return [{ affectedRows: updateQueue.shift() ?? 1 }];
        },
      }),
    }),
  };
  return { getDb: () => db };
});

import { wbAssetsRouter } from "./routers/wbAssets";

const caller = wbAssetsRouter.createCaller({} as never);

const factory = {
  id: 10,
  enterpriseName: "TEST_星云企业",
  departments: [{ id: "sales", name: "销售部" }],
};
const factoryB = { id: 20, enterpriseName: "TEST_隔壁企业", departments: [] };
const adminUser = { id: 1, username: "TEST_boss", displayName: "TEST_老板", role: "owner", factoryId: 10, departmentId: null };
const staffUser = { id: 2, username: "TEST_emp", displayName: "TEST_员工", role: "staff", factoryId: 10, departmentId: "sales" };
const managerUser = { id: 3, username: "TEST_mgr", displayName: "TEST_负责人", role: "manager", factoryId: 10, departmentId: "sales" };
const outsiderAdmin = { id: 9, username: "TEST_out", displayName: "TEST_外人", role: "admin", factoryId: 20, departmentId: null };

function assetRow(over: Row = {}): Row {
  return {
    id: 42,
    factoryId: 10,
    assetNo: "AS-10-A1B2C3",
    name: "TEST_车间中央空调-01",
    category: "hvac",
    codeType: "qr",
    codeValue: "AC-Unit-0001",
    location: "TEST_一号车间东侧",
    status: "active",
    boundBy: 1,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    retiredAt: null,
    ...over,
  };
}

/** sessionMe 两段 select（user → factory），admin/manager 无 deptHeads 段 */
function queueSession(user: Row, fac: Row = factory as unknown as Row) {
  selectQueue.push({ rows: [user] }, { rows: [fac] });
}

beforeEach(() => {
  selectQueue = [];
  updateQueue = [];
  inserted = [];
  updated = [];
  nextId = 100;
});

describe("M22a wbAssets.lookup（扫码第一跳）", () => {
  it("1. 命中 active → found:true/retired:false，资产卡不含 boundBy", async () => {
    queueSession(staffUser as unknown as Row);
    selectQueue.push({ rows: [assetRow()], factoryId: 10 });
    const r = await caller.lookup({ token: "tok", codeValue: "AC-Unit-0001" });
    expect(r.found).toBe(true);
    if (r.found) {
      expect(r.retired).toBe(false);
      expect(r.asset.assetNo).toBe("AS-10-A1B2C3");
      expect(r.asset.category).toBe("hvac");
      expect(r.asset).not.toHaveProperty("boundBy");
      expect(r.asset).not.toHaveProperty("updatedAt");
    }
  });

  it("2. 未命中 → {found:false}", async () => {
    queueSession(staffUser as unknown as Row);
    selectQueue.push({ rows: [], factoryId: 10 });
    const r = await caller.lookup({ token: "tok", codeValue: "NO-SUCH-CODE" });
    expect(r).toEqual({ found: false });
  });

  it("3. 已退役 → found:true/retired:true + 已退役提示（C 级语义）", async () => {
    queueSession(staffUser as unknown as Row);
    selectQueue.push({
      rows: [assetRow({ status: "retired", retiredAt: new Date() })],
      factoryId: 10,
    });
    const r = await caller.lookup({ token: "tok", codeValue: "AC-Unit-0001" });
    expect(r.found).toBe(true);
    if (r.found) {
      expect(r.retired).toBe(true);
      if (r.retired) expect(r.message).toContain("已退役");
      expect(r.asset.status).toBe("retired");
    }
  });

  it("4. 大小写敏感：仅大小写不同的码值不命中（JS === 精确复核）", async () => {
    queueSession(staffUser as unknown as Row);
    selectQueue.push({ rows: [assetRow()], factoryId: 10 }); // 库中 AC-Unit-0001
    const r = await caller.lookup({ token: "tok", codeValue: "ac-unit-0001" });
    expect(r).toEqual({ found: false });
  });

  it("5. 跨企业 lookup 不见：他企业码一律 {found:false}，不泄露存在性", async () => {
    // 库中码属企业 10；登录者属企业 20（admin）——factoryId 过滤后候选为空
    queueSession(outsiderAdmin as unknown as Row, factoryB as unknown as Row);
    selectQueue.push({ rows: [assetRow()], factoryId: 20 }); // mock 重演 DB factoryId 过滤
    const r = await caller.lookup({ token: "tok", codeValue: "AC-Unit-0001" });
    expect(r).toEqual({ found: false });
  });
});

describe("M22a wbAssets.register（扫码登记，全员可报备）", () => {
  it("6. staff 登记成功：assetNo 缺省自动生成 AS-{factoryId}-{6位大写字数}", async () => {
    queueSession(staffUser as unknown as Row);
    selectQueue.push({ rows: [] }); // effectiveRoleOf：staff → wb_dept_heads 空
    selectQueue.push({ rows: [], factoryId: 10 }); // 同码查重：无
    const r = await caller.register({
      token: "tok",
      name: "车间打印机-A",
      category: "printer",
      codeType: "ean13",
      codeValue: "6901234567892",
      location: "一号车间",
    });
    expect(r.ok).toBe(true);
    expect(r.already).toBe(false);
    expect(r.asset.assetNo).toMatch(/^AS-10-[A-Z0-9]{6}$/);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.values.factoryId).toBe(10);
    expect(inserted[0]!.values.boundBy).toBe(staffUser.id); // 登记人审计
    expect(inserted[0]!.values.assetNo).toMatch(/^AS-10-[A-Z0-9]{6}$/);
  });

  it("7. 幂等：同码已有 active → already:true 返回已有资产，无 insert", async () => {
    queueSession(adminUser as unknown as Row);
    selectQueue.push({ rows: [assetRow()], factoryId: 10 }); // 同码查重：命中 active
    const r = await caller.register({
      token: "tok",
      name: "重复扫码换了个名字",
      category: "hvac",
      codeType: "qr",
      codeValue: "AC-Unit-0001",
    });
    expect(r).toMatchObject({ ok: true, already: true });
    expect(r.asset.assetId).toBe(42); // 返回已有资产而非新建
    expect(inserted).toHaveLength(0);
  });

  it("8. category 白名单 + name 长度：非法值 → BAD_REQUEST", async () => {
    await expect(
      caller.register({
        token: "tok",
        name: "合法名字",
        category: "rocket" as never,
        codeType: "qr",
        codeValue: "X-1",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.register({
        token: "tok",
        name: "短",
        category: "hvac",
        codeType: "qr",
        codeValue: "X-1",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("M22a wbAssets.list（一期不分权，全员本企业全量）", () => {
  it("9. 按 category 分组排序（production 在前，office 在后）", async () => {
    queueSession(staffUser as unknown as Row);
    selectQueue.push({ rows: [] }); // deptHeads 空
    selectQueue.push({
      rows: [
        assetRow({ id: 3, category: "office", name: "TEST_碎纸机" }),
        assetRow({ id: 1, category: "production", name: "TEST_冲床" }),
        assetRow({ id: 2, category: "hvac", name: "TEST_空调" }),
      ],
      factoryId: 10,
    });
    const r = await caller.list({ token: "tok" });
    expect(r.items.map((i) => i.category)).toEqual(["production", "hvac", "office"]);
  });
});

describe("M22a wbAssets.retire（仅 admin，C 级幂等）", () => {
  it("10. 幂等：首次退役 ok/alreadyRetired:false；二次影响 0 行也 ok", async () => {
    queueSession(adminUser as unknown as Row);
    updateQueue.push(1);
    const first = await caller.retire({ token: "tok", assetId: 42 });
    expect(first).toEqual({ ok: true, alreadyRetired: false });
    expect(updated[0]).toMatchObject({ status: "retired" });
    expect(updated[0]!.retiredAt).toBeInstanceOf(Date);

    queueSession(adminUser as unknown as Row);
    updateQueue.push(0); // 已退役：WHERE status='active' 影响 0 行
    const second = await caller.retire({ token: "tok", assetId: 42 });
    expect(second).toEqual({ ok: true, alreadyRetired: true });
  });

  it("11. 仅 admin：staff/manager → FORBIDDEN", async () => {
    queueSession(staffUser as unknown as Row);
    selectQueue.push({ rows: [] }); // deptHeads 空
    await expect(caller.retire({ token: "tok", assetId: 42 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    queueSession(managerUser as unknown as Row);
    await expect(caller.retire({ token: "tok", assetId: 42 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(updated).toHaveLength(0); // 未触达 UPDATE
  });
});
