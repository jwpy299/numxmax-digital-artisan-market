/**
 * M77 evoSignals deptKey 部门上下文透传测试（SQL 层 mock，不连库）。
 *
 * 断言：
 * 1. 登录态 report 带 deptKey → INSERT 含 dept_key 占位且参数正确；
 * 2. 匿名 report 带 deptKey → 不落部门（防污部门环，dept_key=NULL）；
 * 3. dept_key 列缺席（sync-m73 未跑）→ 自动回退 legacy 写法，信号不丢。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

type Row = Record<string, unknown>;
let selectQueue: Row[][] = [];
let insertParams: unknown[][] = [];
let failFirstInsert: boolean;

const dialect = new MySqlDialect();

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    select: () => {
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.limit = () => chain;
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(selectQueue.shift() ?? []).then(res, rej);
      return chain;
    },
    execute: async (stmt: unknown) => {
      const q = dialect.sqlToQuery(stmt as never);
      const text: string = q.sql;
      const params = q.params as unknown[];
      if (text.includes("INSERT INTO st_evo_signals")) {
        if (failFirstInsert) {
          failFirstInsert = false;
          throw new Error("Unknown column 'dept_key' in 'field list'");
        }
        insertParams.push(params);
        return [{ insertId: 1 }];
      }
      return [[]];
    },
  }),
}));

import { evoSignalsRouter } from "./routers/evoSignals";

const caller = evoSignalsRouter.createCaller({} as never);

const user = { id: 1, username: "boss", role: "owner", factoryId: 10, departmentId: null };
const factory = { id: 10, enterpriseName: "TEST_企业" };

beforeEach(() => {
  selectQueue = [];
  insertParams = [];
  failFirstInsert = false;
});

describe("M77 evoSignals deptKey", () => {
  it("登录态带 deptKey → 落部门列", async () => {
    selectQueue.push([user], [factory]); // sessionMe 两段
    const r = await caller.report({ token: "tok", kind: "device_fail", message: "TEST_机床掉线", deptKey: "tech" });
    expect(r.ok).toBe(true);
    expect(insertParams).toHaveLength(1);
    // params: [factoryId, deptKey, kind, actor, payload]
    expect(insertParams[0][0]).toBe(10);
    expect(insertParams[0][1]).toBe("tech");
    expect(insertParams[0][2]).toBe("device_fail");
  });

  it("匿名带 deptKey → 不落部门（NULL）", async () => {
    const r = await caller.report({ kind: "crash", message: "TEST_崩溃", deptKey: "tech" });
    expect(r.ok).toBe(true);
    expect(insertParams).toHaveLength(1);
    expect(insertParams[0][1]).toBeNull();
  });

  it("dept_key 列缺席 → 回退 legacy 写法信号不丢", async () => {
    selectQueue.push([user], [factory]);
    failFirstInsert = true;
    const r = await caller.report({ token: "tok", kind: "api_error", message: "TEST_接口异常", deptKey: "ops" });
    expect(r.ok).toBe(true);
    expect(insertParams).toHaveLength(1);
    // legacy 写法 params: [factoryId, kind, actor, payload]（无 dept 位）
    expect(insertParams[0][1]).toBe("api_error");
  });
});
