/**
 * M60 语音对话真流式验收单测：
 * A. extractPartialReply 增量解析：完整 JSON / 流式中段 / 转义引号 / 未开始 / markdown 包裹；
 * B. generateBuddyReplyStream：
 *    1. 流式成功：onReplyDelta 按 reply 字段增量有序吐出，emotion 等全量落定解析，streamed=true；
 *    2. 吐字前失败 → 回落非流式 generateBuddyReply（callSlotChat 链），一次性吐全文，streamed=false；
 *    3. 吐字后断流 → 以累计 reply 收口（degraded=true，emotion=calm），绝不换链重发；
 *    4. 流式 context=voicebuddy_chat 落账口径透传（参数断言）。
 * 全部网关调用经 vi.mock mock，绝不发真实请求。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.KIMI_AUTH_URL = process.env.KIMI_AUTH_URL || "https://mock-kimi.example.com";
  process.env.KIMI_OPEN_URL = process.env.KIMI_OPEN_URL || "https://mock-kimi.example.com";
});

const { streamMock, slowMock } = vi.hoisted(() => ({
  streamMock: vi.fn(),
  slowMock: vi.fn(),
}));

vi.mock("./routers/modelGateway", () => ({
  callSlotChatStream: (...args: unknown[]) => streamMock(...args),
  callSlotChat: (...args: unknown[]) => slowMock(...args),
  callSlotChatFast: vi.fn(async () => {
    throw new Error("fast lane disabled in tests");
  }),
}));

import {
  extractPartialReply,
  generateBuddyReplyStream,
} from "./routers/voiceBuddy";

beforeEach(() => {
  streamMock.mockReset();
  slowMock.mockReset();
});

describe("extractPartialReply 增量解析", () => {
  it("完整 JSON → 完整 reply", () => {
    expect(extractPartialReply('{"reply":"老板好，我在。","emotion":"calm"}')).toBe("老板好，我在。");
  });

  it("流式中段（未闭合）→ 已累计部分", () => {
    expect(extractPartialReply('{"reply":"老板好，我')).toBe("老板好，我");
  });

  it("转义引号与换行反转义", () => {
    expect(extractPartialReply('{"reply":"他说\\"行\\"。\\n继续"}')).toBe('他说"行"。\n继续');
  });

  it("reply 未开始 → null", () => {
    expect(extractPartialReply('{"emot')).toBeNull();
    expect(extractPartialReply("")).toBeNull();
  });

  it("markdown 代码块包裹也能定位", () => {
    expect(extractPartialReply('```json\n{"reply":"在的老板')).toBe("在的老板");
  });
});

describe("generateBuddyReplyStream", () => {
  it("流式成功：delta 按 reply 增量有序吐出，emotion 全量解析", async () => {
    streamMock.mockImplementation(async (_slot: string, _opts: unknown, onChunk: (d: string) => void) => {
      for (const c of ['{"reply":"老板，', '今日意图 3 条', '，都在掌握中。', '","emotion":"calm"}']) {
        onChunk(c);
      }
      return { ok: true, content: '{"reply":"老板，今日意图 3 条，都在掌握中。","emotion":"calm"}' };
    });
    const deltas: string[] = [];
    const r = await generateBuddyReplyStream("lingshu", "实况\n老板说：「今天咋样」", "", (d) => deltas.push(d));
    expect(r.streamed).toBe(true);
    expect(r.degraded).toBe(false);
    expect(r.reply).toBe("老板，今日意图 3 条，都在掌握中。");
    expect(r.emotion).toBe("calm");
    expect(deltas.join("")).toBe("老板，今日意图 3 条，都在掌握中。");
    // delta 是增量（后段不含前段）
    expect(deltas[0]).toBe("老板，");
    expect(deltas[1].startsWith("今日意图")).toBe(true);
  });

  it("吐字前流失败 → 回落非流式链，一次性吐全文，streamed=false", async () => {
    streamMock.mockResolvedValue({ ok: false, reason: "http_500" });
    slowMock.mockResolvedValue({ ok: true, content: '{"reply":"老板，非流式兜底答。","emotion":"joy"}' });
    const deltas: string[] = [];
    const r = await generateBuddyReplyStream("lingshu", "老板说：「在吗」", "", (d) => deltas.push(d));
    expect(r.streamed).toBe(false);
    expect(r.degraded).toBe(true);
    expect(r.reply).toBe("老板，非流式兜底答。");
    expect(r.emotion).toBe("joy");
    expect(deltas).toEqual(["老板，非流式兜底答。"]);
    expect(slowMock).toHaveBeenCalledTimes(1);
  });

  it("吐字后断流 → 累计 reply 收口（degraded，calm），不回落重发", async () => {
    streamMock.mockImplementation(async (_slot: string, _opts: unknown, onChunk: (d: string) => void) => {
      onChunk('{"reply":"老板，我已经在查');
      return { ok: false, reason: "network_error", partialContent: '{"reply":"老板，我已经在查' };
    });
    const deltas: string[] = [];
    const r = await generateBuddyReplyStream("lingshu", "老板说：「查查」", "", (d) => deltas.push(d));
    expect(r.streamed).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.reply).toBe("老板，我已经在查");
    expect(r.emotion).toBe("calm");
    expect(deltas).toEqual(["老板，我已经在查"]);
    expect(slowMock).not.toHaveBeenCalled(); // 绝不换链重发
  });

  it("流式调用透传 context=voicebuddy_chat 与 flash 槽", async () => {
    streamMock.mockResolvedValue({ ok: true, content: '{"reply":"好。","emotion":"calm"}' });
    await generateBuddyReplyStream("xingyun", "老板说：「报数」", "偏好", () => {});
    expect(streamMock).toHaveBeenCalledTimes(1);
    const [slot, opts] = streamMock.mock.calls[0] as [string, { context?: string; messages: { role: string; content: string }[] }];
    expect(slot).toBe("flash");
    expect(opts.context).toBe("voicebuddy_chat");
    // system prompt 人格与 JSON 指令仍在（xingyun 人格）
    expect(opts.messages[0].content).toContain("星云");
    expect(opts.messages[0].content).toContain('"reply"');
    expect(opts.messages[1].content).toContain("老板说");
  });
});
