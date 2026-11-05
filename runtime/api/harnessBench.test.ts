/**
 * Nebula Harness 沙箱跑分器（彭总 2026-08-25：彻底测试+跑分）。
 * 口径：逻辑层时延（假库隔离 DB 抖动；生产实测时延另列验收战役档）。
 * 每项：20 次迭代取 p50/p95（纯函数项 1000 次）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

// ─── 假库（conveyor 测试同款纪律：文本分流）────────────────────────────────
const dialect = new MySqlDialect();
let approvedIds: number[] = [];
let draftIds: number[] = [];
let verifiedIds: number[] = [];
let unhealthyIds: number[] = [];
let signalBuckets: Array<Record<string, unknown>> = [];

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    execute: async (stmt: unknown) => {
      const q = dialect.sqlToQuery(stmt as never);
      const text = q.sql.trim().replace(/\s+/g, " ");
      if (text.includes("construct:queued") && text.startsWith("SELECT")) return [approvedIds.map((id) => ({ id }))];
      if (text.includes("status = 'draft'") && text.includes("verifier IS NOT NULL") && !text.startsWith("UPDATE")) return [draftIds.map((id) => ({ id }))];
      if (text.includes("JOIN st_release_tickets t") && text.startsWith("SELECT")) return [verifiedIds.map((id) => ({ id }))];
      if (text.includes("probe:fail") && text.includes("FROM st_releases r")) return [unhealthyIds.map((id) => ({ id }))];
      if (text.includes("GROUP BY")) return [signalBuckets];
      if (text.includes("FROM st_evo_signals")) return [[{ c: signalBuckets.length }]];
      if (text.includes("FROM st_evo_proposals")) return [[]];
      if (text.includes("FROM st_release_tickets")) return [[{ c: 0 }]];
      if (text.includes("st_release_audit")) return [[]];
      if (text.includes("FROM st_releases")) return [[]];
      if (text.startsWith("INSERT")) return [{ insertId: 1 }];
      if (text.startsWith("UPDATE")) return [{ affectedRows: 1 }];
      return [[]];
    },
  }),
}));

import { dispatchSignals } from "./harness/dispatch";
import { runConveyor } from "./harness/conveyor";
import { computeLoopRing, advanceLoop } from "./harness/loop";
import { escalateClusters } from "./harness/federation";
import { executeConveyorActions } from "./harness/executor";

function stats(times: number[]): { p50: number; p95: number } {
  const s = [...times].sort((a, b) => a - b);
  return { p50: Math.round(s[Math.floor(s.length * 0.5)] * 100) / 100, p95: Math.round(s[Math.floor(s.length * 0.95)] * 100) / 100 };
}
async function timeAsync(fn: () => Promise<unknown>, n: number): Promise<{ p50: number; p95: number }> {
  const ts: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    ts.push(performance.now() - t0);
  }
  return stats(ts);
}
function timeSync(fn: () => unknown, n: number): { p50: number; p95: number } {
  const ts: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  return stats(ts);
}

const HQ = { domain: "enterprise" as const, scope: "factory" as const, evoOptOut: false };
const results: Array<{ name: string; p50: number; p95: number; n: number }> = [];

beforeEach(() => {
  approvedIds = [11, 12]; draftIds = [21]; verifiedIds = [31]; unhealthyIds = [41];
  signalBuckets = Array.from({ length: 50 }, (_, i) => ({
    factory_id: 6290209, kind: "crash", dept_key: i % 2 ? "tech" : "ops", c: 3 + (i % 5),
  }));
  process.env.HQ_FACTORY_IDS = "6290209";
});

describe("Nebula Harness 跑分", () => {
  it("全套跑分", async () => {
    results.push({ name: "advanceLoop 纯判定", ...( timeSync(() => advanceLoop({
      ring: { ok: true, signals24h: 45, proposals: {}, releases: {}, pendingTickets: 0, rollbackAfterPublish24h: false, lastArmRunAt: null,
        stages: { sense: true, propose: true, decide: true, construct: false, verify: false, release: false, observe: false } },
      domain: "enterprise", scope: "factory", evoOptOut: false,
      approvedConstructible: [11, 12], draftsGreen: [21], verifiedTicketed: [31], publishedUnhealthy: [41],
    }), 1000)), n: 1000 });

    results.push({ name: "escalateClusters 联邦三态", ...(timeSync(() => escalateClusters(
      signalBuckets.map((b) => ({ factoryId: 6290209, kind: String(b.kind), deptKey: String(b.dept_key), count: Number(b.c) })),
      () => 3,
    ), 1000)), n: 1000 });

    results.push({ name: "computeLoopRing 七段环读取", ...(await timeAsync(() => computeLoopRing(), 20)), n: 20 });
    results.push({ name: "dispatchSignals 点火（信号→立案）", ...(await timeAsync(() => dispatchSignals(), 20)), n: 20 });
    results.push({ name: "runConveyor 四类装配", ...(await timeAsync(() => runConveyor(HQ), 20)), n: 20 });
    results.push({ name: "executeConveyorActions 四动作真执行", ...(await timeAsync(() => executeConveyorActions([
      { kind: "auto_rollback", releaseId: 41, reason: "probe" },
      { kind: "queue_construct", proposalId: 11 },
      { kind: "auto_verify", releaseId: 21 },
      { kind: "eligible_deploy", releaseId: 31 },
    ]), 20)), n: 20 });

    console.log("\n===== Nebula Harness 跑分（沙箱逻辑层） =====");
    for (const r of results) console.log(`${r.name}  p50=${r.p50}ms p95=${r.p95}ms  (n=${r.n})`);
    expect(results.length).toBe(6);
  }, 120_000);
});
