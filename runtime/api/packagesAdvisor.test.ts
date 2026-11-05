/** portal#71 导购端面行为钉（high②——wb 同面 12 例适配搬：端点调用壳+四闸面）。 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ADVISOR_TIMEOUT_MS, callAdvisorPoolPortal, packagesRouter } from "./routers/packages";
import { readFileSync } from "node:fs";

type FetchCall = { url: string; init: { headers?: Record<string, string>; body?: string } };
type StubResp = { status: number; json: () => Promise<unknown> };
let calls: FetchCall[] = [];
let stubImpl: () => Promise<StubResp>;
const origFetch = globalThis.fetch;
const origToken = process.env.DSH_SERVICE_TOKEN;

describe("portal#71 callAdvisorPoolPortal 导购调用壳（门户面）", () => {
  beforeEach(() => {
    calls = [];
    process.env.DSH_SERVICE_TOKEN = "test-ht";
    globalThis.fetch = ((url: string, init: FetchCall["init"]) => { calls.push({ url, init }); return stubImpl(); }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origToken === undefined) delete process.env.DSH_SERVICE_TOKEN; else process.env.DSH_SERVICE_TOKEN = origToken;
  });

  it("调用面：会话隔离派生键+任务构建契约件+token 单点", async () => {
    stubImpl = async () => ({ status: 200, json: async () => ({ ok: true, answer: '[{"pkgKey":"fin_basic","reason":"r"}]' }) });
    const r = await callAdvisorPoolPortal("报销乱", "ip|ua|sid-1");
    expect(r?.[0]?.pkgKey).toBe("fin_basic");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.stationKey).toMatch(/^adv-[0-9a-f]{16}$/); // 会话隔离派生键（异客异会话）
    expect(body.task).toContain("报销乱");
    expect(body.task).toContain("【本次任务】");
    expect(body.timeoutSec).toBe(ADVISOR_TIMEOUT_MS / 1000); // 钉随迁：跟常量面
    expect(body.timeoutSec * 1000).toBe(ADVISOR_TIMEOUT_MS); // 两帽同值钉（NumX low-1 面：abort 帽也钉——发散=红）; // 与 AbortSignal 对齐（medium③修）
    expect(calls[0].init.headers?.authorization).toBe("Bearer test-ht");
  });

  it("异 visitorKey 异工位/同键同工位（串味封死——wb#94/97 同律）", async () => {
    stubImpl = async () => ({ status: 200, json: async () => ({ ok: true, answer: "[]" }) });
    await callAdvisorPoolPortal("A", "ip1|ua|s1");
    await callAdvisorPoolPortal("B", "ip2|ua|s2");
    await callAdvisorPoolPortal("A2", "ip1|ua|s1");
    const keys = calls.map((c) => JSON.parse(String(c.init.body)).stationKey);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe(keys[0]);
  });

  it("guarded/脏面/故障/未配 token=全 null 兜底接", async () => {
    stubImpl = async () => ({ status: 200, json: async () => ({ ok: true, guarded: true, answer: "C 级…" }) });
    expect(await callAdvisorPoolPortal("x", "k")).toBeNull();
    calls = [];
    stubImpl = async () => ({ status: 200, json: async () => ({ ok: true, answer: "没有数组" }) });
    expect(await callAdvisorPoolPortal("x", "k")).toBeNull();
    calls = [];
    stubImpl = async () => { throw new Error("down"); };
    expect(await callAdvisorPoolPortal("x", "k")).toBeNull();
    calls = [];
    delete process.env.DSH_SERVICE_TOKEN;
    expect(await callAdvisorPoolPortal("x", "k")).toBeNull();
    expect(calls.length).toBe(0);
  });
});

describe("portal#71 端点四闸静态钉（screenText/限流/键收敛/留痕——源码面）", () => {
  const src = readFileSync(new URL("./routers/packages.ts", import.meta.url), "utf-8");
  it("四闸在：screenText 先行+st_qr_rate 同款限流+visitorKey 混入收敛+留痕同表", () => {
    expect(src).toContain("screenText(input.need)"); // UGC 初筛先行
    expect(src).toContain("rec-portal:"); // 限流桶面（st_qr_rate 同表）
    expect(src).toContain("rec-portal:${rateIpDigest(ip).slice(0, 32)}"); // 不明文落 IP
    expect(src).toContain('const ip = ctx.clientIp ?? "";');
    expect(src).not.toContain('ip || "anon"');
    expect(src).toContain("`${ip}|${ua}|${input.sessionId ?? \"\"}`"); // 键收敛（伪造 sessionId 逃不出 IP+UA 面）
    expect(src).toContain("nh_recommend_queries"); // 留痕同表（转化漏斗同账）
    expect(src).toContain("rate_limited"); // 429 面
  });
  it("端点已挂 router（recommendByNeed 在 packagesRouter）", () => {
    expect(src).toContain("recommendByNeed: publicQuery");
    expect(typeof packagesRouter).toBe("object");
  });
});
