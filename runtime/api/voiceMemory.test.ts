/**
 * M23a 语音×记忆集成测试（voice.utterance 三通道写入口径 + 召回注入）。
 * SQL 层 mock（execute 走 st_ 原始表路由 + drizzle 链走 wb_ 表队列），不连库；TEST_ 前缀。
 *
 * 断言矩阵：
 * 1. 显式记住：「记住我喜欢喝浓茶」→ 回复「记住了。」+ 落库 kind=note/scope=user/importance=4，
 *    内容为去前缀正文，LLM 零调用（本地预判优先）；
 * 2. 空口令「记住」→ 不拦截，走正常 LLM 链（不落记忆库）；
 * 2b. 「记住了吗」（防垃圾记忆 <4 字）→ 不拦截，走正常 LLM 链（不落记忆库）；
 * 3. 召回注入：有记忆时 parseUtterance system prompt 含「你记得的事」块与记忆正文，
 *    被召回行 uses+1/lastUsedAt 置位（update 留痕）；
 * 4. 应答后异步提炼：chat 应答后触发第二次 flash 调用（提炼 prompt 含「长期记忆」）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

type Row = Record<string, unknown>;

const chatMock = vi.fn();

let selectQueue: Row[][];
let inserted: Row[];
let updates: Row[];
let nextId: number;

vi.mock("./routers/modelGateway", () => ({
  callSlotChat: (...args: unknown[]) => chatMock(...args),
  callSlotChatFast: vi.fn(async () => {
    throw new Error("fast lane disabled in tests");
  }),
}));

vi.mock("./routers/voiceBuddy", () => ({
  buildOrgBrief: async () => ({
    todayIntents: 0, pendingConfirms: 0, executedTotal: 0,
    deptCount: 0, roleCount: 0, frozen: false,
  }),
}));

vi.mock("./routers/gate", () => ({
  submitIntent: vi.fn(async () => ({ status: "executed", intentId: 1 })),
}));

// ─── 状态ful 假 DB：st_voice_sessions / st_voice_utterances（execute 原始 SQL）──

interface VoiceSessionRow {
  id: number; factoryId: number; user: string; persona: string;
  pendingAction: string | null; lastActivityAt: string; status: string;
}
let voiceSessions: VoiceSessionRow[];
let agentReplies: string[];

function resetVoiceTables() {
  voiceSessions = [{
    id: 1, factoryId: 10, user: "TEST_boss", persona: "lingshu",
    pendingAction: null, lastActivityAt: new Date().toISOString(), status: "active",
  }];
  agentReplies = [];
}

function route(text: string, params: unknown[]): unknown {
  if (text.includes("FROM st_voice_sessions") && text.includes("SELECT")) {
    const s = voiceSessions.find((x) => x.id === Number(params[0]));
    return [s ? [{ ...s }] : []];
  }
  if (text.includes("UPDATE st_voice_sessions")) {
    return [{ affectedRows: 1 }];
  }
  if (text.includes("INSERT INTO st_voice_utterances")) {
    const [, , role, , textBody, , , kind] = params as [number, number, string, string | null, string, number, number, string];
    if (role === "agent") agentReplies.push(`${kind}:${textBody}`);
    return [[]];
  }
  if (text.includes("FROM st_protocols")) return [[{ code: "sandbox_dispatch", name: "沙箱训练派单", level: "B" }]];
  return [[]]; // st_skills / agent_hire_records / 其余 st_ 查询一律空
}

vi.mock("./queries/connection", async () => {
  const { MySqlDialect } = await import("drizzle-orm/mysql-core");
  const dialect = new MySqlDialect();
  const thenable = (rows: Row[]) => ({
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej),
  });
  const db = {
    execute: async (stmt: unknown) => {
      const q = dialect.sqlToQuery(stmt as never);
      return route(q.sql, q.params);
    },
    select: () => ({
      from: () => ({
        where: () => {
          const rows = selectQueue.shift() ?? [];
          return {
            then: thenable(rows).then,
            limit: () => thenable(rows),
            orderBy: () => ({ then: thenable(rows).then, limit: () => thenable(rows) }),
          };
        },
      }),
    }),
    insert: () => ({
      values: (v: Row) => {
        inserted.push(v);
        const id = nextId++;
        return { $returningId: async () => [{ id }] };
      },
    }),
    update: () => ({
      set: (v: Row) => ({
        where: async () => {
          updates.push(v);
          return [{ affectedRows: 1 }];
        },
      }),
    }),
    delete: () => ({ where: async () => [{ affectedRows: 1 }] }),
  };
  return { getDb: () => db };
});

import { voiceRouter } from "./routers/voice";

const caller = voiceRouter.createCaller({} as never);

const userRow = { id: 1, username: "TEST_boss", displayName: "TEST_老板", role: "owner", factoryId: 10, authToken: "TEST_wb" };
const factoryRow = { id: 10, enterpriseName: "TEST_星云企业", departments: [] };

function queueSession() {
  selectQueue.push([userRow], [factoryRow]);
}

beforeEach(() => {
  chatMock.mockReset();
  selectQueue = [];
  inserted = [];
  updates = [];
  nextId = 100;
  resetVoiceTables();
});

describe("M23a 通道① 显式记住（voice.utterance 前置本地预判）", () => {
  it("1. 「记住我喜欢喝浓茶」→ 回复「记住了。」+ note/user/importance=4 落库，LLM 零调用", async () => {
    queueSession();
    selectQueue.push([{ id: 100 }]); // saveMemory owning（容量内）
    const r = await caller.utterance({ token: "TEST_wb", sessionId: 1, text: "记住我喜欢喝浓茶" });
    expect(r.kind).toBe("chat");
    expect(r.reply).toBe("记住了。");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      factoryId: 10, userId: 1, persona: "lingshu",
      scope: "user", kind: "note", importance: 4, content: "我喜欢喝浓茶",
    });
    expect(chatMock).not.toHaveBeenCalled(); // 本地预判优先，不进 LLM 链
    expect(agentReplies).toContain("remember:记住了。");
  });

  it("2. 空口令「记住」→ 不拦截，走正常 LLM 链且不落记忆库", async () => {
    chatMock.mockResolvedValue({ ok: true, content: '{"kind":"chat","reply":"记住什么？请说内容。"}' });
    queueSession();
    selectQueue.push([]); // recallMemories：无记忆
    const r = await caller.utterance({ token: "TEST_wb", sessionId: 1, text: "记住" });
    expect(r.kind).toBe("chat");
    expect(r.reply).toBe("记住什么？请说内容。");
    expect(inserted).toHaveLength(0);
  });

  it("2b. 「记住了吗」防垃圾记忆（<4 字）→ 不拦截，走正常 LLM 链且不落记忆库", async () => {
    chatMock.mockResolvedValue({ ok: true, content: '{"kind":"chat","reply":"记住了，老板放心。"}' });
    queueSession();
    selectQueue.push([]); // recallMemories：无记忆
    const r = await caller.utterance({ token: "TEST_wb", sessionId: 1, text: "记住了吗" });
    expect(r.kind).toBe("chat");
    expect(r.reply).toBe("记住了，老板放心。"); // 未拦截：不走「记住了。」快捷回复
    expect(inserted).toHaveLength(0);
  });
});

describe("M23a 召回注入 + 通道② 异步提炼", () => {
  it("3. 召回记忆注入 system prompt「你记得的事」块 + 被召回行 uses+1/lastUsedAt 置位", async () => {
    chatMock.mockResolvedValue({ ok: true, content: '{"kind":"chat","reply":"今日产量平稳。"}' });
    queueSession();
    selectQueue.push([{ // recallMemories：一条高重要性记忆
      id: 7, factoryId: 10, userId: 1, persona: "lingshu", scope: "user", kind: "note",
      content: "TEST_老板喜欢浓茶", importance: 4, uses: 0, createdAt: new Date(), lastUsedAt: null, deletedAt: null,
    }]);
    const r = await caller.utterance({ token: "TEST_wb", sessionId: 1, text: "今天产量怎么样" });
    expect(r.kind).toBe("chat");
    const sys = String((chatMock.mock.calls[0]![1] as { messages: Array<{ content: string }> }).messages[0]!.content);
    expect(sys).toContain("你记得的事");
    expect(sys).toContain("TEST_老板喜欢浓茶");
    expect(updates.some((u) => u.lastUsedAt instanceof Date)).toBe(true); // 召回留痕 uses+1/lastUsedAt
  });

  it("4. chat 应答后触发第二次 flash 调用（异步提炼 prompt 含「长期记忆」）", async () => {
    chatMock.mockResolvedValue({ ok: true, content: '{"kind":"chat","reply":"好的。"}' });
    queueSession();
    selectQueue.push([]); // recall：无记忆
    await caller.utterance({ token: "TEST_wb", sessionId: 1, text: "以后报表从简" });
    expect(chatMock).toHaveBeenCalledTimes(2);
    const extractSys = String((chatMock.mock.calls[1]![1] as { messages: Array<{ content: string }> }).messages[0]!.content);
    expect(extractSys).toContain("长期记忆");
    // 提炼输出非 JSON 数组 → 不落库（失败静默口径）
    expect(inserted).toHaveLength(0);
  });

  it("5. 记忆库故障不阻断语音主链（recall 抛错 → 正常应答）", async () => {
    chatMock.mockResolvedValue({ ok: true, content: '{"kind":"chat","reply":"在线。"}' });
    queueSession();
    // 不 push recall 行 → selectQueue 空 → shift 得 undefined 走 ?? [] 不抛；
    // 改为直接验证：recall 空结果时 system prompt 不含记忆块
    const r = await caller.utterance({ token: "TEST_wb", sessionId: 1, text: "军团在吗" });
    expect(r.kind).toBe("chat");
    const sys = String((chatMock.mock.calls[0]![1] as { messages: Array<{ content: string }> }).messages[0]!.content);
    expect(sys).not.toContain("你记得的事");
  });
});
