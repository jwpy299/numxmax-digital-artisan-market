/**
 * packages 部门级订阅包数据面钉（战区② 2.1——彭总策略：单员工展示+部门包主调）：
 * ① adminSeed 部门包种子写入带 dept_code+team_spec（幻影不养钉：列有真消费面=种子写入+list 读出）；
 * ② list 读出 DTO 透 deptCode/teamSpec（2.3 部门包页按部门组织面消费）；
 * ③ 规模包（非部门包）deptCode=null/teamSpec=null（缺省空面——两列不污染规模包）。
 * mock 面：connection（execute 捕获）+terminal（requireAdmin 桩）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const dialect = new MySqlDialect();
let captured: { sql: string; params: unknown[] }[] = [];
let pkgRows: Array<Record<string, unknown>> = [];

vi.mock("../queries/connection", () => ({
  getDb: () => ({
    execute: async (stmt: unknown) => {
      const q = dialect.sqlToQuery(stmt as never);
      captured.push({ sql: q.sql, params: q.params as unknown[] });
      if (q.sql.includes("FROM pkg_packages")) return [pkgRows, []];
      return [{ affectedRows: 1, insertId: 77 }, []];
    },
  }),
}));

vi.mock("./terminal", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./terminal")>();
  return { ...orig, requireAdmin: async () => ({ username: "TEST_admin" }) }; // 保真件（rawRows 等）——只覆 requireAdmin 闸
});

import { packagesRouter } from "./packages";

describe("packages 部门级订阅包数据面（战区② 2.1）", () => {
  beforeEach(() => {
    captured = [];
    pkgRows = [];
  });

  it("① adminSeed 部门包种子写入带 dept_code+team_spec（幻影不养钉——列有真消费面）", async () => {
    const r = await packagesRouter.createCaller({} as never).adminSeed({ token: "TEST_tok" });
    expect(r.ok).toBe(true);
    expect(r.count).toBe(6); // 3 规模包+3 部门包（finance/legal/marketing）——彭总 2026-10-22 令：全域进化包/资产增值包摘除=规模包 5→3
    const ins = captured.filter((c) => c.sql.includes("INSERT INTO pkg_packages"));
    expect(ins.length).toBe(6);
    // 部门包种子的 dept_code/team_spec 落面
    const financeIns = ins.find((c) => c.params[0] === "dept_finance");
    expect(financeIns).toBeTruthy();
    expect(financeIns!.sql).toContain("dept_code"); // dept_code 列在 INSERT 列清单
    expect(financeIns!.sql).toContain("team_spec"); // team_spec 列同
    expect(financeIns!.params).toContain("finance"); // dept_code 值落
    const teamSpecParam = financeIns!.params.find((p) => typeof p === "string" && p.includes("财务主管"));
    expect(teamSpecParam).toBeTruthy(); // team_spec JSON 落（含主管 duty 面）
  });

  it("② list 读出 DTO 透 deptCode/teamSpec（2.3 部门包页消费面）", async () => {
    pkgRows = [
      {
        id: 1, key: "dept_finance", name: "财务部团队订阅包", price_yuan: 19800, period_label: "含6个月",
        agents_count: 4, scope_label: "财务部团队", synergy_label: "主管统筹+专员协同",
        monetize_label: "无", scale_label: "财务全流程", poster_url: "/pkg/pkg-dept-finance.png",
        dept_code: "finance",
        team_spec: JSON.stringify({ lead: { role: "co", deptKey: "finance", duty: "财务主管", skillHints: [] }, members: [{ role: "ex", deptKey: "finance", duty: "记账", skillHints: [] }] }),
        features: JSON.stringify(["含数字匠市+智能工作台"]),
        sort_order: 10,
      },
    ];
    const rows = await packagesRouter.createCaller({} as never).list();
    expect(rows.length).toBe(1);
    expect(rows[0].deptCode).toBe("finance"); // DTO 透 deptCode
    expect(rows[0].teamSpec).toBeTruthy(); // DTO 透 teamSpec
    expect((rows[0].teamSpec as { lead: { duty: string } }).lead.duty).toBe("财务主管"); // team_spec 解析面
  });

  it("③ 规模包（非部门包）deptCode=null/teamSpec=null（缺省空面——两列不污染规模包）", async () => {
    pkgRows = [
      {
        id: 1, key: "core_exp", name: "核心经验包", price_yuan: 5800, period_label: "含3个月",
        agents_count: 1, scope_label: "单点经验", synergy_label: "无",
        monetize_label: "无", scale_label: "10人以下团队", poster_url: "/pkg/pkg-core.png",
        dept_code: null, team_spec: null,
        features: JSON.stringify(["覆盖范围：单点经验"]),
        sort_order: 1,
      },
    ];
    const rows = await packagesRouter.createCaller({} as never).list();
    expect(rows[0].deptCode).toBeNull(); // 非部门包=null
    expect(rows[0].teamSpec).toBeNull(); // 同上
  });
});
