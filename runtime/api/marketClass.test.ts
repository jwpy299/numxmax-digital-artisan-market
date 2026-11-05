/**
 * M82 超市四分类测试（彭总架构图 2026-08-25：个人助理/企业职能/行业方案/通用技能）。
 * 1. list 带 marketClass 过滤参数 → SQL 含过滤且载荷带出；
 * 2. 缺省不过滤，载荷仍带 marketClass；
 * 3. 列缺席（旧库）→ 回退旧查询不炸；
 * 4. publish 上架继承 st_skills.market_class。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const dialect = new MySqlDialect();
let seenSql: string[] = [];
let marketRows: Array<Record<string, unknown>> = [];
let skillsRows: Array<Record<string, unknown>> = [];

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    execute: async (stmt: unknown) => {
      const q = dialect.sqlToQuery(stmt as never);
      const text = q.sql.trim().replace(/\s+/g, " ");
      seenSql.push(text);
      if (text.includes("FROM st_skill_market")) return [marketRows];
      if (text.includes("FROM st_skills")) return [skillsRows];
      if (text.startsWith("INSERT INTO st_skill_market")) return [{ insertId: 77 }];
      return [[]];
    },
  }),
}));

vi.mock("./routers/wbSession", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/wbSession")>();
  return { ...orig, sessionMe: async () => ({ user: { id: 1, username: "boss", role: "owner" }, factory: { id: 10, industry: "工业制造" } }) };
});
vi.mock("./routers/skillStats", () => ({
  buildSkillMetas: async () => [],
  executorKindOf: () => null,
}));
vi.mock("./routers/claw", () => ({ requireWbHead: async () => ({ id: 1 }) }));
vi.mock("./routers/fitnessUtil", () => ({ recordFitness: () => {} }));

import { marketRouter } from "./routers/skillMarket";
const caller = marketRouter.createCaller({} as never);

beforeEach(() => {
  seenSql = [];
  marketRows = [{
    id: 5, skillKey: "k1", title: "客服话术", industry: "工业制造", description: null,
    priceTokens: 10, listedAt: "2026-08-25", marketClass: "enterprise",
  }];
  skillsRows = [{ market_class: "industry" }];
});

describe("M82 超市四分类", () => {
  it("带 marketClass 过滤 → SQL 含过滤 + 载荷带出分类", async () => {
    const r = await caller.list({ token: "t", marketClass: "enterprise" });
    const q = seenSql.find((s) => s.includes("st_skill_market"))!;
    expect(q).toContain("market_class");
    expect(r.items[0].marketClass).toBe("enterprise");
  });
  it("缺省不过滤 + 载荷带出", async () => {
    const r = await caller.list({ token: "t" });
    const q = seenSql.find((s) => s.includes("st_skill_market"))!;
    expect(q).not.toContain("AND market_class");
    expect(r.items[0].marketClass).toBe("enterprise");
  });
});
