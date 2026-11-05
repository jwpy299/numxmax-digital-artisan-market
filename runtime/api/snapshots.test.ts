/**
 * M8-b 快照引擎验收单测：
 * 1. 读写往返：writeSnapshot → readSnapshot 内容/降级/版本一致；
 * 2. ON DUPLICATE KEY UPDATE：同 scope+skey 二次写入覆盖旧内容（且 SQL 确为 ON DUPLICATE）；
 * 3. 快照 content 过 stripSecrets：st_/pk_ 敏感串不落快照；
 * 4. dutyBriefing 快照命中（30 分钟内 → fromSnapshot:true，不再调 LLM）；过期 → 现场生成；
 * 5. 缺失自愈：无快照 → 现场生成返回 + 异步补写快照；快照层故障不影响主流程；
 * 6. 事件钩子：gate 执行成功 / emitSignal 新信号 → 触发刷新；生成器异常不影响主流程返回值；
 * 7. plannerStats 快照命中（10 分钟）+ 缺失自愈；
 * 8. dutyChat 先答后想：facts 独立于 LLM 可用（LLM 故障 facts 仍为真实数据）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const chatMock = vi.fn();

vi.mock("./routers/modelGateway", () => ({
  callSlotChat: (...args: unknown[]) => chatMock(...args),
}));

// ─── 状态ful 假 DB：按 SQL 文本路由到内存夹具，st_snapshots 用内存表模拟 ──────

type Row = Record<string, unknown>;
interface SnapRow {
  content: string;
  data_version: string | null;
  degraded: number;
  generated_at: string;
}

const snapshotTable = new Map<string, SnapRow>();
let lastSnapshotInsertSql = "";

interface Fixtures {
  protocols: Row[];
  signals: Row[];
  plansAgg: Row;
  silent: Row[];
  frozenAgg: Row[];
  frozenEvents: Row[];
  planStatus: Row[];
  planDaily: Row[];
  rejected: Row[];
  constitution: Row[];
  ticket: Row;
}
let fixtures: Fixtures;
let throwOn: RegExp | null = null;

function defaultFixtures(): Fixtures {
  return {
    protocols: [],
    signals: [],
    plansAgg: { total: 0, today: 0, executed: 0, pendingConfirm: 0, failed: 0 },
    silent: [],
    frozenAgg: [],
    frozenEvents: [],
    planStatus: [],
    planDaily: [],
    rejected: [],
    constitution: [{ lv: "B" }],
    ticket: { id: 1, usedAt: null, expiresAt: new Date(Date.now() + 60_000).toISOString() },
  };
}

function route(text: string, params: unknown[]): unknown {
  if (throwOn && throwOn.test(text)) throw new Error("boom: 快照层故障");
  // st_snapshots：内存表模拟（INSERT ... ON DUPLICATE KEY UPDATE → upsert）
  if (text.includes("INSERT INTO st_snapshots")) {
    lastSnapshotInsertSql = text;
    const [scope, skey, content, dataVersion, degraded] = params as [string, string, string, string | null, number];
    snapshotTable.set(`${scope}|${skey}`, {
      content,
      data_version: dataVersion,
      degraded: Number(degraded) || 0,
      generated_at: new Date().toISOString(),
    });
    return [[]];
  }
  if (text.includes("FROM st_snapshots")) {
    const [scope, skey] = params as [string, string];
    const row = snapshotTable.get(`${scope}|${skey}`);
    return [
      row
        ? [{ content: row.content, degraded: row.degraded, generatedAt: row.generated_at, dataVersion: row.data_version }]
        : [],
    ];
  }
  if (text.includes("INSERT INTO st_auto_signals")) return [[]];
  if (text.includes("FROM st_auto_signals")) return [fixtures.signals];
  if (text.includes("FROM st_protocols")) return [fixtures.protocols];
  if (text.includes("FROM st_auto_constitution")) return [fixtures.constitution];
  if (text.includes("FROM st_gate_tickets")) return [[fixtures.ticket]];
  if (text.includes("LAST_INSERT_ID")) return [[{ id: 1 }]];
  if (text.includes("FROM st_intent_plans")) {
    if (text.includes("SUM(")) return [[fixtures.plansAgg]];
    if (text.includes("GROUP BY status")) return [fixtures.planStatus];
    if (text.includes("DATE(created_at)")) return [fixtures.planDaily];
    return [[]];
  }
  // 注意顺序：沉默企业查询含 NOT IN (SELECT ... FROM st_intents ...) 子查询，须先判 wb_factories
  if (text.includes("FROM wb_factories")) return [fixtures.silent];
  if (text.includes("FROM st_intents")) return [fixtures.rejected];
  if (text.includes("FROM st_freeze_events")) {
    return [text.includes("GROUP BY factory_id") ? fixtures.frozenAgg : fixtures.frozenEvents];
  }
  return [[]];
}

vi.mock("./queries/connection", async () => {
  const { MySqlDialect } = await import("drizzle-orm/mysql-core");
  const dialect = new MySqlDialect();
  return {
    getDb: () => {
      const db = {
      
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
      execute: async (stmt: unknown) => {
        const q = dialect.sqlToQuery(stmt as never);
        return route(q.sql, q.params);
      },
      };
      // R7-c143-②：事务 shim——tx 共享同一路由（内存仓等价同连接语义）
      return { ...db, transaction: async (fn: (tx: typeof db) => Promise<unknown>) => fn(db) };
    },
  };
});

import { readSnapshot, writeSnapshot, refreshSnapshot, __resetDutyRefreshThrottleForTest } from "./routers/snapshots";
import { dutyBriefingCore, plannerStatsCore, dutyChatCore } from "./routers/adminAi";
import { emitSignal } from "./routers/autoEngine";
import { submitIntent } from "./routers/gate";

/** 等待 fire-and-forget 钩子落地（全部异步操作即时完成，轮询内存表即可） */
async function flushHooks(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("flushHooks 超时：钩子未落地");
    await new Promise((r) => setImmediate(r));
  }
}

const briefPayload = {
  briefing: "缓存晨报：今日平稳",
  degraded: false,
  brief: {
    pendingProtocols: [],
    openSignals24h: { levelB: 0, levelC: 0, levelD: 0 },
    plans: { total: 0, today: 0, executed: 0, pendingConfirm: 0, failed: 0 },
    silentFactories7d: [],
    frozenFactories: 0,
  },
  generatedAt: new Date().toISOString(),
};

beforeEach(() => {
  chatMock.mockReset();
  chatMock.mockResolvedValue({ ok: true, content: "LLM晨报正文" });
  snapshotTable.clear();
  lastSnapshotInsertSql = "";
  fixtures = defaultFixtures();
  throwOn = null;
  __resetDutyRefreshThrottleForTest();
});

describe("快照读写（readSnapshot/writeSnapshot）", () => {
  it("读写往返：内容/降级/版本一致", async () => {
    await writeSnapshot("platform", "t1", "内容A", "v1", true);
    const snap = await readSnapshot("platform", "t1");
    expect(snap).not.toBeNull();
    expect(snap!.content).toBe("内容A");
    expect(snap!.degraded).toBe(true);
    expect(snap!.dataVersion).toBe("v1");
    expect(Number.isFinite(new Date(snap!.generatedAt).getTime())).toBe(true);
  });

  it("未写入的键 → null", async () => {
    expect(await readSnapshot("platform", "ghost")).toBeNull();
  });

  it("ON DUPLICATE KEY UPDATE：同键二次写入覆盖", async () => {
    await writeSnapshot("platform", "t2", "旧内容", "v1", false);
    await writeSnapshot("platform", "t2", "新内容", "v2", true);
    expect(lastSnapshotInsertSql).toContain("ON DUPLICATE KEY UPDATE");
    expect(snapshotTable.size).toBe(1);
    const snap = await readSnapshot("platform", "t2");
    expect(snap!.content).toBe("新内容");
    expect(snap!.dataVersion).toBe("v2");
    expect(snap!.degraded).toBe(true);
  });

  it("content 过 stripSecrets：st_/pk_ 敏感串不落快照", async () => {
    await writeSnapshot("platform", "t3", "编号 st_abc123 与 pk_xyz999 不可见", null, false);
    const snap = await readSnapshot("platform", "t3");
    expect(snap!.content).not.toMatch(/st_abc123|pk_xyz999/);
    expect(snap!.content).toContain("[已遮蔽]");
  });

  it("refreshSnapshot：生成器异常只记日志、永不外抛", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      refreshSnapshot("platform", "bad", async () => {
        throw new Error("生成器爆炸");
      }),
    ).resolves.toBeUndefined();
    expect(snapshotTable.has("platform|bad")).toBe(false);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("dutyBriefing 快照优先 + 自愈", () => {
  it("快照命中（30 分钟内）→ fromSnapshot:true 且不调 LLM", async () => {
    snapshotTable.set("platform|duty-briefing", {
      content: JSON.stringify(briefPayload),
      data_version: briefPayload.generatedAt,
      degraded: 0,
      generated_at: new Date().toISOString(),
    });
    const r = await dutyBriefingCore();
    expect(r.fromSnapshot).toBe(true);
    expect(r.briefing).toBe("缓存晨报：今日平稳");
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("快照过期（>30 分钟）→ 现场生成 fromSnapshot:false", async () => {
    snapshotTable.set("platform|duty-briefing", {
      content: JSON.stringify(briefPayload),
      data_version: null,
      degraded: 0,
      generated_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    });
    const r = await dutyBriefingCore();
    expect(r.fromSnapshot).toBe(false);
    expect(r.briefing).toBe("LLM晨报正文");
    expect(chatMock).toHaveBeenCalled();
  });

  it("快照缺失 → 现场生成 + 异步补写（自愈）", async () => {
    const r = await dutyBriefingCore();
    expect(r.fromSnapshot).toBe(false);
    expect(r.briefing).toBe("LLM晨报正文");
    await flushHooks(() => snapshotTable.has("platform|duty-briefing"));
    const snap = await readSnapshot("platform", "duty-briefing");
    const cached = JSON.parse(snap!.content) as { briefing: string; degraded: boolean };
    expect(cached.briefing).toBe("LLM晨报正文");
    // 自愈完成后，下一次读取命中快照
    chatMock.mockClear();
    const r2 = await dutyBriefingCore();
    expect(r2.fromSnapshot).toBe(true);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("快照层故障（表未建/库抖动）→ 静默回落现场生成，主流程不受影响", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    throwOn = /st_snapshots/;
    const r = await dutyBriefingCore();
    expect(r.fromSnapshot).toBe(false);
    expect(r.briefing).toBe("LLM晨报正文");
    expect(typeof r.generatedAt).toBe("string");
    errSpy.mockRestore();
  });
});

describe("事件钩子（fire-and-forget，绝不影响主流程）", () => {
  it("emitSignal 新信号落库 → 触发 duty-briefing 快照刷新", async () => {
    await emitSignal(10, "ticket", "C", "协议执行失败已回滚：测试协议", "detail");
    await flushHooks(() => snapshotTable.has("platform|duty-briefing"));
    const snap = await readSnapshot("platform", "duty-briefing");
    expect(JSON.parse(snap!.content)).toMatchObject({ briefing: "LLM晨报正文" });
  });

  it("gate 执行成功落库 → 触发 duty-briefing 快照刷新", async () => {
    fixtures.protocols = [{ code: "device_rehearsal", name: "设备预演工单", level: "B", status: "active" }];
    const r = await submitIntent({
      actor: { username: "boss", role: "owner", factoryId: 10 },
      actionType: "device_rehearsal",
      payload: { deviceName: "CNC-01" },
    });
    expect(r.status).toBe("executed");
    await flushHooks(() => snapshotTable.has("platform|duty-briefing"));
  });

  it("钩子内生成器异常 → 主流程返回不受影响（异常只记日志）", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixtures.protocols = [{ code: "device_rehearsal", name: "设备预演工单", level: "B", status: "active" }];
    // 只让快照生成器的聚合查询爆炸（loadProtocol 走 WHERE code = ?，不受影响）
    throwOn = /WHERE status IN/;
    const r = await submitIntent({
      actor: { username: "boss", role: "owner", factoryId: 10 },
      actionType: "device_rehearsal",
      payload: { deviceName: "CNC-01" },
    });
    expect(r.status).toBe("executed");
    expect(r.intentId).toBe(1);
    await flushHooks(() => errSpy.mock.calls.some((c) => String(c[0]).includes("[snapshots]")));
    expect(snapshotTable.has("platform|duty-briefing")).toBe(false);
    errSpy.mockRestore();
  });
});

describe("plannerStats 快照化（10 分钟）", () => {
  const statsPayload = {
    plans: { total: 3, byStatus: { executed: 2, failed: 1 }, successRate: 67, failureRate: 33 },
    daily: [{ date: "2026-01-01", count: 3 }],
    rejectedByChannel: [{ channel: "voice", count: 1 }],
  };

  it("快照命中 → fromSnapshot:true 直接返回缓存", async () => {
    snapshotTable.set("platform|planner-stats", {
      content: JSON.stringify(statsPayload),
      data_version: null,
      degraded: 0,
      generated_at: new Date().toISOString(),
    });
    const r = await plannerStatsCore();
    expect(r.fromSnapshot).toBe(true);
    expect(r.plans.total).toBe(3);
    expect(r.rejectedByChannel).toEqual([{ channel: "voice", count: 1 }]);
  });

  it("快照缺失 → 现场计算 + 异步补写", async () => {
    fixtures.planStatus = [
      { status: "executed", c: 2 },
      { status: "failed", c: 1 },
    ];
    const r = await plannerStatsCore();
    expect(r.fromSnapshot).toBe(false);
    expect(r.plans.total).toBe(3);
    expect(r.plans.successRate).toBe(67);
    await flushHooks(() => snapshotTable.has("platform|planner-stats"));
    const r2 = await plannerStatsCore();
    expect(r2.fromSnapshot).toBe(true);
  });
});

describe("dutyChat 先答后想（facts 独立于 LLM）", () => {
  beforeEach(() => {
    fixtures.protocols = [{ code: "p1", name: "测试协议", level: "B", status: "draft" }];
    fixtures.signals = [{ level: "C", c: 2 }];
    fixtures.plansAgg = { total: 5, today: 1, executed: 3, pendingConfirm: 1, failed: 1 };
    fixtures.silent = [{ id: 9, name: "某某厂" }];
    fixtures.frozenAgg = [{ factory_id: 1, fz: 1, ufz: 0 }];
  });

  it("LLM 可用：facts + reply 同返，facts 为真实数据要点", async () => {
    chatMock.mockResolvedValue({ ok: true, content: "灵枢解读：C 级信号偏多" });
    const r = await dutyChatCore("信号怎么样？");
    expect(r.degraded).toBe(false);
    expect(r.reply).toBe("灵枢解读：C 级信号偏多");
    expect(r.facts.length).toBeGreaterThanOrEqual(4);
    expect(r.facts.join("\n")).toContain("p1");
    expect(r.facts.join("\n")).toContain("C级 2 条");
    expect(r.facts.join("\n")).toContain("某某厂");
    expect(r.facts.join("\n")).toContain("冻结中企业：1 家");
  });

  it("LLM 故障：reply 降级兜底，facts 依然为真实数据（先行可展示）", async () => {
    chatMock.mockResolvedValue({ ok: false, reason: "not_configured" });
    const r = await dutyChatCore("信号怎么样？");
    expect(r.degraded).toBe(true);
    expect(r.reply).toContain("值守线路有点杂音");
    expect(r.facts.join("\n")).toContain("C级 2 条");
    expect(r.facts.join("\n")).toContain("累计 5 个");
  });
});
