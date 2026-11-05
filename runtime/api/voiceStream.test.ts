/**
 * M60 utterance 真流式验收单测：
 * A. parseUtteranceStreamed（路由 JSON 边收边解）：
 *    1. kind 闭合即早判 + chat 分支 reply 增量有序吐出，最终解析与非流式同构；
 *    2. kind 未闭合前 reply 增量滞留（字段乱序不丢字）；
 *    3. 非 chat 分支不吐增量（动作语义依赖全量解析）；
 *    4. 吐字后断流 → 累计 reply 收口，绝不回落重发；
 *    5. 吐字前失败 → 回落 parseUtterance 原链（竞速→顺序降级）；
 *    6. 流式调用透传 flash 槽 + context=voice_utterance。
 * B. GET /api/stream/utterance 端点：鉴权/参数闸、delta→done 帧序、error 帧收口。
 * 全部网关/库调用经 mock，绝不发真实请求。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

vi.hoisted(() => {
  process.env.KIMI_AUTH_URL = process.env.KIMI_AUTH_URL || "https://mock-kimi.example.com";
  process.env.KIMI_OPEN_URL = process.env.KIMI_OPEN_URL || "https://mock-kimi.example.com";
});

const { streamMock, fastMock, slowMock } = vi.hoisted(() => ({
  // 显式 rest 签名：供 (...args: unknown[]) => mock(...args) 转发，避免 TS2556
  streamMock: vi.fn((..._args: unknown[]) => undefined as unknown),
  fastMock: vi.fn(async (..._args: unknown[]) => {
    throw new Error("fast lane disabled in tests");
  }),
  slowMock: vi.fn((..._args: unknown[]) => undefined as unknown),
}));

vi.mock("./routers/modelGateway", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/modelGateway")>();
  return {
    ...orig,
    callSlotChatStream: (...args: unknown[]) => streamMock(...args),
    callSlotChatFast: (...args: unknown[]) => fastMock(...args),
    callSlotChat: (...args: unknown[]) => slowMock(...args),
  };
});

// sessionMe 不 mock wbSession（boot 全量加载时 wbSession 其余导出被别处依赖）；
// 改走连接假库的 select 链（wbUsers.authToken → wbFactories），与 streamBus.test.ts 同款。
let authUser: Record<string, unknown> | null = null;
let authFactory: Record<string, unknown> | null = null;

// ─── 状态ful 假 DB（与 voice.test.ts 同款路由）：st_voice_sessions / st_voice_utterances / st_protocols ──

interface VoiceSessionRow {
  id: number;
  factoryId: number;
  user: string;
  persona: string;
  pendingAction: string | null;
  lastActivityAt: string;
  status: string;
}
interface UtteranceRow {
  sessionId: number;
  role: string;
  persona: string | null;
  text: string;
  kind: string;
}

let voiceSessions: VoiceSessionRow[];
let voiceUtterances: UtteranceRow[];

function resetVoiceTables() {
  voiceSessions = [
    {
      id: 1,
      factoryId: 10,
      user: "TEST_boss",
      persona: "lingshu",
      pendingAction: null,
      lastActivityAt: new Date().toISOString(),
      status: "active",
    },
  ];
  voiceUtterances = [];
}

function route(text: string, params: unknown[]): unknown {
  if (text.includes("FROM st_voice_sessions") && text.includes("SELECT")) {
    const id = Number(params[0]);
    const s = voiceSessions.find((x) => x.id === id);
    return [s ? [{ ...s }] : []];
  }
  if (text.includes("UPDATE st_voice_sessions")) {
    const id = Number(params[params.length - 1]);
    const s = voiceSessions.find((x) => x.id === id);
    if (!s) return [{ affectedRows: 0 }];
    if (text.includes("last_activity_at")) s.lastActivityAt = new Date().toISOString();
    return [{ affectedRows: 1 }];
  }
  if (text.includes("INSERT INTO st_voice_utterances")) {
    const [sessionId, , role, persona, textBody, , , kind] = params as [
      number, number, string, string | null, string, number | null, number | null, string,
    ];
    voiceUtterances.push({
      sessionId: Number(sessionId),
      role: String(role),
      persona: persona == null ? null : String(persona),
      text: String(textBody),
      kind: String(kind),
    });
    return [[]];
  }
  if (text.includes("SELECT role, persona, text FROM st_voice_utterances")) {
    const [sessionId, , limit] = params as [number, number, number];
    return [
      voiceUtterances
        .filter((u) => u.sessionId === Number(sessionId))
        .slice(-Number(limit))
        .reverse()
        .map((u) => ({ role: u.role, persona: u.persona, text: u.text })),
    ];
  }
  return [[]];
}

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
        const q = dialect.sqlToQuery(stmt as never);
        return route(q.sql, q.params);
      },
    }),
  };
});

import { parseUtteranceStreamed } from "./routers/voice";
import app from "./boot";

beforeEach(() => {
  streamMock.mockReset();
  slowMock.mockReset();
  resetVoiceTables();
  // TEST_wb → 有效会话；其余 token → 空（sessionMe 抛 UNAUTHORIZED）
  authUser = { id: 1, username: "TEST_boss", displayName: "老板", role: "owner", factoryId: 10, authToken: "TEST_wb" };
  authFactory = { id: 10, enterpriseName: "TEST_甲厂" };
});

/** 驱动流式 mock：逐 chunk 喂入，最终返回 ok+全量 content */
function driveStream(chunks: string[], full: string) {
  streamMock.mockImplementation(async (...args: unknown[]) => {
    const onChunk = args[2] as (d: string) => void;
    for (const c of chunks) onChunk(c);
    return { ok: true, content: full };
  });
}

const CHAT_FULL = '{"kind":"chat","actionType":"","skillKey":"","agentCode":"","payload":{},"reply":"老板，今天一切正常。生产线都在跑。"}';

describe("parseUtteranceStreamed（M60）", () => {
  it("chat 分支：kind 早判后 reply 增量有序吐出，收口与非流式同构", async () => {
    driveStream([
      '{"kind":"chat","act',
      'ionType":"","skillKey":"","agentCode":"","payload":{},"reply":"老板，',
      '今天一切正常。',
      '生产线都在跑。"}',
    ], CHAT_FULL);
    const deltas: string[] = [];
    const r = await parseUtteranceStreamed("lingshu", "今天咋样", [], "", [], [], [], [], (d) => deltas.push(d));
    expect(r.kind).toBe("chat");
    expect(r.reply).toBe("老板，今天一切正常。生产线都在跑。");
    expect(deltas.join("")).toBe("老板，今天一切正常。生产线都在跑。");
    // 首段增量在 kind 闭合后才吐出
    expect(deltas[0]).toBe("老板，");
  });

  it("字段乱序（reply 先于 kind）：kind 未闭合前增量滞留，不丢字", async () => {
    const odd = '{"reply":"先出的回复。","kind":"chat"}';
    driveStream(['{"reply":"先出的回复。","ki', 'nd":"chat"}'], odd);
    const deltas: string[] = [];
    const r = await parseUtteranceStreamed("lingshu", "hi", [], "", [], [], [], [], (d) => deltas.push(d));
    expect(r.kind).toBe("chat");
    expect(r.reply).toBe("先出的回复。");
    expect(deltas.join("")).toBe("先出的回复。");
  });

  it("非 chat 分支（action）：不吐增量，全量解析路由字段", async () => {
    const action = '{"kind":"action","actionType":"sandbox_dispatch","payload":{"task":"跑一圈"},"reply":"好，安排。"}';
    driveStream(['{"kind":"action","actionType":"sandbox_', 'dispatch","payload":{"task":"跑一圈"},"reply":"好，安排。"}'], action);
    const deltas: string[] = [];
    const r = await parseUtteranceStreamed("lingshu", "派一单", [], "", [], [], [], [], (d) => deltas.push(d));
    expect(r.kind).toBe("action");
    expect(r.actionType).toBe("sandbox_dispatch");
    expect(r.reply).toBe("好，安排。");
    expect(deltas).toEqual([]);
  });

  it("吐字后断流：累计 reply 收口，绝不回落重发", async () => {
    streamMock.mockImplementation(async (...args: unknown[]) => {
      const onChunk = args[2] as (d: string) => void;
      const part = '{"kind":"chat","actionType":"","skillKey":"","agentCode":"","payload":{},"reply":"老板，我已经在';
      onChunk(part);
      return { ok: false, reason: "network_error", partialContent: part };
    });
    const deltas: string[] = [];
    const r = await parseUtteranceStreamed("lingshu", "查查", [], "", [], [], [], [], (d) => deltas.push(d));
    expect(r.kind).toBe("chat");
    expect(r.reply).toBe("老板，我已经在");
    expect(deltas).toEqual(["老板，我已经在"]);
    expect(slowMock).not.toHaveBeenCalled();
  });

  it("吐字前失败 → 回落 parseUtterance 原链（顺序降级给出答案）", async () => {
    streamMock.mockResolvedValue({ ok: false, reason: "http_500" });
    slowMock.mockResolvedValue({ ok: true, content: CHAT_FULL });
    const deltas: string[] = [];
    const r = await parseUtteranceStreamed("lingshu", "今天咋样", [], "", [], [], [], [], (d) => deltas.push(d));
    expect(r.kind).toBe("chat");
    expect(r.reply).toBe("老板，今天一切正常。生产线都在跑。");
    expect(deltas).toEqual([]); // 非流式兜底不吐增量（调用方整段播报）
    expect(slowMock).toHaveBeenCalledTimes(1);
  });

  it("流式调用透传 flash 槽 + context=voice_utterance", async () => {
    driveStream([CHAT_FULL], CHAT_FULL);
    await parseUtteranceStreamed("lingshu", "hi", [], "", [], [], [], [], () => {});
    const [slot, opts] = streamMock.mock.calls[0] as [string, { context?: string }];
    expect(slot).toBe("flash");
    expect(opts.context).toBe("voice_utterance");
  });
});

// ─── B. GET /api/stream/utterance 端点 ───────────────────────────────────────

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
    if (Date.now() - 0 > deadline) throw new Error("读流超时");
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
    if (frames.some((f) => f.event === "done") || frames.some((f) => f.event === "error")) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return frames;
}

const UTTERANCE_ENDPOINT = "http://localhost/api/stream/utterance";

describe("GET /api/stream/utterance（M60）", () => {
  it("无效 token → 401；缺 text/sessionId → 400；confidence 越界 → 400", async () => {
    authUser = null;
    const r1 = await app.fetch(new Request(`${UTTERANCE_ENDPOINT}?token=bad&sessionId=1&text=hi`));
    expect(r1.status).toBe(401);
    authUser = { id: 1, username: "TEST_boss", displayName: "老板", role: "owner", factoryId: 10, authToken: "TEST_wb" };
    const r2 = await app.fetch(new Request(`${UTTERANCE_ENDPOINT}?token=TEST_wb&sessionId=1`));
    expect(r2.status).toBe(400);
    const r3 = await app.fetch(new Request(`${UTTERANCE_ENDPOINT}?token=TEST_wb&text=hi`));
    expect(r3.status).toBe(400);
    const r4 = await app.fetch(new Request(`${UTTERANCE_ENDPOINT}?token=TEST_wb&sessionId=1&text=hi&confidence=2`));
    expect(r4.status).toBe(400);
  });

  it("chat 流式：句级 delta 有序 → done{result} 全同构", async () => {
    // 真 runUtterance 走 st_voice_sessions 假库太重；此处固定 flash 流直出 chat JSON
    driveStream([
      '{"kind":"chat","actionType":"","skillKey":"","agentCode":"","payload":{},"reply":"老板，',
      '今天一切正常。',
      '生产线都在跑。"}',
    ], CHAT_FULL);
    const res = await app.fetch(new Request(`${UTTERANCE_ENDPOINT}?token=TEST_wb&sessionId=1&text=${encodeURIComponent("今天咋样")}`));
    expect(res.status).toBe(200);
    const frames = await readAllFrames(res);
    const deltas = frames.filter((f) => f.event === "delta").map((f) => (JSON.parse(f.data) as { text: string }).text);
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas.join("")).toBe("老板，今天一切正常。生产线都在跑。");
    const done = frames.find((f) => f.event === "done");
    expect(done).toBeTruthy();
    const result = (JSON.parse(done!.data) as { result: { kind: string; reply: string; sessionId: number } }).result;
    expect(result.kind).toBe("chat");
    expect(result.reply).toBe("老板，今天一切正常。生产线都在跑。");
    expect(result.sessionId).toBe(1);
  });
});
