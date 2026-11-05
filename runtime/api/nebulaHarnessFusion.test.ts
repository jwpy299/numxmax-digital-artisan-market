/**
 * M69 Nebula Harness 双运行时融合（DSH × Codex 组织版）+ 自进化回路闸。
 *
 * 覆盖：
 * 1. 运行时注册表：双运行时 id 唯一、钉版/出处/能力齐备、健康面布尔级无密钥；
 * 2. auto 路由：代码语义→construction/codex，DAG 语义→heavy/dsh，缺省 interactive；
 * 3. construction 三态：无 releaseId→proposal-gate 指引（M65 兼容）；有 releaseId 未开放
 *    →evo_arm_disabled 诚实拒绝；开放+draft→codex-runtime 真链路（mock 执行器，隔离工作区）；
 * 4. 统一台账 st_harness_runs：三链落账元数据级（无任务正文）；
 * 5. 自进化状态面：四段灯 + 计数形状；
 * 6. 宪章：融合与自进化段在骨，指纹随内容演进。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { MySqlDialect } from "drizzle-orm/mysql-core";

// ─── 内存假库：st_releases / st_release_audit / st_harness_runs / 进化三面 ────
type RelRow = { id: number; channel: string; version: string; status: string; created_by: string };

let releases: RelRow[];
let audits: Array<Record<string, unknown>>;
let harnessRuns: Array<Record<string, unknown>>;
let seq: number;

function resetState() {
  releases = [
    { id: 501, channel: "server", version: "v9.9.9", status: "draft", created_by: "boss" },
    { id: 502, channel: "wb", version: "v1.5.0", status: "verified", created_by: "boss" },
  ];
  audits = [];
  harnessRuns = [];
  seq = 900;
}

const dialect = new MySqlDialect();

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    execute: async (stmt: unknown) => {
      const q = dialect.sqlToQuery(stmt as never);
      const text = q.sql.trim().replace(/\s+/g, " ");
      const params = q.params as unknown[];
      if (text.includes("FROM st_releases") && text.includes("WHERE id = ?")) {
        return [releases.filter((r) => r.id === Number(params[0]))];
      }
      if (text.startsWith("INSERT INTO st_release_audit")) {
        audits.push({ id: seq++, release_id: params[0], channel: params[1], actor: params[2], action: "arm:run", detail: params[3] });
        return [{ insertId: seq }];
      }
      if (text.startsWith("INSERT INTO st_harness_runs")) {
        harnessRuns.push({
          id: seq++, tier: params[0], lane: params[1], factory_id: params[2], ok: params[3],
          error: params[4], duration_ms: params[5], charter_fp: params[6], text_len: params[7],
        });
        return [{ insertId: seq }];
      }
      if (text.includes("FROM st_harness_runs ORDER BY id DESC")) {
        return [[...harnessRuns].reverse()];
      }
      if (text.includes("FROM st_evo_signals")) {
        return [[{ c: 3 }]];
      }
      if (text.includes("FROM st_evo_proposals GROUP BY status")) {
        return [[{ status: "pending", c: 2 }, { status: "approved", c: 1 }]];
      }
      if (text.includes("FROM st_releases GROUP BY status")) {
        return [[{ status: "draft", c: 1 }, { status: "verified", c: 4 }]];
      }
      if (text.includes("FROM st_release_audit") && text.includes("arm:run")) {
        return [audits.length
          ? [{ id: audits[audits.length - 1].id, release_id: 501, actor: "nebula-harness", created_at: "2026-08-23 03:00:00" }]
          : []];
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  }),
}));

const { chatFastMock, dshMock } = vi.hoisted(() => ({
  chatFastMock: vi.fn(async (..._args: unknown[]) => ({ ok: true, content: "执行官在线", providerLabel: "kimi" })),
  dshMock: vi.fn(async (..._args: unknown[]) => ({ ok: true, answer: "DAG 完成", durationMs: 999 })),
}));
vi.mock("./routers/modelGateway", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/modelGateway")>();
  return { ...orig, callSlotChatFast: (...a: unknown[]) => chatFastMock(...a) };
});
vi.mock("./routers/dshClient", () => ({ callDsh: (...a: unknown[]) => dshMock(...a) }));
vi.mock("./routers/terminal", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/terminal")>();
  return { ...orig, requireAdmin: vi.fn(async () => ({ id: 1, username: "hq", role: "admin" })) };
});

import {
  listRuntimes, getRuntime, routeTask, RUNTIME_REGISTRY,
} from "./harness/runtimes";
import {
  nebulaHarnessEvolution, nebulaHarnessExecute, nebulaHarnessRoute,
  nebulaHarnessRuns, nebulaHarnessStatus,
} from "./harness/orchestrator";
import { nebulaHarnessRouter } from "./harness/router";
import { buildExecutiveCharterBlock, charterFingerprint } from "./harness/charter";

const caller = nebulaHarnessRouter.createCaller({} as never);
const WS = "/tmp/nebula-harness-m69-test";

describe("M69 双运行时注册表", () => {
  it("DSH × Codex 双运行时注册，钉版与出处齐备", () => {
    const list = listRuntimes();
    expect(list.map((r) => r.id).sort()).toEqual(["codex", "dsh"]);
    const dsh = getRuntime("dsh")!;
    const codex = getRuntime("codex")!;
    expect(dsh.origin).toBe("github.com/deepseek-ai/deepseek-harness");
    expect(dsh.versionPin).toBe("47f9438");
    expect(dsh.lane).toBe("dsh-runtime");
    expect(dsh.capabilities).toContain("dag");
    expect(codex.origin).toBe("github.com/openai/codex");
    expect(codex.versionPin).toBe("rust-v0.149.0");
    expect(codex.lane).toBe("codex-runtime");
    expect(codex.capabilities).toContain("code-edit");
    expect(RUNTIME_REGISTRY).toHaveLength(2);
  });

  it("健康面布尔级无密钥：codex 生产默认 fail-closed", () => {
    delete process.env.EVO_ARM_ENABLED;
    const codex = getRuntime("codex")!.health();
    expect(codex.ready).toBe(false);
    expect(codex.detail).toContain("fail-closed");
    const all = JSON.stringify(listRuntimes().map((r) => r.health()));
    expect(all).not.toContain("sk-");
    expect(all).not.toContain("IDOICTOS_API_KEY=");
  });
});

describe("M69 auto 路由口径", () => {
  it("代码语义 → construction/codex（宁严勿宽优先进提案闸）", () => {
    const r = routeTask("帮我修复登录页的 bug");
    expect(r.tier).toBe("construction");
    expect(r.runtime).toBe("codex");
  });
  it("DAG/长任务语义 → heavy/dsh", () => {
    const r = routeTask("跑全厂设备巡检 DAG 批处理");
    expect(r.tier).toBe("heavy");
    expect(r.runtime).toBe("dsh");
  });
  it("普通问答 → interactive（缺省最保守）", () => {
    const r = routeTask("今天产量怎么样");
    expect(r.tier).toBe("interactive");
    expect(r.runtime).toBeNull();
  });
  it("router.route 过闸同口径", async () => {
    const r = await caller.route({ token: "t", text: "改代码修 bug" });
    expect(r.tier).toBe("construction");
    expect(nebulaHarnessRoute("巡检 dag").runtime).toBe("dsh");
  });
});

describe("M69 construction 三态", () => {
  beforeEach(() => {
    resetState();
    rmSync(WS, { recursive: true, force: true });
    process.env.EVO_ARM_WORKSPACE = WS;
  });
  afterEach(() => {
    delete process.env.EVO_ARM_ENABLED;
    delete process.env.EVO_ARM_EXECUTOR;
    delete process.env.EVO_ARM_WORKSPACE;
    rmSync(WS, { recursive: true, force: true });
  });

  it("无 releaseId：恒 proposal-gate 指引（M65 兼容行为）", async () => {
    const r = await nebulaHarnessExecute({ text: "帮我改代码", tier: "construction" });
    expect(r.lane).toBe("proposal-gate");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("construction_requires_release_draft");
  });

  it("有 releaseId 未开放：evo_arm_disabled 诚实拒绝", async () => {
    const r = await nebulaHarnessExecute({ text: "修复登录 bug", tier: "construction", releaseId: 501 });
    expect(r.lane).toBe("codex-runtime");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("evo_arm_disabled");
  });

  it("开放 + draft 提案：codex-runtime 真链路（mock 执行器）+ 审计落库", async () => {
    process.env.EVO_ARM_ENABLED = "1";
    const r = await nebulaHarnessExecute({ text: "修复登录 bug", tier: "construction", releaseId: 501 });
    expect(r.ok).toBe(true);
    expect(r.lane).toBe("codex-runtime");
    expect(r.arm?.executor).toBe("mock");
    expect(r.arm?.branch).toBe("arm/rls-501");
    expect(r.arm?.diffStat).toBeTruthy();
    expect(r.charterFp).toMatch(/^nh-/);
    expect(audits).toHaveLength(1);
    expect(String(audits[0].actor)).toBe("nebula-harness");
  });

  it("开放 + 非 draft 提案：前置拒绝（先 propose 再施工）", async () => {
    process.env.EVO_ARM_ENABLED = "1";
    await expect(
      nebulaHarnessExecute({ text: "修复登录 bug", tier: "construction", releaseId: 502 }),
    ).rejects.toThrow("draft");
  });
});

describe("M69 统一运行台账", () => {
  beforeEach(() => {
    resetState();
    chatFastMock.mockClear();
    dshMock.mockClear();
  });

  it("interactive/heavy/construction 三链全落账，元数据级无正文", async () => {
    await nebulaHarnessExecute({ text: "今天产量怎么样" });
    await nebulaHarnessExecute({ text: "跑巡检 DAG", tier: "heavy", factoryId: 6290209 });
    await nebulaHarnessExecute({ text: "帮我改代码", tier: "construction" });
    expect(harnessRuns).toHaveLength(3);
    expect(harnessRuns[0]).toMatchObject({ tier: "interactive", lane: "modelGateway", ok: 1, text_len: 7 });
    expect(harnessRuns[1]).toMatchObject({ tier: "heavy", lane: "dsh-runtime", factory_id: 6290209, ok: 1 });
    expect(harnessRuns[2]).toMatchObject({ tier: "construction", lane: "proposal-gate", ok: 0, error: "construction_requires_release_draft" });
    // 绝不落任务正文：字段集合里没有 text/content
    for (const row of harnessRuns) {
      expect(Object.keys(row)).not.toContain("text");
      expect(Object.keys(row)).not.toContain("content");
    }
  });

  it("runs 查询新→旧返回", async () => {
    await nebulaHarnessExecute({ text: "在吗" });
    const r = await caller.runs({ token: "t", limit: 10 });
    expect(r.ok).toBe(true);
    expect(r.items.length).toBeGreaterThan(0);
  });
});

describe("M69 自进化回路状态面", () => {
  beforeEach(() => resetState());

  it("四段灯 + 计数形状齐备", async () => {
    const evo = await nebulaHarnessEvolution();
    expect(evo.ok).toBe(true);
    expect(evo.signals24h).toBe(3);
    expect(evo.proposals).toEqual({ pending: 2, approved: 1 });
    expect(evo.releases).toEqual({ draft: 1, verified: 4 });
    expect(evo.stages.signal).toBe(true);
    expect(evo.stages.proposal).toBe(true);
    expect(evo.stages.draft).toBe(true);
    expect(evo.stages.arm).toBe(false); // 尚未施工
  });

  it("施工后 arm 段灯亮", async () => {
    process.env.EVO_ARM_ENABLED = "1";
    process.env.EVO_ARM_WORKSPACE = WS;
    await nebulaHarnessExecute({ text: "修复 bug", tier: "construction", releaseId: 501 });
    const evo = await nebulaHarnessEvolution();
    expect(evo.stages.arm).toBe(true);
    expect(evo.lastArmRun?.actor).toBe("nebula-harness");
    delete process.env.EVO_ARM_ENABLED;
    delete process.env.EVO_ARM_WORKSPACE;
    rmSync(WS, { recursive: true, force: true });
  });

  it("router.evolution 过 requireAdmin 闸", async () => {
    const evo = await caller.evolution({ token: "t" });
    expect(evo.ok).toBe(true);
  });
});

describe("M69 宪章与状态面", () => {
  it("宪章新增双运行时融合与自进化段", () => {
    const block = buildExecutiveCharterBlock();
    expect(block).toContain("双运行时融合与自进化");
    expect(block).toContain("47f9438");
    expect(block).toContain("rust-v0.149.0");
    expect(block).toContain("st_harness_runs");
    expect(block).toContain("AI 永不持扳机");
    expect(charterFingerprint()).toMatch(/^nh-[0-9a-f]+$/);
  });

  it("status 带 runtimes 双运行时面（M65 三车道原样保留）", () => {
    const s = nebulaHarnessStatus();
    expect(s.charterFp).toMatch(/^nh-/);
    expect(s.lanes.interactive.slots).toHaveLength(5);
    expect(s.runtimes).toHaveLength(2);
    expect(s.runtimes.map((r) => r.id).sort()).toEqual(["codex", "dsh"]);
    expect(JSON.stringify(s)).not.toContain("sk-");
  });
});
