/**
 * M75 闭环输送带执行层：四类候选装配 + advanceLoop 接线 + 端点鉴权。
 *
 * 覆盖：
 * 1. 全装配：四类候选各中 → enterprise×factory 动作序列（回滚首位）；
 * 2. gov 域 veto：施工/验证/部署全灭，仅止血动作存活；
 * 3. 库抖动：四查询全灭 → ok:false 如实报死；部分缺席 → 该类空集降级 ok:true；
 * 4. investigate 咨询型不进施工清单（SQL 口径断言：proposal_type IN optimize/new_skill）；
 * 5. 端点：内部令牌直通不触 requireAdmin；环身份透传；非内部令牌走 requireAdmin。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

let approvedIds: number[] = [];
let draftIds: number[] = [];
let verifiedIds: number[] = [];
let unhealthyIds: number[] = [];
let livePublished: Array<Record<string, unknown>> = [];
let auditInserts: Array<{ text: string; params: unknown[] }> = [];
let nullSet = new Set<string>(); // 缺席查询标记（approved/drafts/verified/unhealthy）
let seenSql: string[] = [];

const dialect = new MySqlDialect();
vi.mock("./queries/connection", () => ({
  getDb: () => ({
    execute: async (stmt: unknown) => {
      const q = dialect.sqlToQuery(stmt as never);
      const text = q.sql.trim().replace(/\s+/g, " ");
      seenSql.push(text);
      // M76 探针：live 发布查询 + 审计写入（先于通用 st_releases 匹配）
      if (text.includes("status = 'published'") && text.includes("ORDER BY published_at")) {
        return [livePublished];
      }
      if (text.startsWith("INSERT INTO st_release_audit")) {
        auditInserts.push({ text, params: q.params as unknown[] });
        return [{ insertId: 5000 + auditInserts.length }];
      }
      // 输送带四查询（先于 loop 环查询匹配——特征更具体）
      if (text.includes("construct:queued")) {
        return nullSet.has("approved") ? null : [approvedIds.map((id) => ({ id }))];
      }
      if (text.includes("status = 'draft'") && text.includes("verifier IS NOT NULL")) {
        return nullSet.has("drafts") ? null : [draftIds.map((id) => ({ id }))];
      }
      if (text.includes("JOIN st_release_tickets t")) {
        return nullSet.has("verified") ? null : [verifiedIds.map((id) => ({ id }))];
      }
      if (text.includes("probe:fail") && text.includes("FROM st_releases r")) {
        return nullSet.has("unhealthy") ? null : [unhealthyIds.map((id) => ({ id }))];
      }
      // loop 环六查询（空集降级）
      if (text.includes("FROM st_evo_signals")) return [[{ c: 0 }]];
      if (text.includes("FROM st_evo_proposals")) return [[]];
      if (text.includes("FROM st_release_tickets")) return [[{ c: 0 }]];
      if (text.includes("JOIN st_release_audit b")) return [[{ c: 0 }]];
      if (text.includes("FROM st_release_audit")) return [[]];
      if (text.includes("FROM st_releases")) return [[]];
      throw new Error(`unexpected SQL: ${text}`);
    },
  }),
}));

const { requireAdminMock } = vi.hoisted(() => ({
  requireAdminMock: vi.fn(async (..._args: unknown[]) => ({ id: 1, username: "hq", role: "admin" })),
}));
vi.mock("./routers/terminal", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/terminal")>();
  return { ...orig, requireAdmin: (...a: unknown[]) => requireAdminMock(...a) };
});

import { recordProbeReport, runConveyor } from "./harness/conveyor";
import { nebulaHarnessRouter } from "./harness/router";

const caller = nebulaHarnessRouter.createCaller({} as never);
const HQ = { domain: "enterprise" as const, scope: "factory" as const, evoOptOut: false };

beforeEach(() => {
  approvedIds = []; draftIds = []; verifiedIds = []; unhealthyIds = [];
  livePublished = []; auditInserts = [];
  nullSet = new Set(); seenSql = [];
  requireAdminMock.mockClear();
  delete process.env.HARNESS_DISPATCH_TOKEN;
});

describe("M75 runConveyor 装配", () => {
  it("四类候选全中：回滚首位 + 施工/验证/部署资格依次", async () => {
    approvedIds = [11, 12]; draftIds = [21]; verifiedIds = [31]; unhealthyIds = [41];
    const r = await runConveyor(HQ);
    expect(r.ok).toBe(true);
    expect(r.candidates).toEqual({ approvedConstructible: 2, draftsGreen: 1, verifiedTicketed: 1, publishedUnhealthy: 1 });
    expect(r.actions).toEqual([
      { kind: "auto_rollback", releaseId: 41, reason: "published 24h 内探针红" },
      { kind: "queue_construct", proposalId: 11 },
      { kind: "queue_construct", proposalId: 12 },
      { kind: "auto_verify", releaseId: 21 },
      { kind: "eligible_deploy", releaseId: 31 },
    ]);
    expect(r.ring?.ok).toBe(true);
  });

  it("gov 域 veto：仅止血存活，其余 noop 语义", async () => {
    approvedIds = [11]; draftIds = [21]; verifiedIds = [31];
    const r = await runConveyor({ ...HQ, domain: "gov" });
    expect(r.actions).toEqual([{ kind: "noop", reason: "闭环本拍无可推进项（各段均未达自动条件）" }]);
    unhealthyIds = [41];
    const r2 = await runConveyor({ ...HQ, domain: "gov" });
    expect(r2.actions[0]).toMatchObject({ kind: "auto_rollback", releaseId: 41 });
  });

  it("investigate 咨询型不进施工清单（SQL 口径钉死）", async () => {
    await runConveyor(HQ);
    const q = seenSql.find((s) => s.includes("construct:queued"))!;
    expect(q).toContain("proposal_type IN ('optimize', 'new_skill')");
    expect(q).toContain("skill_key <> ''");
    expect(q).not.toContain("investigate");
  });

  it("四查询全灭 → ok:false 如实报死；单类缺席 → 空集降级 ok:true", async () => {
    nullSet = new Set(["approved", "drafts", "verified", "unhealthy"]);
    const dead = await runConveyor(HQ);
    expect(dead.ok).toBe(false);
    expect(dead.error).toBe("全部查询失败（库抖动）");

    nullSet = new Set(["drafts"]);
    approvedIds = [11];
    const partial = await runConveyor(HQ);
    expect(partial.ok).toBe(true);
    expect(partial.candidates.draftsGreen).toBe(0);
    expect(partial.actions).toEqual([{ kind: "queue_construct", proposalId: 11 }]);
  });
});

describe("M75 conveyor 端点", () => {
  it("内部令牌直通 + 环身份透传；非内部走 requireAdmin", async () => {
    process.env.HARNESS_DISPATCH_TOKEN = "conv-internal-x";
    approvedIds = [7];
    const r = await caller.conveyor({
      token: "conv-internal-x", domain: "research", scope: "factory", evoOptOut: false,
    });
    expect(r.ok).toBe(true);
    expect(r.domain).toBe("research");
    expect(r.actions).toEqual([{ kind: "queue_construct", proposalId: 7 }]);
    expect(requireAdminMock).not.toHaveBeenCalled();

    await caller.conveyor({ token: "admin-tok", domain: "enterprise", scope: "dept", evoOptOut: false });
    expect(requireAdminMock).toHaveBeenCalledWith("admin-tok");
  });
});

describe("M76 探针回写（observe 段数据源）", () => {
  it("fail 挂最新 published 发布落审计；actor/action/detail 口径钉死", async () => {
    livePublished = [{ id: 88 }];
    const r = await recordProbeReport({ channel: "admin", target: "s3-admin-3201", ok: false, detail: "http 502" });
    expect(r).toEqual({ ok: true, action: "probe:fail", releaseId: 88 });
    expect(auditInserts).toHaveLength(1);
    const ins = auditInserts[0];
    // params: [releaseId, channel, action, detail]（actor 字面量在 SQL 文本）
    expect(ins.params[0]).toBe(88);
    expect(ins.params[1]).toBe("admin");
    expect(ins.text).toContain("'nebula-prober'");
    expect(ins.params[2]).toBe("probe:fail");
    expect(String(ins.params[3])).toContain("s3-admin-3201");
    expect(String(ins.params[3])).toContain("http 502");
  });

  it("ok 回写 + 无 published 发布 → releaseId NULL 如实", async () => {
    const r = await recordProbeReport({ channel: "wb", target: "s2-wb-3001", ok: true });
    expect(r).toEqual({ ok: true, action: "probe:ok", releaseId: null });
    expect(auditInserts[0].params[0]).toBeNull();
  });

  it("detail 超长按 300 截断；target 超长按 64 截断", async () => {
    const r = await recordProbeReport({
      channel: "server", target: "t".repeat(100), ok: false, detail: "x".repeat(500),
    });
    expect(r.ok).toBe(true);
    const detail = JSON.parse(String(auditInserts[0].params[3]));
    expect(detail.target).toHaveLength(64);
    expect(detail.detail).toHaveLength(300);
  });

  it("端点：仅内部令牌——管理员令牌也拒（探针非人类业务）", async () => {
    process.env.HARNESS_DISPATCH_TOKEN = "probe-internal-x";
    await expect(
      caller.probeReport({ token: "admin-tok", channel: "admin", target: "t", ok: true }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(requireAdminMock).not.toHaveBeenCalled(); // 连管理员通道都不走

    livePublished = [{ id: 90 }];
    const r = await caller.probeReport({ token: "probe-internal-x", channel: "server", target: "s1-app-3101", ok: true });
    expect(r).toMatchObject({ ok: true, action: "probe:ok", releaseId: 90 });
  });
});
