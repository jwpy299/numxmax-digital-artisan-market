/**
 * healthzMachine 状态机直测（wb#47 R5 票④）：注入可控假 flight 毫秒级驱动时序——
 * ① 健康探测 → 200＋实测延迟；② TTL 内第二发走缓存（factory 仅 1 次，DB 侧限流实现点）；
 * ③ 探测挂起 → 预算点 503＋latencyMs=null（无实测不冒充）；④ await 窗口内换槽 → 追随新航班不 503 假阴；
 * ⑤ 旧代迟到结果不得污染缓存（代际守卫）。
 */
import { describe, expect, it, vi } from "vitest";
import { createHealthzMachine, HEALTHZ_BUDGET_BROKEN, type HealthzFlight } from "./healthzMachine";

/**
 * R26 的不变量：探测临界路径必须全罩 HTTP 预算内。
 * 原来靠**模块加载期 throw** 保住（可见即拦截，代价是常量改错 ⇒ import 即炸、整个 app 起不来）。
 * wb#49 ③ 把它降级为"告警位 + healthz 503"，那这份**守卫就不能跟着一起消失** —— 挪到测试里钉住；
 * 破预算时的降级行为另由 `healthzBudget.test.ts` 用模块 mock 直测。
 */
describe("healthz 预算不变量（wb#49 ③：由测试守住，替代原模块加载期 throw）", () => {
  it("当前常量组合**未**破预算：探测临界 < HTTP 预算 3000ms", () => {
    expect(HEALTHZ_BUDGET_BROKEN).toBe(false);
  });
});

function controllableFlight() {
  let resolve!: (v: { ok: boolean; latencyMs: number }) => void;
  const destroy = vi.fn();
  const promise = new Promise<{ ok: boolean; latencyMs: number }>((res) => { resolve = res; });
  return { flight: { promise, destroy } as HealthzFlight, resolve, destroy };
}

const FAST = { httpTimeoutMs: 60, resultTtlMs: 40, probeMaxAgeMs: 30 };

describe("healthz 状态机", () => {
  it("① 健康探测 → 200＋ok＋实测 latencyMs", async () => {
    const f = controllableFlight();
    const m = createHealthzMachine(() => f.flight, FAST);
    const p = m.handle();
    f.resolve({ ok: true, latencyMs: 12 });
    const v = await p;
    expect(v.status).toBe(200);
    expect(v.body.ok).toBe(true);
    expect(v.body.latencyMs).toBe(12);
    expect(v.body.measured).toBe(true);
  });

  it("② TTL 内第二发走缓存（factory 仅 1 次＝DB 侧限流实现点）", async () => {
    const f = controllableFlight();
    const factory = vi.fn(() => f.flight);
    const m = createHealthzMachine(factory, FAST);
    const p1 = m.handle();
    f.resolve({ ok: true, latencyMs: 5 });
    await p1;
    const v2 = await m.handle(); // TTL 40ms 内
    expect(v2.status).toBe(200);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("③ 探测挂起 → 预算点 503＋measured=false（无实测不冒充 DB 延迟，语义由 measured 承载）", { timeout: 10_000 }, async () => {
    const f = controllableFlight(); // 永不 resolve
    const m = createHealthzMachine(() => f.flight, FAST);
    const v = await m.handle();
    expect(v.status).toBe(503);
    expect(v.body.ok).toBe(false);
    expect(v.body.measured).toBe(false);
    expect(typeof v.body.latencyMs).toBe("number"); // 恒数值（外部消费契约）
  });

  it("④ await 窗口内换槽 → 追随新航班，不拿被毁航班的假 503", async () => {
    const a = controllableFlight();
    const bFlight = controllableFlight();
    let calls = 0;
    const m = createHealthzMachine(() => (++calls === 1 ? a.flight : bFlight.flight), FAST);
    const p1 = m.handle(); // 认航班 A（挂起中）
    await new Promise((r) => setTimeout(r, 35)); // 超过 probeMaxAgeMs=30，A 超龄
    const p2 = m.handle(); // 触发换槽：A 被 destroy，B 上槽
    bFlight.resolve({ ok: true, latencyMs: 7 });
    const [v1, v2] = await Promise.all([p1, p2]);
    expect(a.destroy).toHaveBeenCalledTimes(1); // 换槽毁旧探测
    expect(v1.status).toBe(200); // 追随新航班：不假 503
    expect(v2.status).toBe(200);
  });

  it("⑤ 旧代迟到结果不得污染缓存（代际守卫）", async () => {
    const a = controllableFlight();
    const bFlight = controllableFlight();
    let calls = 0;
    const m = createHealthzMachine(() => (++calls === 1 ? a.flight : bFlight.flight), FAST);
    const p1 = m.handle(); // 认 A
    await new Promise((r) => setTimeout(r, 35));
    const p2 = m.handle(); // 换槽到 B
    bFlight.resolve({ ok: true, latencyMs: 3 });
    await p2; // B 结算落缓存（ok:true）
    a.resolve({ ok: false, latencyMs: 999 }); // 旧代 A 迟到失败——不得覆盖缓存
    await p1;
    const v3 = await m.handle(); // TTL 内读缓存：仍应是 B 的 ok:true
    expect(v3.status).toBe(200);
    expect(v3.body.ok).toBe(true);
  });

  it("⑥ 换槽追随真实路径：latched 被取消（destroy 结算 ok:false）→ 缓存未写 → 追随新航班结算返其真实测", async () => {
    // A 航班：destroy 时 resolve 取消 artifact（模拟生产 dbProbeFlight 被取消语义）
    let resolveA!: (v: { ok: boolean; latencyMs: number }) => void;
    const destroyA = vi.fn(() => resolveA({ ok: false, latencyMs: 1 }));
    const aFlight: HealthzFlight = { promise: new Promise((res) => { resolveA = res; }), destroy: destroyA };
    const b = controllableFlight();
    let calls = 0;
    const m = createHealthzMachine(() => (++calls === 1 ? aFlight : b.flight), { httpTimeoutMs: 200, resultTtlMs: 40, probeMaxAgeMs: 30 });
    const p1 = m.handle(); // 认 A
    await new Promise((r) => setTimeout(r, 35)); // A 超龄
    const p2 = m.handle(); // 换槽：destroyA → A resolve {ok:false}（取消 artifact）；B 上槽未结算（缓存未写）
    b.resolve({ ok: true, latencyMs: 9 }); // B 在追随预算内结算
    const [v1, v2] = await Promise.all([p1, p2]);
    expect(v1.status).toBe(200); // 追随成功：拿 B 的真实测（不拿 A 的取消 artifact 报 503 假阴）
    expect(v1.body.ok).toBe(true);
    expect(v1.body.latencyMs).toBe(9);
    expect(v1.body.measured).toBe(true); // 追随成功=当代实测
    expect(v2.status).toBe(200);
  });
});

describe("契约⑤ healthz 统一 schema 钉", () => {
  it("body 恒带 service+version（缺键=红——deploy-check 一次 curl 面）", async () => {
    const f = controllableFlight();
    const m = createHealthzMachine(() => f.flight, FAST);
    const p = m.handle();
    f.resolve({ ok: true, latencyMs: 5 });
    const v = await p;
    expect(v.status).toBe(200);
    expect(v.body.service).toBe(process.env.HEALTHZ_SERVICE ?? "portal"); // 缺省本仓名（env 优先面）
    expect(v.body.version).toMatch(/^([0-9a-f]{7,40}|unknown)$/); // git sha 或 unknown 降级——不空不炸
  });
});
