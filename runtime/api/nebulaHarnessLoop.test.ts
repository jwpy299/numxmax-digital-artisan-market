/**
 * M73 自进化闭环输送带：域适配 × 尺度适配 × 闭环推进判定 + 七段状态读取。
 *
 * 覆盖：
 * 1. resolveDomain：五域关键词归一（gov/finance 从严优先）、空/未知 → enterprise；
 * 2. DOMAIN_POLICIES 红线：全域 requireDoubleSign 恒 true；gov 全人审；finance 不动验证/部署；
 * 3. SCOPE_CEILING：dept 不施工、platform 不自动部署；effectiveAutonomy 取交集宁严勿宽；
 * 4. advanceLoop：回滚第一优先且不设闸；evo_opt_out 恒 noop；天花板 veto；
 *    全自动域（enterprise×factory）四段动作齐备；空输入 noop 带原因；
 * 5. computeLoopRing 假库：七段灯 + 计数形状；表缺席降级 ok:false 不抛出。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

// ─── 内存假库：七段六查询按 SQL 文本分流 ────
let sigC = 0;
let propRows: Array<Record<string, unknown>> = [];
let relRows: Array<Record<string, unknown>> = [];
let tickC = 0;
let armAt: string | null = null;
let rbC = 0;
let throwAll = false;

const dialect = new MySqlDialect();
vi.mock("./queries/connection", () => ({
  getDb: () => ({
    execute: async (stmt: unknown) => {
      if (throwAll) throw new Error("db down");
      const text = dialect.sqlToQuery(stmt as never).sql.trim().replace(/\s+/g, " ");
      if (text.includes("FROM st_evo_signals")) return [[{ c: sigC }]];
      if (text.includes("FROM st_evo_proposals")) return [propRows];
      if (text.includes("FROM st_release_tickets")) return [[{ c: tickC }]];
      if (text.includes("FROM st_release_audit a JOIN st_release_audit b")) return [[{ c: rbC }]];
      if (text.includes("FROM st_release_audit") && text.includes("arm:run")) {
        return [armAt ? [{ created_at: armAt }] : []];
      }
      if (text.includes("FROM st_releases GROUP BY status")) return [relRows];
      throw new Error(`unexpected SQL: ${text}`);
    },
  }),
}));

import {
  advanceLoop, computeLoopRing, DOMAIN_POLICIES, effectiveAutonomy,
  resolveDomain, SCOPE_CEILING, type LoopRing,
} from "./harness/loop";

beforeEach(() => {
  sigC = 0; propRows = []; relRows = []; tickC = 0; armAt = null; rbC = 0; throwAll = false;
});

describe("M73 域适配层", () => {
  it("五域关键词归一；gov/finance 从严优先；空与未知 → enterprise", () => {
    expect(resolveDomain("政务服务管理局")).toBe("gov");
    expect(resolveDomain("某银行金融科技部")).toBe("finance"); // 金融先于科技兜底
    expect(resolveDomain("市第一中学校")).toBe("education");
    expect(resolveDomain("省人工智能研究院")).toBe("research");
    expect(resolveDomain("生态科技有限公司")).toBe("enterprise");
    expect(resolveDomain("")).toBe("enterprise");
    expect(resolveDomain(null)).toBe("enterprise");
    expect(resolveDomain(undefined)).toBe("enterprise");
  });

  it("红线：全域 requireDoubleSign 恒 true；gov 三段全人审；finance 验证/部署不自动", () => {
    for (const p of Object.values(DOMAIN_POLICIES)) {
      expect(p.requireDoubleSign).toBe(true);
    }
    expect(DOMAIN_POLICIES.gov).toMatchObject({ autoConstruct: false, autoVerify: false, autoDeploy: false });
    expect(DOMAIN_POLICIES.finance).toMatchObject({ autoConstruct: true, autoVerify: false, autoDeploy: false });
    expect(DOMAIN_POLICIES.education.extraGates).toContain("content_screen");
    expect(DOMAIN_POLICIES.enterprise).toMatchObject({ autoConstruct: true, autoVerify: true, autoDeploy: true });
  });
});

describe("M73 尺度适配层", () => {
  it("dept 不施工不部署；platform 不自动施工不自动部署；交集宁严勿宽", () => {
    expect(SCOPE_CEILING.dept).toMatchObject({ autoConstruct: false, autoDeploy: false });
    expect(SCOPE_CEILING.platform).toMatchObject({ autoConstruct: false, autoDeploy: false });
    // enterprise × dept：域放行但尺度掐掉施工
    const deptCap = effectiveAutonomy("enterprise", "dept");
    expect(deptCap.autoConstruct).toBe(false);
    expect(deptCap.requireDoubleSign).toBe(true);
    // enterprise × factory：全开
    const facCap = effectiveAutonomy("enterprise", "factory");
    expect(facCap).toMatchObject({ autoConstruct: true, autoVerify: true, autoDeploy: true });
    // gov × factory：域掐掉全部
    const govCap = effectiveAutonomy("gov", "factory");
    expect(govCap).toMatchObject({ autoConstruct: false, autoVerify: false, autoDeploy: false });
  });
});

describe("M73 advanceLoop 闭环推进", () => {
  const ring = { ok: true } as LoopRing; // ring 本体不进判定，仅占位
  const base = { ring, domain: "enterprise" as const, scope: "factory" as const, evoOptOut: false,
    approvedConstructible: [], draftsGreen: [], verifiedTicketed: [], publishedUnhealthy: [] };

  it("evo_opt_out 恒 noop（企业硬退出，环路不碰）", () => {
    const out = advanceLoop({ ...base, evoOptOut: true, approvedConstructible: [1] });
    expect(out).toEqual([{ kind: "noop", reason: "企业已退出自进化（evo_opt_out）" }]);
  });

  it("回滚第一优先且不设闸：gov 域 + opt 未退出也能止血", () => {
    const out = advanceLoop({ ...base, domain: "gov", publishedUnhealthy: [77] });
    expect(out[0]).toMatchObject({ kind: "auto_rollback", releaseId: 77 });
  });

  it("enterprise×factory 全自动：施工/验证/部署资格三段齐备", () => {
    const out = advanceLoop({ ...base, approvedConstructible: [11, 12], draftsGreen: [21], verifiedTicketed: [31] });
    expect(out).toEqual([
      { kind: "queue_construct", proposalId: 11 },
      { kind: "queue_construct", proposalId: 12 },
      { kind: "auto_verify", releaseId: 21 },
      { kind: "eligible_deploy", releaseId: 31 },
    ]);
  });

  it("dept 环 veto 施工与部署（只立项，部门不伤主干）", () => {
    const out = advanceLoop({ ...base, scope: "dept", approvedConstructible: [11], verifiedTicketed: [31] });
    expect(out).toEqual([{ kind: "noop", reason: "闭环本拍无可推进项（各段均未达自动条件）" }]);
  });

  it("platform 环不自动部署（框架自我更新走双签+运维通道）", () => {
    const out = advanceLoop({ ...base, scope: "platform", verifiedTicketed: [31], draftsGreen: [21] });
    expect(out).toEqual([{ kind: "noop", reason: "闭环本拍无可推进项（各段均未达自动条件）" }]);
  });
});

describe("M73 computeLoopRing 七段状态", () => {
  it("七段灯 + 计数形状 + 票据与回滚观测", async () => {
    sigC = 5;
    propRows = [{ status: "pending", c: 2 }, { status: "applied", c: 9 }];
    relRows = [{ status: "verified", c: 1 }, { status: "published", c: 3 }];
    tickC = 1; armAt = "2026-08-23 06:00:00"; rbC = 1;
    const r = await computeLoopRing();
    expect(r.ok).toBe(true);
    expect(r.signals24h).toBe(5);
    expect(r.proposals).toEqual({ pending: 2, applied: 9 });
    expect(r.releases).toEqual({ verified: 1, published: 3 });
    expect(r.pendingTickets).toBe(1);
    expect(r.rollbackAfterPublish24h).toBe(true);
    expect(r.lastArmRunAt).toBe("2026-08-23 06:00:00");
    expect(r.stages).toEqual({ sense: true, propose: true, decide: true, construct: true, verify: true, release: true, observe: true });
  });

  it("空库七段全灭；库抖动降级 ok:false + error，绝不抛出", async () => {
    const r0 = await computeLoopRing();
    expect(r0.ok).toBe(true);
    expect(Object.values(r0.stages).every((v) => !v)).toBe(true);

    throwAll = true;
    const r = await computeLoopRing();
    expect(r.ok).toBe(false);
    expect(r.error).toBe("全部查询失败（库抖动）");
  });
});
