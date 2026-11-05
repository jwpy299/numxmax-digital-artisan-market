/**
 * M71 事件驱动调度环：信号聚集 → 自动立项 pending 咨询型提案（拍板权在人）。
 *
 * 覆盖：
 * 1. detectClusters 纯函数：阈值边界（=阈立案 / 阈-1 不立案）、未知 kind 忽略、
 *    boot 不立案、按 count 降序；
 * 2. dispatchSignals 假库全链：GROUP BY 聚集 → pending 幂等 → INSERT 形状
 *    （target_type='signal' / proposal_type='investigate' / source='auto-event' /
 *    skill_key='' / factory_id 可空）；hq（factory_id NULL）与分厂同 kind 各自立案；
 *    已有 pending 跳过不重复立项；
 * 3. 失败静默：库抛错 → ok:false + error，绝不抛出；
 * 4. 路由鉴权双腿：HARNESS_DISPATCH_TOKEN 内部令牌直通（不触 requireAdmin）；
 *    非内部令牌走 requireAdmin；requireAdmin 拒绝则抛出。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

// ─── 内存假库：st_evo_signals 聚集 + st_evo_proposals 幂等/立项 ────
let signalRows: Array<Record<string, unknown>>;
let pendingRows: Array<Record<string, unknown>>;
let inserts: Array<{ text: string; params: unknown[] }>;
let failNext: boolean;

function resetState() {
  signalRows = [];
  pendingRows = [];
  inserts = [];
  failNext = false;
}

const dialect = new MySqlDialect();

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    execute: async (stmt: unknown) => {
      if (failNext) {
        failNext = false;
        throw new Error("db down");
      }
      const q = dialect.sqlToQuery(stmt as never);
      const text = q.sql.trim().replace(/\s+/g, " ");
      const params = q.params as unknown[];
      if (text.includes("FROM st_evo_signals") && text.includes("GROUP BY factory_id, kind")) {
        return [signalRows];
      }
      if (
        text.includes("FROM st_evo_proposals") &&
        text.includes("status = 'pending'") &&
        text.includes("target_type = 'signal'")
      ) {
        return [pendingRows];
      }
      if (text.startsWith("INSERT INTO st_evo_proposals")) {
        inserts.push({ text, params });
        return [{ insertId: 1000 + inserts.length }];
      }
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

import { deptThresholdOf, detectClusters, dispatchSignals, SIGNAL_RULES } from "./harness/dispatch";
import { nebulaHarnessRouter } from "./harness/router";

const caller = nebulaHarnessRouter.createCaller({} as never);

beforeEach(() => {
  resetState();
  requireAdminMock.mockClear();
  delete process.env.HARNESS_DISPATCH_TOKEN;
});

describe("M71 detectClusters 纯函数", () => {
  it("=阈立案 / 阈-1 不立案；未知 kind 与 boot 不立案", () => {
    const crash = SIGNAL_RULES.find((r) => r.kind === "crash")!;
    const out = detectClusters([
      { factoryId: null, kind: "crash", count: crash.threshold }, // =阈 → 立案
      { factoryId: null, kind: "dag_fail", count: 2 }, // 阈(3)-1 → 不立案
      { factoryId: null, kind: "boot", count: 999 }, // boot 无规则 → 不立案
      { factoryId: null, kind: "mystery", count: 999 }, // 未知 → 不立案
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "crash", count: crash.threshold, title: "崩溃聚集" });
  });

  it("多聚集按 count 降序", () => {
    const out = detectClusters([
      { factoryId: 1, kind: "crash", count: 3 },
      { factoryId: 1, kind: "api_error", count: 20 },
      { factoryId: 1, kind: "skill_fail", count: 7 },
    ]);
    expect(out.map((c) => c.kind)).toEqual(["api_error", "skill_fail", "crash"]);
  });
});

describe("M71 dispatchSignals 假库全链", () => {
  it("达阈聚集自动立项：INSERT 形状与类型钉死（investigate/auto-event/signal）", async () => {
    signalRows = [
      { factory_id: null, kind: "api_error", c: 12 }, // 平台级 hq
      { factory_id: 6290209, kind: "api_error", c: 11 }, // 同 kind 分厂各自立案
      { factory_id: 6290209, kind: "crash", c: 2 }, // 未达阈
    ];
    const r = await dispatchSignals();
    expect(r.ok).toBe(true);
    expect(r.buckets).toBe(3);
    expect(r.clusters).toBe(2);
    expect(r.created).toBe(2);
    expect(r.skippedPending).toBe(0);
    // hq 与分厂同 kind 各自一条，强隔离
    expect(inserts).toHaveLength(2);
    const [hqIns, facIns] = inserts;
    // params: [week, kind, title, evidence, evidence, factoryId, rationale]
    expect(hqIns.params[1]).toBe("api_error");
    expect(String(hqIns.params[2])).toContain("【事件驱动】API 异常聚集");
    expect(String(hqIns.params[2])).toContain("×12/24h");
    expect(hqIns.params[5]).toBeNull(); // 平台级 factory_id NULL
    expect(facIns.params[5]).toBe(6290209);
    // 类型钉死在 SQL 文本（字面量）
    expect(hqIns.text).toContain("'signal'");
    expect(hqIns.text).toContain("'investigate'");
    expect(hqIns.text).toContain("'auto-event'");
    expect(hqIns.text).toContain("'pending'");
    // 提案正文如实标注拍板权在人
    expect(String(hqIns.params[3])).toContain("拍板权在人");
  });

  it("幂等：已有 pending 同厂同 kind 跳过；他厂不受影响", async () => {
    signalRows = [
      { factory_id: null, kind: "crash", c: 5 },
      { factory_id: 6290209, kind: "crash", c: 4 },
    ];
    pendingRows = [{ factory_id: null, target_key: "crash" }]; // hq 已立案
    const r = await dispatchSignals();
    expect(r.ok).toBe(true);
    expect(r.created).toBe(1);
    expect(r.skippedPending).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[5]).toBe(6290209); // 只有分厂立项
  });

  it("全跳过：clusters 全部已有 pending → created=0 零写入", async () => {
    signalRows = [{ factory_id: 6290209, kind: "skill_fail", c: 9 }];
    pendingRows = [{ factory_id: 6290209, target_key: "skill_fail" }];
    const r = await dispatchSignals();
    expect(r).toMatchObject({ ok: true, created: 0, skippedPending: 1, clusters: 1 });
    expect(inserts).toHaveLength(0);
  });

  it("失败静默：库抛错 → ok:false + error 截断，绝不抛出", async () => {
    failNext = true;
    const r = await dispatchSignals();
    expect(r.ok).toBe(false);
    expect(r.error).toBe("db down");
  });
});

describe("M71 路由鉴权双腿", () => {
  it("内部令牌直通：不触 requireAdmin（定时点火器 server-to-server）", async () => {
    process.env.HARNESS_DISPATCH_TOKEN = "internal-dispatch-token-x";
    signalRows = [{ factory_id: null, kind: "crash", c: 3 }];
    const r = await caller.dispatch({ token: "internal-dispatch-token-x" });
    expect(r.ok).toBe(true);
    expect(r.created).toBe(1);
    expect(requireAdminMock).not.toHaveBeenCalled();
  });

  it("非内部令牌走 requireAdmin；拒绝则抛出", async () => {
    process.env.HARNESS_DISPATCH_TOKEN = "internal-dispatch-token-x";
    const r = await caller.dispatch({ token: "admin-token" });
    expect(r.ok).toBe(true);
    expect(requireAdminMock).toHaveBeenCalledWith("admin-token");

    requireAdminMock.mockRejectedValueOnce(new Error("FORBIDDEN"));
    await expect(caller.dispatch({ token: "bad-token" })).rejects.toThrow(/FORBIDDEN/);
  });

  it("未配置内部令牌时全量走 requireAdmin", async () => {
    await caller.dispatch({ token: "admin-token" });
    expect(requireAdminMock).toHaveBeenCalledWith("admin-token");
  });
});

describe("M77 部门环联邦立案（大小环互联互通激活）", () => {
  it("deptThresholdOf：企业阈 1/2 向上取整；未知 kind 永不立案", () => {
    expect(deptThresholdOf("crash")).toBe(2);
    expect(deptThresholdOf("skill_fail")).toBe(3);
    expect(deptThresholdOf("api_error")).toBe(5);
    expect(deptThresholdOf("voice_fail")).toBe(4);
    expect(deptThresholdOf("unknown_kind")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("留环：单部门达部门阈（未达企业阈）→ 部门定向立案 crash@tech，不升企业环", async () => {
    signalRows = [{ factory_id: 6290209, dept_key: "tech", kind: "crash", c: 2 }];
    const r = await dispatchSignals();
    expect(r.ok).toBe(true);
    expect(r.created).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[1]).toBe("crash@tech"); // target_key 部门定向
    expect(inserts[0].params[5]).toBe(6290209);
    expect(String(inserts[0].params[2])).toContain("【事件驱动·部门环】");
    expect(String(inserts[0].params[3])).toContain("定向不外溢");
  });

  it("共鸣：同厂同 kind 两部门各自达阈 → 单条企业环 crash@resonance（E1 吸收）", async () => {
    signalRows = [
      { factory_id: 6290209, dept_key: "tech", kind: "crash", c: 2 },
      { factory_id: 6290209, dept_key: "ops", kind: "crash", c: 3 },
    ];
    const r = await dispatchSignals();
    expect(r.created).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[1]).toBe("crash@resonance");
    expect(String(inserts[0].params[2])).toContain("ops/tech"); // depts 排序
    expect(String(inserts[0].params[2])).toContain("×5/24h"); // 合并计数
  });

  it("烈度：单部门 ≥部门阈×3 → 企业环 crash@intensity（E2）", async () => {
    signalRows = [{ factory_id: 6290209, dept_key: "legal", kind: "crash", c: 6 }];
    const r = await dispatchSignals();
    expect(r.created).toBe(1);
    expect(inserts[0].params[1]).toBe("crash@intensity");
    expect(String(inserts[0].params[3])).toContain("legal");
  });

  it("共鸣优先吸收烈度：tech×2 + ops×8 → 只一条 resonance，不重复升级", async () => {
    signalRows = [
      { factory_id: 6290209, dept_key: "tech", kind: "crash", c: 2 },
      { factory_id: 6290209, dept_key: "ops", kind: "crash", c: 8 },
    ];
    const r = await dispatchSignals();
    expect(r.created).toBe(1);
    expect(inserts[0].params[1]).toBe("crash@resonance");
  });

  it("混维共存：企业环桶（dept NULL）走 M71 原路径 + 部门桶各自立案", async () => {
    signalRows = [
      { factory_id: 6290209, dept_key: null, kind: "api_error", c: 11 }, // 企业环达阈
      { factory_id: 6290209, dept_key: "finance", kind: "skill_fail", c: 3 }, // 部门阈 3
      { factory_id: null, dept_key: null, kind: "crash", c: 5 }, // 平台环
    ];
    const r = await dispatchSignals();
    expect(r.ok).toBe(true);
    expect(r.created).toBe(3);
    const keys = inserts.map((i) => `${i.params[5]}:${i.params[1]}`).sort();
    expect(keys).toEqual(["6290209:api_error", "6290209:skill_fail@finance", "null:crash"].sort());
  });

  it("部门环幂等：pending 已有 crash@tech → 跳过不重复立案", async () => {
    signalRows = [{ factory_id: 6290209, dept_key: "tech", kind: "crash", c: 4 }];
    pendingRows = [{ factory_id: 6290209, target_key: "crash@tech" }];
    const r = await dispatchSignals();
    expect(r.created).toBe(0);
    expect(r.skippedPending).toBe(1);
    expect(inserts).toHaveLength(0);
  });

  it("跨厂隔离红线：邻厂部门信号绝不在本厂立案", async () => {
    signalRows = [
      { factory_id: 6350239, dept_key: "tech", kind: "crash", c: 9 },
      { factory_id: 6290209, dept_key: "tech", kind: "crash", c: 2 },
    ];
    const r = await dispatchSignals();
    expect(r.created).toBe(2);
    const facIds = inserts.map((i) => i.params[5]).sort();
    expect(facIds).toEqual([6290209, 6350239]); // 各自 factory_id 各自立案
  });
});
