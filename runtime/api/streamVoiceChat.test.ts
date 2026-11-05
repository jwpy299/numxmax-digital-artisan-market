/**
 * M60 GET /api/stream/voice-chat 端点验收单测（app.fetch 打 SSE，绝不发真实网络/真实库）：
 * 1. 无效 token → 401；缺 message / persona 非法 → 400；
 * 2. 记忆指令分流：「记住我喜欢喝浓茶」→ delta+done 一次收口，LLM 零调用；
 * 3. 正常流式：delta 句级有序切段 → emotion → done（streamed=true，reply 拼装完整）；
 * 4. 流式吐字前失败 → 非流式兜底：done(streamed:false, degraded:true) 兜底回复；
 * 5. 双链全败 → error 帧 + done(degraded:true) 人格化兜底话术；
 * 6. SentenceCutter 纯函数：句读闭合即切 / 碎片合并 / flush 尾巴。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.KIMI_AUTH_URL = process.env.KIMI_AUTH_URL || "https://mock-kimi.example.com";
  process.env.KIMI_OPEN_URL = process.env.KIMI_OPEN_URL || "https://mock-kimi.example.com";
});

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
        dialect.sqlToQuery(stmt as never);
        return [[]];
      },
    }),
  };
});

const { streamMock, slowMock } = vi.hoisted(() => ({
  streamMock: vi.fn(),
  slowMock: vi.fn(),
}));

vi.mock("./routers/modelGateway", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/modelGateway")>();
  return {
    ...orig,
    callSlotChatStream: (...args: unknown[]) => streamMock(...args),
    callSlotChat: (...args: unknown[]) => slowMock(...args),
    callSlotChatFast: vi.fn(async () => {
      throw new Error("fast lane disabled in tests");
    }),
  };
});

import app from "./boot";
import { SentenceCutter } from "./routers/streamBus";

interface SseFrame {
  event: string;
  data: string;
}

async function readAllFrames(res: Response, timeoutMs = 5000): Promise<SseFrame[]> {
  if (!res.body) throw new Error("响应无 body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const frames: SseFrame[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new Error("读流超时");
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const blk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of blk.split(/\r?\n/)) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length > 0) frames.push({ event, data: dataLines.join("\n") });
    }
    if (frames.some((f) => f.event === "done")) {
      // done 是收尾帧；等流自然关闭或主动取消
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return frames;
}

const ENDPOINT = "http://localhost/api/stream/voice-chat";

function urlOf(q: Record<string, string>): string {
  return `${ENDPOINT}?${new URLSearchParams(q).toString()}`;
}

beforeEach(() => {
  authUser = { id: 1, username: "boss", displayName: "老板", role: "owner", factoryId: 10 };
  authFactory = { id: 10, enterpriseName: "TEST_甲厂" };
  streamMock.mockReset();
  slowMock.mockReset();
});

describe("GET /api/stream/voice-chat（M60）", () => {
  it("无效 token → 401；缺 message → 400；persona 非法 → 400", async () => {
    authUser = null;
    const r1 = await app.fetch(new Request(urlOf({ token: "bad", message: "hi" })));
    expect(r1.status).toBe(401);
    authUser = { id: 1, username: "boss", displayName: "老板", role: "owner", factoryId: 10 };
    const r2 = await app.fetch(new Request(urlOf({ token: "t" })));
    expect(r2.status).toBe(400);
    const r3 = await app.fetch(new Request(urlOf({ token: "t", message: "hi", persona: "hacker" })));
    expect(r3.status).toBe(400);
  });

  it("记忆指令分流：delta+done 收口，LLM 零调用", async () => {
    const res = await app.fetch(new Request(urlOf({ token: "t", message: "记住我喜欢喝浓茶" })));
    expect(res.status).toBe(200);
    const frames = await readAllFrames(res);
    expect(streamMock).not.toHaveBeenCalled();
    expect(slowMock).not.toHaveBeenCalled();
    const done = frames.find((f) => f.event === "done");
    expect(done).toBeTruthy();
    const payload = JSON.parse(done!.data) as { reply: string; emotion: string; streamed: boolean };
    expect(payload.reply).toContain("已记住");
    expect(payload.emotion).toBe("joy");
    expect(payload.streamed).toBe(false);
    // delta 帧与 done 回复同文案
    const delta = frames.find((f) => f.event === "delta");
    expect(delta).toBeTruthy();
  });

  it("正常流式：句级 delta 有序 → emotion → done（streamed=true）", async () => {
    const full = "老板，今日意图 3 条。待确认 1 条，建议您去组织中枢确认。";
    streamMock.mockImplementation(async (_slot: string, _opts: unknown, onChunk: (d: string) => void) => {
      for (const c of ['{"reply":"老板，今日意图 3 条。', '待确认 1 条，', '建议您去组织中枢确认。","emotion":"urgent"}']) {
        onChunk(c);
        await new Promise((r) => setImmediate(r));
      }
      return { ok: true, content: `{"reply":${JSON.stringify(full)},"emotion":"urgent"}` };
    });
    const res = await app.fetch(new Request(urlOf({ token: "t", message: "今天厂里咋样" })));
    expect(res.status).toBe(200);
    const frames = await readAllFrames(res);
    const deltas = frames.filter((f) => f.event === "delta").map((f) => (JSON.parse(f.data) as { text: string }).text);
    // 句级切段：完整句先出，且按序拼回全文
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas.join("")).toBe(full);
    expect(deltas[0]).toContain("老板，今日意图 3 条。");
    const emotion = frames.find((f) => f.event === "emotion");
    expect(emotion).toBeTruthy();
    expect((JSON.parse(emotion!.data) as { emotion: string }).emotion).toBe("urgent");
    const done = JSON.parse(frames.find((f) => f.event === "done")!.data) as {
      reply: string; streamed: boolean; degraded: boolean; emotion: string;
    };
    expect(done.reply).toBe(full);
    expect(done.streamed).toBe(true);
    expect(done.degraded).toBe(false);
    expect(done.emotion).toBe("urgent");
  });

  it("流式吐字前失败 → 非流式兜底：done(streamed:false, degraded:true)", async () => {
    streamMock.mockResolvedValue({ ok: false, reason: "http_500" });
    slowMock.mockResolvedValue({ ok: true, content: '{"reply":"老板，慢链兜底答。","emotion":"calm"}' });
    const res = await app.fetch(new Request(urlOf({ token: "t", message: "在吗" })));
    const frames = await readAllFrames(res);
    const done = JSON.parse(frames.find((f) => f.event === "done")!.data) as {
      reply: string; streamed: boolean; degraded: boolean;
    };
    expect(done.reply).toBe("老板，慢链兜底答。");
    expect(done.streamed).toBe(false);
    expect(done.degraded).toBe(true);
  });

  it("双链全败 → voiceBuddy 内闭环降级：done(degraded:true) 人格化兜底话术", async () => {
    streamMock.mockResolvedValue({ ok: false, reason: "timeout" });
    slowMock.mockResolvedValue({ ok: false, reason: "timeout" });
    const res = await app.fetch(new Request(urlOf({ token: "t", message: "在吗" })));
    const frames = await readAllFrames(res);
    const done = JSON.parse(frames.find((f) => f.event === "done")!.data) as {
      reply: string; degraded: boolean;
    };
    expect(done.degraded).toBe(true);
    expect(done.reply).toContain("灵枢"); // lingshu 人格兜底话术
  });
});

describe("SentenceCutter 纯函数", () => {
  it("句读闭合即切，尾巴滞留 flush", () => {
    const c = new SentenceCutter();
    expect(c.feed("老板好。")).toEqual(["老板好。"]);
    expect(c.feed("今天")).toEqual([]);
    expect(c.feed("天气不错。还有")).toEqual(["今天天气不错。"]);
    expect(c.flush()).toBe("还有");
  });

  it("碎片并入前段（≥4 字才独立成帧）", () => {
    const c = new SentenceCutter();
    const out = c.feed("好。收到。");
    expect(out).toEqual(["好。收到。"]);
  });

  it("多次小增量累积成句", () => {
    const c = new SentenceCutter();
    expect(c.feed("老")).toEqual([]);
    expect(c.feed("板")).toEqual([]);
    expect(c.feed("，我在")).toEqual([]);
    expect(c.feed("。")).toEqual(["老板，我在。"]);
    expect(c.flush()).toBeNull();
  });
});
