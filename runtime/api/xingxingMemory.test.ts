/**
 * M23c 小星记忆（匠市客服接通记忆底座，彭总指令「小星也要记得注册用户」）测试。
 * SQL 层 mock，不连库；测试数据 TEST_ 前缀。
 *
 * 断言矩阵：
 * 1. 迁移幂等：sync-m23.mts 建表 DDL 枚举已含 'xingxing'；存量表走
 *    information_schema.COLUMNS 检测后才 ALTER ... MODIFY ENUM（additive/INPLACE），
 *    重复跑安全；DRY_RUN=1 语法自检实际跑通。
 * 2. 已登录召回注入：ask 带 token → 召回 persona='xingxing' 记忆注入 LLM userContent
 *    （「你记得的这位用户的事」块 + 「仅作背景参考，不主动复述除非相关」），召回行 uses+1 留痕。
 * 3. 匿名不召回：ask 无 token → prompt 无记忆块（匿名不记不记得，隐私红线），也不触发提炼。
 * 4. 提炼写入口径：scheduleXingxingExtraction ≤1 条、importance 钳 1-4、
 *    persona='xingxing'/scope='user'；LLM 故障静默不写。
 * 5. ask 主链火忘提炼：应答成功后异步落库 persona='xingxing' 记忆。
 * 6. 失败静默不阻断：flash 槽抛错，ask 仍正常应答、无落库、无未捕获异常。
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

let selectQueue: Row[][];
let inserted: Row[];
let updates: Row[];
let nextId: number;

const chatMock = vi.fn();

vi.mock("./routers/modelGateway", () => ({
  callSlotChat: (...args: unknown[]) => chatMock(...args),
  // M59：assistant.ask 主链改走竞速版——测试内竞速直接委托 chatMock（语义等价单通道）
  callSlotChatFast: vi.fn(async (...args: unknown[]) => chatMock(...args)),
  callModelChat: vi.fn(async () => ({ ok: false })),
  ensureProbed: vi.fn(async () => undefined),
  getModelGatewayStatus: vi.fn(() => ({ configuredCount: 0, totalCount: 4, verifiedCount: 0 })),
}));

vi.mock("./queries/connection", () => {
  const thenable = (rows: Row[]) => ({
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej),
  });
  const db = {
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
    delete: () => ({
      where: async () => [{ affectedRows: 1 }],
    }),
  };
  return { getDb: () => db };
});

import { assistantRouter } from "./routers/assistant";
import { recallMemories, scheduleXingxingExtraction } from "./routers/wbMemory";

const caller = assistantRouter.createCaller({} as never);

const userRow = {
  id: 42,
  username: "TEST_chenggong",
  displayName: "TEST_陈工",
  role: "owner",
  factoryId: 10,
  authToken: "TEST_tok",
};
const factoryRow = { id: 10, enterpriseName: "TEST_星云企业", departments: [] };

function memoryRow(over: Row = {}): Row {
  return {
    id: 7,
    factoryId: 10,
    userId: 42,
    persona: "xingxing",
    scope: "user",
    kind: "preference",
    content: "TEST_陈工关注按单结算",
    importance: 3,
    uses: 0,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    lastUsedAt: null,
    deletedAt: null,
    ...over,
  };
}

/** 默认 LLM 行为：问答链（assistant_ask）给客服应答；其余 flash 调用给一条记忆提炼（v157 快轨适配） */
function mockLlmDefault(): void {
  chatMock.mockImplementation(async (slot: string, opts?: { context?: string }) => {
    if (opts?.context === "assistant_ask" || slot === "chat") {
      return { ok: true, provider: "kimi", providerLabel: "Kimi", model: "m1", content: "TEST_小星应答：数字匠市支持按单结算。" };
    }
    if (slot === "flash") {
      return { ok: true, content: '[{"kind":"preference","content":"TEST_关注按单结算","importance":5}]' };
    }
    return { ok: true, provider: "kimi", providerLabel: "Kimi", model: "m1", content: "TEST_小星应答：数字匠市支持按单结算。" };
  });
}

/** 等火忘式异步链收尾（提炼/会话记录） */
const flush = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  selectQueue = [];
  inserted = [];
  updates = [];
  nextId = 100;
  chatMock.mockReset();
  mockLlmDefault();
});

describe("迁移幂等（persona 枚举 +xingxing）", () => {
  it("1a. sync-m23.mts：建表含三值枚举；存量表 information_schema 检测后才 ALTER MODIFY ENUM", () => {
    const src = readFileSync(path.resolve(import.meta.dirname, "../db/sync-m23.mts"), "utf8");
    // 新装库：CREATE TABLE 枚举直接含 'xingxing'
    expect(src).toContain("persona ENUM('lingshu','xingyun','xingxing') NOT NULL");
    // 存量库：先 information_schema 检测，命中缺值才 ALTER（幂等守卫在 ALTER 之前）
    const guardIdx = src.indexOf("information_schema.COLUMNS");
    const alterIdx = src.indexOf("ALTER TABLE wb_memories MODIFY persona ENUM('lingshu','xingyun','xingxing')");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(alterIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(alterIdx);
    expect(src).toContain("!personaColType.includes(\"'xingxing'\")");
    // 全程 additive：绝不出现 DROP
    expect(src).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });

  it("1b. DRY_RUN=1 语法自检实际跑通（不连库直接退出）", { timeout: 60_000 }, () => {
    const out = execSync("./node_modules/.bin/tsx db/sync-m23.mts", { // npx 不在 PATH=测试炸面封死（仓内惯例=./node_modules/.bin/ 直引——vitest 同律）
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, DRY_RUN: "1" },
      encoding: "utf8",
    });
    expect(out).toContain("dry run ok");
  });
});

describe("小星记忆召回（ask 注入 prompt）", () => {
  it("2. 已登录用户：召回 persona='xingxing' 记忆注入 userContent，召回行 uses+1 留痕", async () => {
    selectQueue.push(
      [userRow], // resolveIdentity user
      [factoryRow], // resolveIdentity factory
      [], // loadStats listings count（mock 槽位，无断言）
      [memoryRow({ id: 7 }), memoryRow({ id: 8, content: "TEST_陈工在意数据隔离" })], // recall top5
      [{ id: 100 }], // 应答后提炼 saveMemory owning
    );
    const r = await caller.ask({ token: "TEST_tok", message: "NumX Max 是做什么的？" });
    expect(r.llmUsed).toBe(true);
    const chatCall = chatMock.mock.calls.find((c) => c[0] === "chat" || (c[1] as { context?: string } | undefined)?.context === "assistant_ask");
    expect(chatCall).toBeTruthy();
    const userContent = (chatCall![1] as { messages: Array<{ role: string; content: string }> })
      .messages[1]!.content;
    expect(userContent).toContain("你记得的这位用户的事");
    expect(userContent).toContain("仅作背景参考，不主动复述除非相关");
    expect(userContent).toContain("TEST_陈工关注按单结算");
    expect(userContent).toContain("TEST_陈工在意数据隔离");
    // 召回留痕：uses+1 + lastUsedAt 置位
    expect(updates.some((u) => u.lastUsedAt instanceof Date)).toBe(true);
    await flush();
  });

  it("3. 匿名访客：不召回（prompt 无记忆块、不消耗记忆查询），也不触发提炼写入", async () => {
    selectQueue.push([]); // loadStats listings count 槽位
    const r = await caller.ask({ message: "NumX Max 是做什么的？" });
    expect(r.llmUsed).toBe(true);
    const chatCall = chatMock.mock.calls.find((c) => c[0] === "chat" || (c[1] as { context?: string } | undefined)?.context === "assistant_ask");
    const userContent = (chatCall![1] as { messages: Array<{ role: string; content: string }> })
      .messages[1]!.content;
    expect(userContent).toContain("用户身份：匿名访客。");
    expect(userContent).not.toContain("你记得的这位用户的事");
    await flush();
    // 匿名不提炼：无提炼向 flash 调用（ask 主链除外）、无落库
    expect(chatMock.mock.calls.some((c) => c[0] === "flash" && (c[1] as { context?: string } | undefined)?.context !== "assistant_ask")).toBe(false);
    expect(inserted).toHaveLength(0);
  });
});

describe("小星记忆写入（应答后异步提炼）", () => {
  it("4. scheduleXingxingExtraction：≤1 条 + importance 钳 1-4 + persona='xingxing'/scope='user'；LLM 故障静默", async () => {
    // LLM 给 2 条且 importance 超上限 → 只落 1 条、importance 钳到 4
    chatMock.mockImplementation(async () => ({
      ok: true,
      content:
        '[{"kind":"fact","content":"TEST_上次签约流程未走完","importance":5},{"kind":"preference","content":"TEST_多余第二条","importance":2}]',
    }));
    selectQueue.push([{ id: 100 }]); // owning（容量内）
    await scheduleXingxingExtraction({
      factoryId: 10,
      userId: 42,
      userText: "签约走到一半断了怎么办",
      agentReply: "TEST_可在合约页继续确认",
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      factoryId: 10,
      userId: 42,
      persona: "xingxing",
      scope: "user",
      kind: "fact",
      importance: 4,
    });

    inserted = [];
    chatMock.mockImplementation(async () => ({ ok: false }));
    await scheduleXingxingExtraction({
      factoryId: 10,
      userId: 42,
      userText: "随便问问",
      agentReply: "TEST_嗯",
    });
    expect(inserted).toHaveLength(0); // 失败静默不写
  });

  it("5. ask 应答成功后火忘提炼落库 persona='xingxing'（已登录用户）", async () => {
    selectQueue.push(
      [userRow],
      [factoryRow],
      [], // loadStats 槽位
      [], // recall 空（首次接待，暂无记忆）
      [{ id: 100 }], // 提炼 saveMemory owning
    );
    const r = await caller.ask({ token: "TEST_tok", message: "数字匠市怎么雇佣数字员工？" });
    expect(r.answer).toContain("TEST_小星应答");
    await flush();
    const flashCall = chatMock.mock.calls.find((c) => c[0] === "flash");
    expect(flashCall).toBeTruthy(); // 提炼确实被调度
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ persona: "xingxing", scope: "user", userId: 42, factoryId: 10 });
    expect(Number(inserted[0]!.importance)).toBeLessThanOrEqual(4);
  });

  it("6. 提炼失败静默不阻断客服主链（flash 抛错，ask 正常应答、无落库）", async () => {
    chatMock.mockImplementation(async (slot: string, opts?: { context?: string }) => {
      if (slot === "flash" && opts?.context !== "assistant_ask") throw new Error("TEST_LLM 抖动");
      return { ok: true, provider: "kimi", providerLabel: "Kimi", model: "m1", content: "TEST_小星应答" };
    });
    selectQueue.push([userRow], [factoryRow], [], []);
    const r = await caller.ask({ token: "TEST_tok", message: "NumX Max 是做什么的？" });
    expect(r.answer).toContain("TEST_小星应答"); // 主链不受提炼故障影响
    await flush();
    expect(inserted).toHaveLength(0);
  });
});

describe("PII 记忆遮蔽（双保险）", () => {
  it("8. handoff 含「联系我 13812345678」：提炼后记忆不含原号码（遮蔽为[手机号]），且提炼 prompt 带 PII 硬约束", async () => {
    chatMock.mockImplementation(async () => ({
      ok: true,
      content: '[{"kind":"fact","content":"TEST_用户留联系方式 13812345678 待跟进","importance":3}]',
    }));
    selectQueue.push([{ id: 100 }]); // owning（容量内）
    await scheduleXingxingExtraction({
      factoryId: 10,
      userId: 42,
      userText: "你们支持定制报价吗？联系我 13812345678",
      agentReply: "TEST_好的，稍后专员与您联系。",
    });
    // 保险一：提炼 prompt 含 PII 硬约束
    const flashCall = chatMock.mock.calls.find((c) => c[0] === "flash");
    const sysContent = (flashCall![1] as { messages: Array<{ role: string; content: string }> })
      .messages[0]!.content;
    expect(sysContent).toContain("绝不记录手机号、身份证号、银行卡号、住址、微信号等个人敏感信息");
    // 保险二：即使 LLM 违规输出号码，落库前被正则遮蔽
    expect(inserted).toHaveLength(1);
    expect(String(inserted[0]!.content)).not.toContain("13812345678");
    expect(String(inserted[0]!.content)).toContain("[手机号]");
  });

  it("9. 身份证 18 位与银行卡 16-19 位落库前遮蔽（[身份证号]/[卡号]）", async () => {
    chatMock.mockImplementation(async () => ({
      ok: true,
      content:
        '[{"kind":"fact","content":"TEST_身份证号 110101199003077758 卡号 6222020200112233445","importance":2}]',
    }));
    selectQueue.push([{ id: 100 }]);
    await scheduleXingxingExtraction({
      factoryId: 10,
      userId: 42,
      userText: "认证要填身份证和银行卡吗",
      agentReply: "TEST_企业认证环节需要。",
    });
    expect(inserted).toHaveLength(1);
    const content = String(inserted[0]!.content);
    expect(content).not.toContain("110101199003077758");
    expect(content).not.toContain("6222020200112233445");
    expect(content).toContain("[身份证号]");
    expect(content).toContain("[卡号]");
  });

  it("10. 正常偏好「喜欢铸造类设备」照常可记（PII 正则不误伤）", async () => {
    chatMock.mockImplementation(async () => ({
      ok: true,
      content: '[{"kind":"preference","content":"TEST_喜欢铸造类设备","importance":3}]',
    }));
    selectQueue.push([{ id: 100 }]);
    await scheduleXingxingExtraction({
      factoryId: 10,
      userId: 42,
      userText: "我主要做铸件，喜欢铸造类设备",
      agentReply: "TEST_已为您筛选铸造类设备。",
    });
    expect(inserted).toHaveLength(1);
    expect(String(inserted[0]!.content)).toBe("TEST_喜欢铸造类设备");
  });
});

describe("人格隔离", () => {
  it("7. 小星召回只认 persona='xingxing'：灵枢/星云记忆不会混入（SQL 按 persona 过滤，topN 可配）", async () => {
    // mock 重演 SQL：persona 过滤后仅剩小星记忆
    selectQueue.push([memoryRow({ id: 9, persona: "xingxing", content: "TEST_小星自己的记忆" })]);
    const out = await recallMemories(10, 42, "xingxing", undefined, 5);
    expect(out).toEqual(["TEST_小星自己的记忆"]);
    expect(out.some((c) => c.includes("灵枢"))).toBe(false);
  });
});
