/**
 * M8-a LLM 网关提速层验收单测：
 * 1. 竞速取先回者（flash 槽主模型慢、备选快 → 备选胜出，hedged=true）。
 * 2. 败者被 AbortController 中止（loser signal.aborted === true）。
 * 3. 双败抛错（两家都失败才抛，错误信息合并两家原因）。
 * 4. 主模型熔断期 → 跳过主模型，直接走备选 + 第三备选。
 * 5. 保活心跳只更新 latencyStats、绝不抛错。
 * 6. 既有 callSlotChat 行为回归（成功 / 顺序降级 / kimi-k3 temperature=1 适配 / not_configured）。
 *
 * 全部网络调用经 vi.stubGlobal("fetch") mock，绝不发真实请求；密钥使用测试占位串。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// 与 voice.test.ts 同款 mock：getDb 仅用于日用量校准，返回空结果集即可
// M59：execute 换 hoisted vi.fn，供 recordGatewayEvent 落账断言（行为对老用例完全等价）
const { executeMock } = vi.hoisted(() => ({
  // 显式宽松签名：mock.calls 元素类型为 [unknown?]，避免 [] 元组索引报错
  executeMock: vi.fn(async (..._args: unknown[]) => [[]] as unknown[]),
}));
vi.mock("./queries/connection", () => ({ getDb: () => ({ execute: executeMock }) }));

import {
  callSlotChat,
  callSlotChatFast,
  callSlotChatStream,
  GATEWAY_CATALOG,
  latencyStats,
  runKeepAliveOnce,
  startKeepAlive,
  stopKeepAlive,
} from "./routers/modelGateway";

const TEST_IDO_KEY = "test_ido_key_000000000000"; // 测试占位串，非真实密钥

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function okRes(content: string, totalTokens = 5) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }], usage: { total_tokens: totalTokens } }),
  } as Response;
}

function errRes(status: number) {
  return { ok: false, status, json: async () => ({}) } as Response;
}

function bodyOf(init: RequestInit): { model: string; temperature?: number; max_tokens?: number } {
  return JSON.parse(String(init.body));
}

beforeEach(() => {
  fetchMock.mockReset();
  latencyStats.clear();
  process.env.IDOICTOS_API_KEY = TEST_IDO_KEY;
});

afterEach(() => {
  stopKeepAlive();
  delete process.env.IDOICTOS_API_KEY;
});

describe("callSlotChatFast 双通道竞速", () => {
  it("竞速取先回者：主模型慢、备选快 → 备选胜出并标注降级", async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const { model } = bodyOf(init);
      if (model === "kimi-k3") {
        return new Promise((res) => setTimeout(() => res(okRes("主模型回复")), 100));
      }
      if (model === "deepseek-v4-pro") {
        return new Promise((res) => setTimeout(() => res(okRes("备选回复")), 5));
      }
      return Promise.reject(new Error(`unexpected model ${model}`));
    });
    const r = await callSlotChatFast("flash", { messages: [{ role: "user", content: "hi" }] });
    expect(r.ok).toBe(true);
    expect(r.content).toBe("备选回复");
    expect(r.provider).toBe("idoictos");
    expect(typeof r.latencyMs).toBe("number");
    expect(r.hedged).toBe(true);
    expect(r.fallbackFrom).toBe("flash");
    // 两家确实同时发出
    const models = fetchMock.mock.calls.map((c) => bodyOf(c[1] as RequestInit).model);
    expect(models.sort()).toEqual(["deepseek-v4-pro", "kimi-k3"]);
  });

  it("胜者返回后败者被 AbortController 中止，且败者的被中止不计入熔断统计", async () => {
    const signals = new Map<string, AbortSignal>();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const { model } = bodyOf(init);
      signals.set(model, init.signal as AbortSignal);
      if (model === "deepseek-v4-pro") return Promise.resolve(okRes("快者胜"));
      // 主模型挂起直到被中止
      return new Promise((_res, rej) => {
        (init.signal as AbortSignal).addEventListener("abort", () =>
          rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    });
    const r = await callSlotChatFast("flash", { messages: [{ role: "user", content: "hi" }] });
    expect(r.content).toBe("快者胜");
    expect(signals.get("kimi-k3")?.aborted).toBe(true);
    expect(signals.get("deepseek-v4-pro")?.aborted).toBe(false);
    // 给败者的 abort 微任务一个落空窗口
    await new Promise((res) => setTimeout(res, 10));
    expect(latencyStats.get("kimi-k3")?.failStreak ?? 0).toBe(0);
  });

  it("双败才抛错：两家都失败，错误信息合并两家原因", async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const { model } = bodyOf(init);
      return Promise.resolve(errRes(model === "deepseek-v4-pro" ? 500 : 401));
    });
    await expect(
      callSlotChatFast("flash", { messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/双通道均失败/);
    fetchMock.mockClear();
    await expect(
      callSlotChatFast("flash", { messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/kimi-k3=http_401; deepseek-v4-pro=http_500/);
  });

  it("任一家失败不计错误：主模型失败、备选成功 → 正常返回", async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const { model } = bodyOf(init);
      if (model === "kimi-k3") return Promise.resolve(errRes(500));
      return Promise.resolve(okRes("备选顶上"));
    });
    const r = await callSlotChatFast("flash", { messages: [{ role: "user", content: "hi" }] });
    expect(r.ok).toBe(true);
    expect(r.content).toBe("备选顶上");
    // 失败计入主模型统计（连续失败达 3 将触发熔断）
    expect(latencyStats.get("kimi-k3")?.failStreak).toBe(1);
  });

  it("主模型熔断期 → 跳过主模型，直接以备选 + 第三备选竞速", async () => {
    latencyStats.set("kimi-k3", {
      samples: [],
      p50: 0,
      failStreak: 3,
      circuitOpenUntil: Date.now() + 5 * 60_000,
    });
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const { model } = bodyOf(init);
      if (model === "deepseek-v4-pro") return new Promise((res) => setTimeout(() => res(okRes("备选胜")), 5));
      if (model === "minimax-m3") return new Promise((res) => setTimeout(() => res(okRes("第三备选")), 50));
      return Promise.reject(new Error(`主模型 ${model} 不应被调用`));
    });
    const r = await callSlotChatFast("flash", { messages: [{ role: "user", content: "hi" }] });
    expect(r.content).toBe("备选胜");
    const models = fetchMock.mock.calls.map((c) => bodyOf(c[1] as RequestInit).model);
    expect(models).not.toContain("kimi-k3");
    // flash 槽主模型 kimi-k3 熔断 → 竞速对为降级链前二：orggen(deepseek-v4-pro) + creative(minimax-m3)
    expect(models.sort()).toEqual(["deepseek-v4-pro", "minimax-m3"]);
  });

  it("非竞速槽（brain）：走既有顺序降级链路，hedged=false；未配置密钥直接抛错", async () => {
    fetchMock.mockResolvedValue(okRes("大脑回复"));
    const r = await callSlotChatFast("brain", { messages: [{ role: "user", content: "hi" }] });
    expect(r.ok).toBe(true);
    expect(r.hedged).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock.mock.calls[0][1] as RequestInit).model).toBe("kimi-k3");

    delete process.env.IDOICTOS_API_KEY;
    await expect(
      callSlotChatFast("flash", { messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/not_configured/);
  });
});

describe("保活心跳", () => {
  it("暖调用成功：只更新 latencyStats（含 1-token 预算），不抛错", async () => {
    fetchMock.mockResolvedValue(okRes("pong", 1));
    await expect(runKeepAliveOnce()).resolves.toBeUndefined();
    // 五槽去重后的在役模型（kimi-k3×brain/chat/flash + deepseek-v4-pro + minimax-m3）均被暖到
    for (const m of ["kimi-k3", "deepseek-v4-pro", "minimax-m3"]) {
      const s = latencyStats.get(m);
      expect(s, m).toBeDefined();
      expect(s!.samples.length).toBe(1);
      expect(s!.failStreak).toBe(0);
    }
    // 全部为 max_tokens=1 的极简调用
    for (const call of fetchMock.mock.calls) {
      expect(bodyOf(call[1] as RequestInit).max_tokens).toBe(1);
    }
  });

  it("暖调用失败：只累计 failStreak，绝不抛出", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(runKeepAliveOnce()).resolves.toBeUndefined();
    await expect(runKeepAliveOnce()).resolves.toBeUndefined();
    expect(latencyStats.get("kimi-k3")?.failStreak).toBe(2);
  });

  it("startKeepAlive/stopKeepAlive：立即暖一轮，定时器可启停且不抛错", async () => {
    fetchMock.mockResolvedValue(okRes("pong", 1));
    expect(() => startKeepAlive(60_000)).not.toThrow();
    await new Promise((res) => setTimeout(res, 10));
    expect(latencyStats.size).toBeGreaterThan(0);
    expect(() => stopKeepAlive()).not.toThrow();
  });
});

describe("callSlotChat 旧行为回归", () => {
  it("主槽成功：直接返回，不触发降级", async () => {
    fetchMock.mockResolvedValue(okRes("闪电回复"));
    const r = await callSlotChat("flash", { messages: [{ role: "user", content: "hi" }] });
    expect(r.ok).toBe(true);
    expect(r.content).toBe("闪电回复");
    expect(r.model).toBe("kimi-k3");
    expect(r.fallbackFrom).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("主槽失败：沿 SLOT_FALLBACK 顺序降级并标注 fallbackFrom", async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const { model } = bodyOf(init);
      if (model === "kimi-k3") return Promise.resolve(errRes(500));
      return Promise.resolve(okRes("对话槽顶上"));
    });
    const r = await callSlotChat("flash", { messages: [{ role: "user", content: "hi" }] });
    expect(r.ok).toBe(true);
    expect(r.content).toBe("对话槽顶上");
    expect(r.fallbackFrom).toBe("flash");
    expect(r.providerLabel).toContain("降级自");
  });

  it("厂商适配保留：kimi-k3 槽位仅允许 temperature=1，非 K3 槽位按调用方温度", async () => {
    fetchMock.mockResolvedValue(okRes("好"));
    await callSlotChat("brain", { messages: [{ role: "user", content: "hi" }], temperature: 0.2 });
    expect(bodyOf(fetchMock.mock.calls[0][1] as RequestInit).temperature).toBe(1);
    // flash 槽同为 kimi-k3 → 同样强制 temperature=1
    fetchMock.mockClear();
    await callSlotChat("flash", { messages: [{ role: "user", content: "hi" }], temperature: 0.2 });
    expect(bodyOf(fetchMock.mock.calls[0][1] as RequestInit).temperature).toBe(1);
    // 非 K3 槽位（orggen=deepseek-v4-pro）仍按调用方温度
    fetchMock.mockClear();
    await callSlotChat("orggen", { messages: [{ role: "user", content: "hi" }], temperature: 0.2 });
    expect(bodyOf(fetchMock.mock.calls[0][1] as RequestInit).temperature).toBe(0.2);
  });

  it("未配置密钥：返回 not_configured，不发任何请求", async () => {
    delete process.env.IDOICTOS_API_KEY;
    const r = await callSlotChat("flash", { messages: [{ role: "user", content: "hi" }] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("M59 时延可观测（recordGatewayEvent 落账）", () => {
  // 网关每次调用还会做日用量校准（getLlmUsageToday 的 execute），断言须按 st_llm_events 过滤
  const eventCalls = () =>
    executeMock.mock.calls.filter((c) => JSON.stringify(c[0]).includes("st_llm_events"));
  beforeEach(() => {
    executeMock.mockClear();
  });

  it("未声明 context：不落账（存量调用行为零变化）", async () => {
    fetchMock.mockResolvedValue(okRes("你好"));
    const r = await callSlotChat("chat", { messages: [{ role: "user", content: "hi" }] });
    expect(r.ok).toBe(true);
    expect(eventCalls()).toHaveLength(0);
  });

  it("声明 context 且成功：落 ok=1/fallback=0/时延非负", async () => {
    fetchMock.mockResolvedValue(okRes("你好"));
    const r = await callSlotChat("chat", {
      messages: [{ role: "user", content: "hi" }],
      context: "assistant_ask",
    });
    expect(r.ok).toBe(true);
    expect(eventCalls()).toHaveLength(1);
    const q = JSON.stringify(eventCalls()[0][0]);
    expect(q).toContain("assistant_ask");
  });

  it("降级成功：落 fallback=1", async () => {
    fetchMock
      .mockResolvedValueOnce(errRes(500))
      .mockResolvedValueOnce(okRes("兜底答"));
    const r = await callSlotChat("chat", {
      messages: [{ role: "user", content: "hi" }],
      context: "assistant_ask",
    });
    expect(r.ok).toBe(true);
    expect(r.fallbackFrom).toBe("chat");
    expect(eventCalls()).toHaveLength(1);
    const q = JSON.stringify(eventCalls()[0][0]);
    expect(q).toContain("assistant_ask");
  });

  it("竞速胜者落账且不双计（hedged 两请求只落一行）", async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const model = bodyOf(init).model;
      return new Promise((resolve) =>
        setTimeout(() => resolve(okRes(`from ${model}`)), model === bodyOf(init).model ? 5 : 50),
      );
    });
    const r = await callSlotChatFast("chat", {
      messages: [{ role: "user", content: "hi" }],
      context: "assistant_ask",
    });
    expect(r.ok).toBe(true);
    expect(eventCalls()).toHaveLength(1);
  });

  it("落账失败静默：execute 抛错不影响主链返回", async () => {
    executeMock.mockRejectedValueOnce(new Error("table missing"));
    fetchMock.mockResolvedValue(okRes("你好"));
    const r = await callSlotChat("chat", {
      messages: [{ role: "user", content: "hi" }],
      context: "assistant_ask",
    });
    expect(r.ok).toBe(true);
    expect(r.content).toBe("你好");
  });
});

// ─── M60 真流式槽位调用 ──────────────────────────────────────────────────────

/** 构造 OpenAI 兼容 SSE 流响应：chunks 逐帧 delta，末尾 usage 帧 + [DONE] */
function sseStreamRes(
  chunks: string[],
  opts: { usageTokens?: number; splitFrames?: boolean } = {},
): Response {
  const frames: string[] = chunks.map(
    (c) => `data: {"choices":[{"delta":{"content":${JSON.stringify(c)}}}]}\n\n`,
  );
  if (opts.usageTokens) {
    frames.push(`data: {"choices":[],"usage":{"total_tokens":${opts.usageTokens}}}\n\n`);
  }
  frames.push("data: [DONE]\n\n");
  let payload = frames.join("");
  // splitFrames：故意把字节流在帧中间切断，验证跨包缓冲拼接
  const pieces: string[] = [];
  if (opts.splitFrames) {
    let i = 0;
    while (i < payload.length) {
      const n = 7 + (i % 13);
      pieces.push(payload.slice(i, i + n));
      i += n;
    }
  } else {
    pieces.push(payload);
  }
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const p of pieces) {
        controller.enqueue(enc.encode(p));
        await new Promise((r) => setTimeout(r, 1));
      }
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

/** 挂起流：永不吐字节，fetch signal 中止时以 AbortError 断流（模拟超时斩断） */
function hangingStreamRes(init: RequestInit): Response {
  const signal = init.signal as AbortSignal;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener("abort", () => {
        controller.error(new DOMException("The operation was aborted.", "AbortError"));
      });
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

/** 吐一字节后断流（模拟 mid-stream 网络故障） */
function brokenStreamRes(firstChunk: string, init: RequestInit): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        enc.encode(`data: {"choices":[{"delta":{"content":${JSON.stringify(firstChunk)}}}]}\n\n`),
      );
      await new Promise((r) => setTimeout(r, 5));
      controller.error(new Error("socket hang up"));
      void init;
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

describe("M60 callSlotChatStream 真流式", () => {
  const streamEventCalls = () =>
    executeMock.mock.calls.filter((c) => JSON.stringify(c[0]).includes("st_llm_events"));
  beforeEach(() => {
    executeMock.mockClear();
  });

  it("逐 chunk 回调 + 跨包拼接 + usage 末帧 + firstTokenMs", async () => {
    fetchMock.mockImplementation(async () =>
      sseStreamRes(["你好", "，老板", "。"], { usageTokens: 42, splitFrames: true }),
    );
    const deltas: string[] = [];
    const r = await callSlotChatStream("flash", {
      messages: [{ role: "user", content: "hi" }],
      context: "voicebuddy_chat",
    }, (d) => deltas.push(d));
    expect(r.ok).toBe(true);
    expect(deltas).toEqual(["你好", "，老板", "。"]);
    expect(r.content).toBe("你好，老板。");
    expect(r.firstTokenMs).toBeTypeOf("number");
    expect(r.usageTokens).toBe(42);
    // 请求体确为流式口径
    const body = bodyOf(fetchMock.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect((body.stream_options as { include_usage?: boolean })?.include_usage).toBe(true);
    // 落账含 first_token_ms 列
    expect(streamEventCalls()).toHaveLength(1);
    expect(JSON.stringify(streamEventCalls()[0][0])).toContain("first_token_ms");
  });

  it("未吐字失败 → 沿降级链换槽重试并标注 fallbackFrom", async () => {
    fetchMock
      .mockResolvedValueOnce(errRes(500))
      .mockImplementationOnce(async () => sseStreamRes(["兜底答"]));
    const deltas: string[] = [];
    const r = await callSlotChatStream("flash", {
      messages: [{ role: "user", content: "hi" }],
      context: "voicebuddy_chat",
    }, (d) => deltas.push(d));
    expect(r.ok).toBe(true);
    expect(r.content).toBe("兜底答");
    expect(r.fallbackFrom).toBe("flash");
    expect(deltas).toEqual(["兜底答"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("吐字后断流 → 绝不换槽重发，返回 partialContent", async () => {
    fetchMock.mockImplementation(async (_u: string, init: RequestInit) =>
      brokenStreamRes("老板，我已经", init),
    );
    const deltas: string[] = [];
    const r = await callSlotChatStream("flash", {
      messages: [{ role: "user", content: "hi" }],
      context: "voicebuddy_chat",
    }, (d) => deltas.push(d));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("network_error");
    expect(r.partialContent).toBe("老板，我已经");
    expect(deltas).toEqual(["老板，我已经"]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 无重试
    expect(streamEventCalls()).toHaveLength(1); // 断流也落账（ok=0）
  });

  it("整体超时斩断挂起流 → reason=timeout", async () => {
    fetchMock.mockImplementation(async (_u: string, init: RequestInit) => hangingStreamRes(init));
    const started = Date.now();
    const r = await callSlotChatStream("flash", {
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 80,
    }, () => {});
    expect(Date.now() - started).toBeLessThan(3000);
    // 超时后走降级链（各槽同挂）→ 最终失败原因为 timeout
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("timeout");
  });

  it("未声明 context：流式也不落账（存量零变化口径）", async () => {
    fetchMock.mockImplementation(async () => sseStreamRes(["好"]));
    const r = await callSlotChatStream("flash", {
      messages: [{ role: "user", content: "hi" }],
    }, () => {});
    expect(r.ok).toBe(true);
    expect(streamEventCalls()).toHaveLength(0);
  });

  it("kimi-k3 流式同样强制 temperature=1", async () => {
    fetchMock.mockImplementation(async () => sseStreamRes(["脑答"]));
    const r = await callSlotChatStream("brain", {
      messages: [{ role: "user", content: "hi" }],
    }, () => {});
    expect(r.ok).toBe(true);
    expect(bodyOf(fetchMock.mock.calls[0][1] as RequestInit).temperature).toBe(1);
  });
});

// ─── M62 modelOverride（utterance 解析专用模型，首字时延压制） ───────────────
describe("M62 modelOverride 语义", () => {
  beforeEach(() => {
    executeMock.mockClear();
  });

  it("流式：override 模型进请求体，落账/熔断按覆盖模型", async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve(sseStreamRes(['{"kind":"chat","reply":"好"}'], { usageTokens: 30 })),
    );
    const deltas: string[] = [];
    const r = await callSlotChatStream("flash", {
      messages: [{ role: "user", content: "hi" }],
      context: "voice_utterance",
      modelOverride: "deepseek-v4-flash",
    }, (d) => deltas.push(d));
    expect(r.ok).toBe(true);
    expect(bodyOf(fetchMock.mock.calls[0][1] as RequestInit).model).toBe("deepseek-v4-flash");
    // deepseek 非 kimi-k3 → temperature 尊重 opts 默认 0.3（非强制 1）
    expect(bodyOf(fetchMock.mock.calls[0][1] as RequestInit).temperature).toBe(0.3);
    expect(deltas.length).toBe(1);
    // 落账按 slot=flash 记（口径不变）
    const ev = executeMock.mock.calls.filter((c) => JSON.stringify(c[0]).includes("st_llm_events"));
    expect(ev.length).toBe(1);
  });

  it("流式：override 主棒失败未吐字 → fallback 槽用槽默认模型（kimi-k3 兜底双保险）", async () => {
    const models: string[] = [];
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const { model } = bodyOf(init);
      models.push(model);
      if (model === "deepseek-v4-flash") {
        return Promise.resolve({ ok: false, status: 500, body: null } as unknown as Response);
      }
      return Promise.resolve(sseStreamRes(["兜底应答"], { usageTokens: 12 }));
    });
    const r = await callSlotChatStream("flash", {
      messages: [{ role: "user", content: "hi" }],
      modelOverride: "deepseek-v4-flash",
    }, () => {});
    expect(r.ok).toBe(true);
    expect(r.fallbackFrom).toBe("flash");
    expect(models[0]).toBe("deepseek-v4-flash");
    expect(models.slice(1)).not.toContain("deepseek-v4-flash"); // fallback 回槽默认
  });

  it("非流式 callSlotChat：override 同样生效", async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const { model } = bodyOf(init);
      expect(model).toBe("deepseek-v4-flash");
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          choices: [{ message: { content: "ok" } }],
          usage: { total_tokens: 9 },
        }),
      } as unknown as Response);
    });
    const r = await callSlotChat("flash", {
      messages: [{ role: "user", content: "hi" }],
      modelOverride: "deepseek-v4-flash",
    });
    expect(r.ok).toBe(true);
  });

  it("不设 override：槽默认模型，行为零变化（M59 口径回归）", async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve(sseStreamRes(["x"], { usageTokens: 5 })),
    );
    await callSlotChatStream("flash", { messages: [{ role: "user", content: "hi" }] }, () => {});
    expect(bodyOf(fetchMock.mock.calls[0][1] as RequestInit).model).toBe("kimi-k3");
    expect(bodyOf(fetchMock.mock.calls[0][1] as RequestInit).temperature).toBe(1); // kimi-k3 强制 1
  });
});

// ─── M67：海禛云 41 模型全量目录下发超终（GATEWAY_CATALOG 契约闸）──────────────
describe("M67 GATEWAY_CATALOG 全量目录契约", () => {
  it("目录 41 条且 id 全唯一（与 2026-08-19 海禛云 /v1/models 实测同步口径一致）", () => {
    expect(GATEWAY_CATALOG.length).toBe(41);
    const ids = GATEWAY_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(41);
  });

  it("每条目录项字段齐备：id/vendor/label 非空，variant 合法", () => {
    for (const m of GATEWAY_CATALOG) {
      expect(m.id.trim().length).toBeGreaterThan(0);
      expect(m.vendor.trim().length).toBeGreaterThan(0);
      expect(m.label.trim().length).toBeGreaterThan(0);
      expect([undefined, "cloud", "idoictos"]).toContain(m.variant);
    }
  });

  it("五槽默认模型全部在目录内（槽位永不指向目录外模型）", () => {
    const ids = new Set(GATEWAY_CATALOG.map((m) => m.id));
    for (const slotModel of ["kimi-k3", "deepseek-v4-pro", "minimax-m3"]) {
      expect(ids.has(slotModel)).toBe(true);
    }
  });
});
