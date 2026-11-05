/**
 * M61 llmLatencyBoard（adminAnalytics）——模型时延看板聚合闸。
 * 口径：st_llm_events 窗口聚合；slot/context/hourly 三维；firstTokenMs 只统计流式行；
 * 表不存在 → available=false 全 null 降级；requireAdmin 闸。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ─── 假库：只认 st_llm_events 窗口聚合 SELECT，其余空集 ──────────────────────
type Row = Record<string, unknown>;
let llmRows: Row[] = [];
let dbThrow = false;

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    execute: async () => {
      // caller 只调 llmLatencyBoard，单条窗口 SELECT；聚合逻辑是测试目标，SQL 文本不解析
      if (dbThrow) throw new Error("db down");
      return [llmRows, []] as never; // 真 drizzle 元组形（[rows, fields]——canonical rawRows 提 [0]；旧 {rows} 形是配 terminal mock 的缠面——adminAnalytics 改直引 canonical 后 mock 面同改[A 堆对齐①]）
    },
  }),
}));

// requireAdmin 放行（terminal 模块其余原样）
vi.mock("./routers/terminal", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    requireAdmin: vi.fn(async () => ({ id: 1, name: "hq-admin" })),
    // rawRows mock 面摘（adminAnalytics 改直引 queries/rawRows canonical——rawRows 行为钉位移到 canonical 件面，不再 mock 中转面[A 堆对齐①]）
  };
});

import { adminAnalyticsRouter } from "./routers/adminAnalytics";

const caller = adminAnalyticsRouter.createCaller({} as never);

function mkRow(over: Partial<Row> = {}): Row {
  return {
    slot: "flash",
    context: "voice_utterance",
    ok: 1,
    fallback: 0,
    latencyMs: 1000,
    firstTokenMs: 400,
    createdAt: new Date("2026-08-22T03:00:00Z"),
    ...over,
  };
}

describe("M61 llmLatencyBoard 模型时延看板", () => {
  beforeEach(() => {
    llmRows = [];
    dbThrow = false;
  });

  it("空窗口：available=true，summary 全 0/null，三维为空", async () => {
    const r = await caller.llmLatencyBoard({ token: "t", hours: 24 });
    expect(r.available).toBe(true);
    expect(r.summary?.calls).toBe(0);
    expect(r.summary?.okRate).toBeNull();
    expect(r.summary?.avgLatencyMs).toBeNull();
    expect(r.bySlot).toEqual([]);
    expect(r.hourly).toEqual([]);
  });

  it("summary 聚合：okRate/fallbackRate/avg/p95/firstToken 均值口径正确", async () => {
    llmRows = [
      mkRow({ latencyMs: 100, firstTokenMs: 50 }),
      mkRow({ latencyMs: 200, firstTokenMs: 80, ok: 0 }), // 失败行
      mkRow({ latencyMs: 300, firstTokenMs: null, fallback: 1 }), // 降级行，非流式
      mkRow({ latencyMs: 10000, firstTokenMs: 9000 }), // 长尾（拉高 p95）
    ];
    const r = await caller.llmLatencyBoard({ token: "t", hours: 24 });
    expect(r.summary?.calls).toBe(4);
    expect(r.summary?.okRate).toBe(75);
    expect(r.summary?.fallbackRate).toBe(25);
    expect(r.summary?.avgLatencyMs).toBe(2650); // (100+200+300+10000)/4
    expect(r.summary?.p95LatencyMs).toBe(10000); // ceil(4*0.95)=4 → 第4个
    // firstToken 只统计有值的 3 行：(50+80+9000)/3=3043.33→3043
    expect(r.summary?.avgFirstTokenMs).toBe(3043);
    expect(r.summary?.streamCalls).toBe(3);
  });

  it("bySlot 分槽聚合并按 calls 降序", async () => {
    llmRows = [
      mkRow({ slot: "brain", latencyMs: 5000, firstTokenMs: null }),
      mkRow({ slot: "flash", latencyMs: 100 }),
      mkRow({ slot: "flash", latencyMs: 300 }),
    ];
    const r = await caller.llmLatencyBoard({ token: "t", hours: 168 });
    expect(r.bySlot.map((s) => s.name)).toEqual(["flash", "brain"]);
    const flash = r.bySlot[0];
    expect(flash.calls).toBe(2);
    expect(flash.avgLatencyMs).toBe(200);
    expect(flash.streamCalls).toBe(2);
    const brain = r.bySlot[1];
    expect(brain.avgFirstTokenMs).toBeNull();
  });

  it("byContext 分场景聚合，超 12 个场景截断", async () => {
    llmRows = Array.from({ length: 15 }, (_, i) =>
      mkRow({ context: `ctx_${String(i).padStart(2, "0")}` }),
    );
    const r = await caller.llmLatencyBoard({ token: "t", hours: 24 });
    expect(r.byContext.length).toBe(12);
    expect(r.byContext.every((c) => c.calls === 1)).toBe(true);
  });

  it("hourly 逐小时桶按 UTC+8 标签且升序", async () => {
    llmRows = [
      mkRow({ createdAt: new Date("2026-08-22T01:30:00Z"), latencyMs: 100 }), // 09:00 +08
      mkRow({ createdAt: new Date("2026-08-22T01:50:00Z"), latencyMs: 300 }), // 09:00 +08
      mkRow({ createdAt: new Date("2026-08-22T03:05:00Z"), latencyMs: 900 }), // 11:00 +08
    ];
    const r = await caller.llmLatencyBoard({ token: "t", hours: 24 });
    expect(r.hourly.map((h) => h.bucket)).toEqual(["2026-08-22 09:00", "2026-08-22 11:00"]);
    expect(r.hourly[0].calls).toBe(2);
    expect(r.hourly[0].avgLatencyMs).toBe(200);
    expect(r.hourly[1].calls).toBe(1);
  });

  it("createdAt 缺失的行不进 hourly 但计入 summary", async () => {
    llmRows = [mkRow({ createdAt: null, latencyMs: 500 }), mkRow({ latencyMs: 100 })];
    const r = await caller.llmLatencyBoard({ token: "t", hours: 24 });
    expect(r.summary?.calls).toBe(2);
    expect(r.hourly.length).toBe(1);
  });

  it("表不存在/查询失败：available=false + 全 null 降级，绝不抛错", async () => {
    dbThrow = true;
    const r = await caller.llmLatencyBoard({ token: "t", hours: 24 });
    expect(r.available).toBe(false);
    expect(r.summary).toBeNull();
    expect(r.bySlot).toEqual([]);
  });

  it("hours 入参越界被 zod 拦截", async () => {
    await expect(caller.llmLatencyBoard({ token: "t", hours: 0 })).rejects.toThrow();
    await expect(caller.llmLatencyBoard({ token: "t", hours: 721 })).rejects.toThrow();
  });

  it("firstTokenMs 全 null 时 avgFirstTokenMs=null 且 streamCalls=0", async () => {
    llmRows = [mkRow({ firstTokenMs: null }), mkRow({ firstTokenMs: null })];
    const r = await caller.llmLatencyBoard({ token: "t", hours: 24 });
    expect(r.summary?.avgFirstTokenMs).toBeNull();
    expect(r.summary?.streamCalls).toBe(0);
  });
});
