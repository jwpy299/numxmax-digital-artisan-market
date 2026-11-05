/**
 * M78b 输送带真执行层测试（彭总双签开闸版）。
 *
 * 覆盖：
 * 1. queue_construct：approved 提案 → draft 发布+入队审计；二拍幂等；状态漂移拦截；
 * 2. auto_verify：证据齐备才翻 verified（执行时复查）；缺证据不翻；已 verified 幂等；
 * 3. eligible_deploy：verified+票据消费 → 资格登记；缺票据拒绝；
 * 4. auto_rollback：published→rolled_back 止血；重复止血不放大；
 * 5. 整拍：单动作失败不中断后续（逐项如实）；
 * 6. 端点：env 缺省=REPORT-ONLY 无 executed；env 开+内部令牌→真执行；env 开+非内部→不执行。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

// ─── 假库状态机 ──────────────────────────────────────────────────────────────
interface Proposal { id: number; status: string; proposal_type: string; skill_key: string }
interface Release { id: number; channel: string; version: string; status: string; verifier: string | null; report_ref: string | null }
let proposals: Proposal[] = [];
let releases: Release[] = [];
let consumedTickets: number[] = []; // release_id 列表（publish consumed）
let queuedAudit: number[] = [];
let dryrunDone = true; // construct:queued 的 proposalId
let auditLog: Array<{ action: string; releaseId: number | null }> = [];
let seenDetails: string[] = [];
let nextReleaseId = 100;

const dialect = new MySqlDialect();
vi.mock("./queries/connection", () => ({
  getDb: () => ({
    execute: async (stmt: unknown) => {
      const q = dialect.sqlToQuery(stmt as never);
      const text = q.sql.trim().replace(/\s+/g, " ");
      const P = q.params as unknown[];
      // 提案实况
      if (text.includes("FROM st_evo_proposals WHERE id =")) {
        return [proposals.filter((p) => p.id === Number(P[0]))];
      }
      // G2 沙盘预演记录复查（默认已有干跑记录；反例测试用 dryrunDone=false）
      if (text.startsWith("SELECT") && P.map(String).includes("sandbox:dryrun")) {
        return [dryrunDone ? [{ id: 1 }] : []];
      }
      // 入队审计锁复查
      if (text.includes("construct:queued") && text.startsWith("SELECT")) {
        // 参数是 LIKE '%proposal:<id>%'：提取 id 必须与生产子串口径一致
        const m = /proposal:(\d+)/.exec(String(P[0]));
        const pid = m ? Number(m[1]) : -1;
        return [queuedAudit.includes(pid) ? [{ id: 1 }] : []];
      }
      // 版本去重
      if (text.includes("FROM st_releases WHERE channel = 'server' AND version =")) {
        return [releases.filter((r) => r.channel === "server" && r.version === String(P[0]))];
      }
      // 建 draft
      if (text.startsWith("INSERT INTO st_releases")) {
        const id = nextReleaseId++;
        releases.push({ id, channel: "server", version: String(P[0]), status: "draft", verifier: null, report_ref: null });
        return [{ insertId: id }];
      }
      // 入队审计（VALUES 直插）
      if (text.startsWith("INSERT INTO st_release_audit") && text.includes("construct:queued")) {
        const detail = String(P[2] ?? "");
        // 与生产候选查询 LIKE '%proposal:<id>%' 同语义：严格字面量子串，JSON 引号格式不算
        const m = /proposal:(\d+)/.exec(detail);
        if (m) queuedAudit.push(Number(m[1]));
        seenDetails.push(detail);
        auditLog.push({ action: "construct:queued", releaseId: Number(P[0]) });
        return [{ insertId: 1 }];
      }
      // verify/rollback/eligible 审计（INSERT ... SELECT）
      if (text.startsWith("INSERT INTO st_release_audit") && text.includes("'verify'")) {
        auditLog.push({ action: "verify", releaseId: null });
        return [{ insertId: 1 }];
      }
      if (text.startsWith("INSERT INTO st_release_audit") && text.includes("'rollback'")) {
        auditLog.push({ action: "rollback", releaseId: null });
        return [{ insertId: 1 }];
      }
      if (text.startsWith("INSERT INTO st_release_audit") && text.includes("deploy:eligible")) {
        auditLog.push({ action: "deploy:eligible", releaseId: null });
        return [{ insertId: 1 }];
      }
      // auto_verify 翻状态（证据复查在 SQL WHERE 里——假库模拟证据列判定）
      if (text.startsWith("UPDATE st_releases SET status = 'verified'")) {
        const r = releases.find((x) => x.id === Number(P[0]));
        const ok = r && r.status === "draft" && r.verifier != null && r.report_ref != null;
        if (ok) r!.status = "verified";
        return [{ affectedRows: ok ? 1 : 0 }];
      }
      // 状态查询（幂等判定）
      if (text.includes("SELECT status FROM st_releases WHERE id =")) {
        const r = releases.find((x) => x.id === Number(P[0]));
        return [r ? [{ status: r.status }] : []];
      }
      // 资格复查（verified + 票据已消费）
      if (text.includes("JOIN st_release_tickets t") && text.includes("r.id =")) {
        const r = releases.find((x) => x.id === Number(P[0]));
        const ok = r && r.status === "verified" && consumedTickets.includes(r.id);
        return [ok ? [{ id: r!.id }] : []];
      }
      // rollback 翻状态
      if (text.startsWith("UPDATE st_releases SET status = 'rolled_back'")) {
        const r = releases.find((x) => x.id === Number(P[0]));
        const ok = r && r.status === "published";
        if (ok) r!.status = "rolled_back";
        return [{ affectedRows: ok ? 1 : 0 }];
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  }),
}));

const { requireAdminMock } = vi.hoisted(() => ({
  requireAdminMock: vi.fn(async (_token: string) => ({ id: 1, username: "hq", role: "admin" })),
}));
vi.mock("./routers/terminal", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/terminal")>();
  return { ...orig, requireAdmin: (...a: Parameters<typeof orig.requireAdmin>) => requireAdminMock(...a), rawRows: (r: unknown) => (Array.isArray(r) ? (Array.isArray(r[0]) ? r[0] : r) : []) };
});

import { conveyorExecuteEnabled, executeConveyorActions } from "./harness/executor";
import { nebulaHarnessRouter } from "./harness/router";

const caller = nebulaHarnessRouter.createCaller({} as never);

beforeEach(() => {
    dryrunDone = true;
  proposals = []; releases = []; consumedTickets = []; queuedAudit = []; auditLog = []; seenDetails = [];
  nextReleaseId = 100;
  requireAdminMock.mockClear();
  delete process.env.EVO_CONVEYOR_EXECUTE;
  delete process.env.HARNESS_DISPATCH_TOKEN;
});

describe("M78b queue_construct", () => {
  it("approved 提案 → draft 发布 + construct:queued 审计；二拍幂等命中审计锁", async () => {
    proposals = [{ id: 11, status: "approved", proposal_type: "optimize", skill_key: "k1" }];
    const r1 = await executeConveyorActions([{ kind: "queue_construct", proposalId: 11 }]);
    expect(r1[0].ok).toBe(true);
    expect(releases).toHaveLength(1);
    expect(releases[0].version).toMatch(/^auto-p11-\d{8}$/);
    expect(queuedAudit).toEqual([11]);
    expect(auditLog[0] && seenDetails[0]).toContain("proposal:11"); // 审计锁字面量契约
    const r2 = await executeConveyorActions([{ kind: "queue_construct", proposalId: 11 }]);
    expect(r2[0].ok).toBe(true);
    expect(r2[0].detail).toContain("幂等");
    expect(releases).toHaveLength(1); // 不重复建
  });
  it("提案漂移（非 approved/不存在）→ 拦截不施工", async () => {
    proposals = [{ id: 12, status: "rejected", proposal_type: "optimize", skill_key: "k1" }];
    const r = await executeConveyorActions([{ kind: "queue_construct", proposalId: 12 }, { kind: "queue_construct", proposalId: 99 }]);
    expect(r[0].ok).toBe(false);
    expect(r[1].ok).toBe(false);
    expect(releases).toHaveLength(0);
  });
});

describe("M78b auto_verify", () => {
  it("draft+证据齐备 → verified+审计；缺证据 → 不翻；已 verified → 幂等", async () => {
    releases = [
      { id: 21, channel: "server", version: "v1", status: "draft", verifier: "v16", report_ref: "runs/x.md" },
      { id: 22, channel: "server", version: "v2", status: "draft", verifier: null, report_ref: null },
    ];
    const r = await executeConveyorActions([{ kind: "auto_verify", releaseId: 21 }, { kind: "auto_verify", releaseId: 22 }]);
    expect(r[0].ok).toBe(true);
    expect(releases[0].status).toBe("verified");
    expect(auditLog.some((a) => a.action === "verify")).toBe(true);
    expect(r[1].ok).toBe(false); // 无证据不翻
    expect(releases[1].status).toBe("draft");
    const r2 = await executeConveyorActions([{ kind: "auto_verify", releaseId: 21 }]);
    expect(r2[0].ok).toBe(true);
    expect(r2[0].detail).toContain("幂等");
  });
  it("G2：缺沙盘干跑记录 → 拒入队（诚实写明理由）", async () => {
    dryrunDone = false;
    proposals = [{ id: 21, status: "approved", proposal_type: "optimize", skill_key: "k1" }];
    const r = await executeConveyorActions([{ kind: "queue_construct", proposalId: 21 }]);
    expect(r[0].ok).toBe(false);
    expect(r[0].detail).toContain("沙盘预演");
    expect(releases).toHaveLength(0);
  });

  it("G4：涉资金提案 → 合规拦截转人工 L3（输送带不收）", async () => {
    proposals = [{ id: 22, status: "approved", proposal_type: "billing", skill_key: "退款规则调整" }];
    const r = await executeConveyorActions([{ kind: "queue_construct", proposalId: 22 }]);
    expect(r[0].ok).toBe(false);
    expect(r[0].detail).toContain("合规拦截");
    expect(releases).toHaveLength(0);
  });

});

describe("M78b eligible_deploy / auto_rollback", () => {
  it("verified+票据消费 → deploy:eligible；缺票据 → 拒绝", async () => {
    releases = [
      { id: 31, channel: "server", version: "v1", status: "verified", verifier: "v16", report_ref: "r" },
      { id: 32, channel: "server", version: "v2", status: "verified", verifier: "v16", report_ref: "r" },
    ];
    consumedTickets = [31];
    const r = await executeConveyorActions([{ kind: "eligible_deploy", releaseId: 31 }, { kind: "eligible_deploy", releaseId: 32 }]);
    expect(r[0].ok).toBe(true);
    expect(r[1].ok).toBe(false);
    expect(auditLog.filter((a) => a.action === "deploy:eligible")).toHaveLength(1);
  });
  it("published+探针红 → rolled_back 止血；重复止血不放大", async () => {
    releases = [{ id: 41, channel: "server", version: "v1", status: "published", verifier: "v", report_ref: "r" }];
    const r1 = await executeConveyorActions([{ kind: "auto_rollback", releaseId: 41, reason: "probe:fail" }]);
    expect(r1[0].ok).toBe(true);
    expect(releases[0].status).toBe("rolled_back");
    expect(auditLog.some((a) => a.action === "rollback")).toBe(true);
    const r2 = await executeConveyorActions([{ kind: "auto_rollback", releaseId: 41, reason: "probe:fail" }]);
    expect(r2[0].ok).toBe(false); // 非 published 不再动作
  });
});

describe("M78b 整拍韧性 + 端点双闸", () => {
  it("单动作失败不中断后续（逐项如实）", async () => {
    proposals = [{ id: 11, status: "approved", proposal_type: "optimize", skill_key: "k" }];
    releases = [{ id: 41, channel: "server", version: "v1", status: "published", verifier: "v", report_ref: "r" }];
    const r = await executeConveyorActions([
      { kind: "auto_rollback", releaseId: 41, reason: "x" },
      { kind: "queue_construct", proposalId: 99 }, // 失败项
      { kind: "queue_construct", proposalId: 11 },
    ]);
    expect(r.map((x) => x.ok)).toEqual([true, false, true]);
  });
  it("闸：缺省 REPORT-ONLY（无 executed 键）", () => {
    expect(conveyorExecuteEnabled()).toBe(false);
  });
  it("端点：env 开 + 内部令牌 → 真执行带 executed；非内部令牌 → 只报告", async () => {
    process.env.EVO_CONVEYOR_EXECUTE = "1";
    process.env.HARNESS_DISPATCH_TOKEN = "conv-x";
    // 本测试假库只覆盖执行器 SQL——候选查询部分降级（ok:true 空集），动作 noop
    const r1 = await caller.conveyor({ token: "conv-x", domain: "enterprise", scope: "factory", evoOptOut: false });
    expect(r1.ok).toBe(true);
    expect("executed" in r1).toBe(true); // 内部令牌+env 双闸 → 真执行（noop 也如实回报）
    expect((r1 as { executed: Array<{ kind: string }> }).executed[0].kind).toBe("noop");
    const r2 = await caller.conveyor({ token: "admin-tok", domain: "enterprise", scope: "factory", evoOptOut: false });
    expect(requireAdminMock).toHaveBeenCalledWith("admin-tok");
    expect("executed" in r2).toBe(false); // 非内部令牌永不执行
  });
});
