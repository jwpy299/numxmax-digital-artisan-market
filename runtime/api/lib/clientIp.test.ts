import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("@hono/node-server/conninfo");
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function fresh(peer: string | undefined) {
  vi.resetModules();
  vi.doMock("@hono/node-server/conninfo", () => ({ getConnInfo: () => ({ remote: { address: peer } }) }));
  return import("./clientIp");
}
const ctx = (xff?: string) => ({ req: { header: () => xff } }) as never;

describe("clientIp socket peer 信任边界", () => {
  it("可信 peer 默认取 XFF 末跳；unknown/主机名/ip:port/X-Real-IP 均失败关闭并留痕", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { clientIp } = await fresh("127.0.0.1");
    expect(clientIp(ctx("198.51.100.8, 203.0.113.10"))).toBe("203.0.113.10");
    expect(clientIp(ctx("unknown"))).toBe("");
    expect(clientIp(ctx("client.example.com"))).toBe("");
    expect(clientIp(ctx("203.0.113.10:8080"))).toBe("");
    expect(clientIp(ctx())).toBe("");
    expect(console.warn).toHaveBeenCalled();
  });

  it("TRUSTED_PROXY_HOPS=2 时验证 CDN 跳属于信任集再回跳", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    vi.stubEnv("TRUSTED_PROXIES", "127.0.0.1,203.0.113.11");
    const { clientIp } = await fresh("127.0.0.1");
    expect(clientIp(ctx("198.51.100.8, 203.0.113.10, 203.0.113.11"))).toBe("203.0.113.10");
  });

  it("代理层数大于真实链时不许取客户端伪造的左侧 XFF", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    const { clientIp } = await fresh("127.0.0.1");
    expect(clientIp(ctx("198.51.100.8, 203.0.113.10"))).toBe("");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("不在 TRUSTED_PROXIES"));
  });

  it("候选仍在信任集=代理层数配置不足，拒绝把代理当客户", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("TRUSTED_PROXIES", "127.0.0.1,203.0.113.10");
    const { clientIp } = await fresh("127.0.0.1");
    expect(clientIp(ctx("203.0.113.10"))).toBe("");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("小于实际代理链"));
  });

  it("非可信 peer 只回真实 peer；无 peer 证据=空串", async () => {
    const direct = await fresh("203.0.113.20");
    expect(direct.clientIp(ctx("198.51.100.1"))).toBe("203.0.113.20");
    const missing = await fresh(undefined);
    expect(missing.clientIp(ctx("203.0.113.10"))).toBe("");
  });

  it("IPv4-mapped 与 IPv6 压缩/展开/大小写全部归一后再判可信", async () => {
    const mapped = await fresh("::ffff:127.0.0.1");
    expect(mapped.clientIp(ctx("::ffff:203.0.113.12"))).toBe("203.0.113.12");
    const hexMapped = await fresh("::ffff:7f00:1");
    expect(hexMapped.clientIp(ctx("203.0.113.13"))).toBe("203.0.113.13");
    vi.stubEnv("TRUSTED_PROXIES", "0:0:0:0:0:0:0:1");
    const v6 = await fresh("0:0:0:0:0:0:0:1");
    expect(v6.clientIp(ctx("FE80::1"))).toBe("fe80::1");
  });

  it("rateIpDigest：HMAC 与无盐回退可区分且告警", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("RATE_KEY_SECRET", "r".repeat(32));
    const keyed = await fresh("127.0.0.1");
    const hmac = keyed.rateIpDigest("203.0.113.10");
    expect(hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(hmac).not.toBe("366ae2b4aa9e6bc89b98c8b5831d46303e45cd49b2970c2b3921de5f2fcfc2e1");
    vi.stubEnv("RATE_KEY_SECRET", "");
    const plain = await fresh("127.0.0.1");
    expect(plain.rateIpDigest("203.0.113.10")).not.toBe(hmac);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("可枚举无盐 SHA-256"));
  });

  it("显式空 TRUSTED_PROXIES=空信任集；空集与非可信 XFF 两类告警不互吞", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("TRUSTED_PROXIES", "");
    const { clientIp } = await fresh("127.0.0.1");
    expect(clientIp(ctx("203.0.113.10"))).toBe("127.0.0.1");
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("仅分隔符的代理配置也按空信任集显式告警", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("TRUSTED_PROXIES", " , ");
    const { clientIp } = await fresh("127.0.0.1");
    expect(clientIp(ctx("203.0.113.10"))).toBe("127.0.0.1");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("未解析出任何 IP"));
  });

  it("无效代理项不误放；配置与非可信 XFF 告警分桶", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("TRUSTED_PROXIES", "proxy.internal");
    const { clientIp } = await fresh("127.0.0.1");
    expect(clientIp(ctx("203.0.113.10"))).toBe("127.0.0.1");
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});
