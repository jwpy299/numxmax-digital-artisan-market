import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(`./${rel}`, import.meta.url), "utf-8");

describe("clientIp 单一证据来源与桶生命周期", () => {
  it("协议签署/客服/SSE/导购不再从客户端头自报 IP", () => {
    for (const rel of ["routers/sandbox.ts", "routers/assistant.ts"]) {
      const src = read(rel);
      expect(src).toContain("clientIp");
      expect(src).not.toContain('headers?.get?.("x-forwarded-for")');
      expect(src).not.toContain('headers?.get?.("x-real-ip")');
    }
    const stream = read("routers/streamBus.ts");
    if (stream.includes("csSessionKeyOf(sessionId")) {
      expect(stream).toContain("csSessionKeyOf(sessionId, clientIp(c)");
      expect(stream).not.toContain('c.req.header("cf-connecting-ip")');
    }
    const packages = read("routers/packages.ts");
    if (packages.includes("recommendByNeed")) {
      expect(packages).toContain('const ip = ctx.clientIp ?? "";');
      expect(packages).not.toContain('ip || "anon"');
    }
  });

  it("context 强制调用方注入 IP；导购桶保留期与真实清理一致", () => {
    const ctx = read("context.ts");
    expect(ctx).toContain("FetchCreateContextFnOptions & { clientIp: string }");
    expect(ctx).not.toContain("clientIp?: string");
    const lifecycle = read("../contracts/dataLifecycle.ts");
    expect(lifecycle).toContain('table: "st_qr_rate", dataClass: "遥测", retentionDays: 1');
    expect(lifecycle).toContain("其余桶（含历史裸 IP/__global__）24h 兜底清");
    expect(lifecycle).toContain("键优先 HMAC(RATE_KEY_SECRET)");
  });
});
