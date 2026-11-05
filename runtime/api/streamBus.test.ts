/**
 * M9-a 事件驱动主动播报验收单测（app.fetch 打 GET /api/stream/events + publishBroadcast）：
 * 1. 无效 token → 401；
 * 2. 广播权限隔离：企业号只收本厂 factory_id 事件（A 厂收不到 B 厂）；
 * 3. persona 规则：C→lingshu，B→xingyun，D/A 级不播报；
 * 4. title 过 stripSecrets；
 * 5. 事件→帧延迟 < 1s（进程内总线）；
 * 6. 断连清理 listener 防泄漏；重连后恢复接收；
 * 7. publishBroadcast 垃圾入参不抛（fire-and-forget）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// boot.ts → kimi/auth 在模块加载期建 JWKS URL，测试环境需先补合法地址
vi.hoisted(() => {
  process.env.KIMI_AUTH_URL = process.env.KIMI_AUTH_URL || "https://mock-kimi.example.com";
  process.env.KIMI_OPEN_URL = process.env.KIMI_OPEN_URL || "https://mock-kimi.example.com";
});

// ─── 假 DB：select 链服务 sessionMe ──────────────────────────────────────────

type Row = Record<string, unknown>;
let authUser: Row | null;
let authFactory: Row | null;

vi.mock("./queries/connection", async () => {
  const { MySqlDialect } = await import("drizzle-orm/mysql-core");
  const { wbUsers, wbFactories } = await import("@db/schema");
  const dialect = new MySqlDialect();
  return {
    getDb: () => ({
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => {
              if (table === wbUsers) return authUser ? [authUser] : [];
              if (table === wbFactories) return authFactory ? [authFactory] : [];
              return [];
            },
          }),
        }),
      }),
      execute: async (stmt: unknown) => {
        dialect.sqlToQuery(stmt as never); // 保持方言解析路径一致
        return [[]];
      },
    }),
  };
});

import app from "./boot";
import { broadcastListenerCount, publishBroadcast } from "./routers/streamBus";

// ─── SSE 增量帧读取 ──────────────────────────────────────────────────────────

interface SseFrame {
  event: string;
  data: string;
}

function parseFrameBlock(blk: string): SseFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of blk.split(/\r?\n/)) {
    if (line.startsWith(":")) continue; // 注释心跳
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  return dataLines.length > 0 ? { event, data: dataLines.join("\n") } : null;
}

class SseReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buf = "";

  constructor(res: Response) {
    if (!res.body) throw new Error("响应无 body");
    this.reader = res.body.getReader();
  }

  /** 读下一帧（跳过心跳注释），超时抛错 */
  async nextFrame(timeoutMs = 3000): Promise<SseFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.buf.indexOf("\n\n");
      if (idx >= 0) {
        const blk = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        const f = parseFrameBlock(blk);
        if (f) return f;
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("nextFrame 超时：未等到帧");
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("read 超时")), remaining)),
      ]);
      if (chunk.done) throw new Error("流意外关闭");
      this.buf += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel();
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setImmediate(r));
  }
}

const ENDPOINT = "http://localhost/api/stream/events";

async function connect(token = "TEST_t"): Promise<Response> {
  return app.fetch(new Request(`${ENDPOINT}?token=${token}`));
}

beforeEach(() => {
  authUser = { id: 1, username: "boss", displayName: "老板", role: "member", factoryId: 10 };
  authFactory = { id: 10, enterpriseName: "TEST_甲厂" };
});

describe("GET /api/stream/events（M9-a）", () => {
  it("无效 token → 401", async () => {
    authUser = null;
    const res = await connect("TEST_bad");
    expect(res.status).toBe(401);
  });

  it("缺 token → 400", async () => {
    const res = await app.fetch(new Request(ENDPOINT));
    expect(res.status).toBe(400);
  });

  it("企业号权限隔离：只收本厂事件；C→lingshu / B→xingyun / D 不播；title 过 stripSecrets；延迟 <1s；断连清理", async () => {
    const res = await connect();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const sse = new SseReader(res);
    await waitFor(() => broadcastListenerCount() === 1);

    // B 厂事件 + 本厂 D 级事件都不应成帧（若漏出会排在本厂 C 级帧之前被先读到）
    publishBroadcast({ factoryId: 20, level: "C", title: "外厂事件不应收到" });
    publishBroadcast({ factoryId: 10, level: "D", title: "D级走人工通道不播报" });
    publishBroadcast({ factoryId: 10, level: "A", title: "A级只读不播报" });

    const t0 = Date.now();
    publishBroadcast({ factoryId: 10, level: "C", title: "本厂新信号：设备异常 st_abc123 已上报" });
    const f1 = await sse.nextFrame();
    expect(Date.now() - t0).toBeLessThan(1000); // 进程内事件→帧延迟
    expect(f1.event).toBe("broadcast");
    const d1 = JSON.parse(f1.data) as Record<string, unknown>;
    expect(d1.factoryId).toBe(10);
    expect(d1.level).toBe("C");
    expect(d1.persona).toBe("lingshu");
    expect(String(d1.title)).toContain("[已遮蔽]");
    expect(String(d1.title)).not.toContain("st_abc123");
    expect(typeof d1.at).toBe("string");

    // B 级 → xingyun
    publishBroadcast({ factoryId: 10, level: "B", title: "B级低风险已自动执行" });
    const f2 = await sse.nextFrame();
    const d2 = JSON.parse(f2.data) as Record<string, unknown>;
    expect(d2.persona).toBe("xingyun");
    expect(d2.level).toBe("B");

    // 断连清理：listener 立即摘除
    await sse.cancel();
    await waitFor(() => broadcastListenerCount() === 0);

    // 重连恢复接收
    const res2 = await connect();
    const sse2 = new SseReader(res2);
    await waitFor(() => broadcastListenerCount() === 1);
    publishBroadcast({ factoryId: 10, level: "C", title: "重连后事件" });
    const f3 = await sse2.nextFrame();
    expect(String((JSON.parse(f3.data) as Record<string, unknown>).title)).toContain("重连后事件");
    await sse2.cancel();
    await waitFor(() => broadcastListenerCount() === 0);
  });

  it("admin 收全局事件（不限 factory_id）", async () => {
    authUser = { id: 2, username: "admin", displayName: "管理员", role: "admin", factoryId: 1 };
    authFactory = { id: 1, enterpriseName: "TEST_平台" };
    const res = await connect();
    const sse = new SseReader(res);
    await waitFor(() => broadcastListenerCount() === 1);

    publishBroadcast({ factoryId: 20, level: "C", title: "乙厂事件" });
    const f1 = await sse.nextFrame();
    expect((JSON.parse(f1.data) as Record<string, unknown>).factoryId).toBe(20);

    publishBroadcast({ factoryId: 10, level: "B", title: "甲厂事件" });
    const f2 = await sse.nextFrame();
    expect((JSON.parse(f2.data) as Record<string, unknown>).factoryId).toBe(10);

    await sse.cancel();
    await waitFor(() => broadcastListenerCount() === 0);
  });

  it("publishBroadcast 垃圾入参不抛（fire-and-forget 铁律）", () => {
    expect(() => publishBroadcast({ factoryId: Number.NaN, level: "X", title: "未知等级" })).not.toThrow();
    expect(() => publishBroadcast({ factoryId: 1, level: "C", title: "正常" })).not.toThrow();
    expect(broadcastListenerCount()).toBe(0); // 无订阅者时发布无副作用
  });
});
