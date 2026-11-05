/**
 * M23a 数字人记忆（wbMemory）测试（SQL 层 mock，不连库；测试数据 TEST_ 前缀）。
 *
 * 断言矩阵：
 * 1. detectRemember 必中：「记住/帮我记住/记一下」开头（可带冒号/逗号分隔）→ 提取内容；
 * 2. detectRemember 必不中：「我记得上次…」（主语前缀）、「请记住我」（非开头）、空口令「记住」→ null；
 * 2b. detectRemember 防垃圾记忆：实质内容 <4 字（「记住就行」「记住了吗」）、
 *     句尾语气词「吗/呢/吧」结尾（「记住明天要下雨吗」）→ null，不拦截走正常链；
 * 3. saveMemory：importance 钳制 1-5、content stripSecrets+截断 300、空净化结果不落库；
 * 4. LRU 淘汰：未删除记忆 >100 → 按 importance 最低+最久未用取超出量物理删除；
 * 5. recallMemories：返回召回正文 + 被召回行 uses+1/lastUsedAt 置位（update 留痕）；
 * 6. parseExtractedMemories：合法 JSON 数组 → ≤2 条钳制；非数组/坏 JSON → 空；
 * 7. scheduleMemoryExtraction：LLM 给 2 条 → 写 2 条 preference/fact；LLM 故障 → 静默不写；
 * 8. myMemories：本人全部未删除记忆倒序返回（sessionMe 两段 select + 记忆 select）；
 * 9. forget：软删 deletedAt 置位（update 留痕），幂等 ok:true。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

let selectQueue: Row[][];
let inserted: Row[];
let updates: Row[];
let deleteCalls: number;
let nextId: number;

const chatMock = vi.fn();

vi.mock("./routers/modelGateway", () => ({
  callSlotChat: (...args: unknown[]) => chatMock(...args),
  callSlotChatFast: vi.fn(async () => {
    throw new Error("fast lane disabled in tests");
  }),
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
      where: async () => {
        deleteCalls += 1;
        return [{ affectedRows: 1 }];
      },
    }),
  };
  return { getDb: () => db };
});

import {
  detectRemember,
  parseExtractedMemories,
  recallMemories,
  saveMemory,
  scheduleMemoryExtraction,
  wbMemoryRouter,
  MEMORY_CAP,
} from "./routers/wbMemory";

const caller = wbMemoryRouter.createCaller({} as never);

const factoryRow = { id: 10, enterpriseName: "TEST_星云企业", departments: [] };
const userRow = { id: 1, username: "TEST_boss", displayName: "TEST_老板", role: "owner", factoryId: 10, authToken: "TEST_tok" };

function memoryRow(over: Row = {}): Row {
  return {
    id: 7,
    factoryId: 10,
    userId: 1,
    persona: "lingshu",
    scope: "user",
    kind: "note",
    content: "TEST_老板喜欢浓茶",
    importance: 4,
    uses: 0,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    lastUsedAt: null,
    deletedAt: null,
    ...over,
  };
}

beforeEach(() => {
  selectQueue = [];
  inserted = [];
  updates = [];
  deleteCalls = 0;
  nextId = 100;
  chatMock.mockReset();
});

describe("detectRemember 显式口令本地预判", () => {
  it("1. 必中：三种前缀 + 分隔符变体均提取内容", () => {
    expect(detectRemember("记住我喜欢喝浓茶")?.content).toBe("我喜欢喝浓茶");
    expect(detectRemember("帮我记住：周五要交报表")?.content).toBe("周五要交报表");
    expect(detectRemember("记一下，三号机床异响")?.content).toBe("三号机床异响");
  });

  it("2. 必不中：主语前缀/非开头/空口令 → null", () => {
    expect(detectRemember("我记得上次说过的事")).toBeNull();
    expect(detectRemember("请记住我这句话")).toBeNull();
    expect(detectRemember("记住")).toBeNull(); // 空口令走正常语音链
    expect(detectRemember("今天产量怎么样")).toBeNull();
  });

  it("2b. 防垃圾记忆：实质内容 <4 字 / 句尾语气词（吗呢吧） → null（不拦截走正常链）", () => {
    expect(detectRemember("记住了吗")).toBeNull(); // 去前缀仅「了吗」2 字
    expect(detectRemember("记住就行")).toBeNull(); // 去前缀仅「就行」2 字
    expect(detectRemember("记一下，好的")).toBeNull(); // 「好的」2 字
    expect(detectRemember("记住明天要下雨吗")).toBeNull(); // 句尾「吗」=疑问非嘱托
    expect(detectRemember("记住要开会吧")).toBeNull(); // 句尾「吧」
    expect(detectRemember("帮我记住：先这样吧。")).toBeNull(); // 剥离句尾标点后仍以「吧」结尾
    expect(detectRemember("记住三号机床异响呢")).toBeNull(); // 句尾「呢」
    // 对照：≥4 字且非语气词结尾仍命中
    expect(detectRemember("记住周五要交报表")?.content).toBe("周五要交报表");
  });
});

describe("saveMemory 写入口径", () => {
  it("3. importance 钳制 1-5、content stripSecrets + 截断 300", async () => {
    selectQueue.push([{ id: 100 }]); // owning（容量内，无淘汰）
    const long = `含密钥 st_ab12cd34 与 ${"长".repeat(400)}`;
    const id = await saveMemory({
      factoryId: 10, userId: 1, persona: "lingshu",
      scope: "user", kind: "note", content: long, importance: 99,
    });
    expect(id).toBe(100);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.importance).toBe(5);
    expect(String(inserted[0]!.content)).not.toMatch(/st_ab12cd34/);
    expect(String(inserted[0]!.content)).toContain("[已遮蔽]");
    expect(String(inserted[0]!.content).length).toBeLessThanOrEqual(300);
    expect(deleteCalls).toBe(0);
  });

  it("3b. 净化后空正文不落库（返回 0，无 insert）", async () => {
    const id = await saveMemory({
      factoryId: 10, userId: 1, persona: "lingshu",
      scope: "user", kind: "note", content: "   ",
    });
    expect(id).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it("4. LRU 淘汰：超 100 条 → 超出量按重要性最低+最久未用物理删除", async () => {
    // owning 返回 CAP+2 → 淘汰 2 条；victims 返回两条最低重要性 id
    selectQueue.push(
      Array.from({ length: MEMORY_CAP + 2 }, (_, i) => ({ id: i + 1 })),
      [{ id: 3 }, { id: 9 }],
    );
    await saveMemory({
      factoryId: 10, userId: 1, persona: "lingshu",
      scope: "user", kind: "note", content: "TEST_新记忆",
    });
    expect(deleteCalls).toBe(1); // 批量物理删除一次（LRU 语义，不占软删审计）
  });

  it("4b. scope=factory 系统事件不占个人容量（不触发淘汰查询）", async () => {
    await saveMemory({
      factoryId: 10, userId: 1, persona: "lingshu",
      scope: "factory", kind: "fact", content: "TEST_全厂夜班本周调整",
    });
    expect(inserted).toHaveLength(1);
    expect(selectQueue).toHaveLength(0); // 无 owning 查询
    expect(deleteCalls).toBe(0);
  });
});

describe("recallMemories 召回", () => {
  it("5. 返回 top 8 正文 + 被召回行 uses+1/lastUsedAt 置位；空召回无 update", async () => {
    selectQueue.push([memoryRow({ id: 7 }), memoryRow({ id: 8, content: "TEST_周五交报表" })]);
    const out = await recallMemories(10, 1, "lingshu");
    expect(out).toEqual(["TEST_老板喜欢浓茶", "TEST_周五交报表"]);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.lastUsedAt).toBeInstanceOf(Date);

    updates = [];
    selectQueue.push([]);
    const empty = await recallMemories(10, 1, "lingshu");
    expect(empty).toEqual([]);
    expect(updates).toHaveLength(0);
  });
});

describe("通道② 异步 LLM 提炼", () => {
  it("6. parseExtractedMemories：合法数组 ≤2 条 + 非法一律空", () => {
    const good = parseExtractedMemories(
      '```json\n[{"kind":"preference","content":"喜欢浓茶","importance":4},{"kind":"fact","content":"周五交报表","importance":9},{"kind":"fact","content":"多余第三条","importance":1}]\n```',
    );
    expect(good).toHaveLength(2); // ≤2 钳制
    expect(good[0]).toEqual({ kind: "preference", content: "喜欢浓茶", importance: 4 });
    expect(good[1]!.importance).toBe(5); // importance 钳制上限
    expect(parseExtractedMemories('{"kind":"chat"}')).toEqual([]); // 非数组
    expect(parseExtractedMemories("根本不是 JSON")).toEqual([]);
    expect(parseExtractedMemories("[]")).toEqual([]);
  });

  it("7. LLM 给 2 条 → 落库 2 条 preference/fact；LLM 故障 → 静默不写", async () => {
    chatMock.mockResolvedValue({
      ok: true,
      content: '[{"kind":"preference","content":"TEST_喜欢浓茶","importance":4},{"kind":"fact","content":"TEST_周五交报表","importance":3}]',
    });
    selectQueue.push([{ id: 100 }], [{ id: 101 }]); // 两次 owning（容量内）
    await scheduleMemoryExtraction({
      factoryId: 10, userId: 1, persona: "lingshu",
      userText: "以后报表都从简", agentReply: "好的",
    });
    expect(inserted).toHaveLength(2);
    expect(inserted[0]!.kind).toBe("preference");
    expect(inserted[0]!.scope).toBe("user");
    expect(inserted[1]!.kind).toBe("fact");

    inserted = [];
    chatMock.mockResolvedValue({ ok: false });
    await scheduleMemoryExtraction({
      factoryId: 10, userId: 1, persona: "lingshu",
      userText: "随便聊聊", agentReply: "嗯",
    });
    expect(inserted).toHaveLength(0); // 失败静默
  });
});

describe("管理接口 myMemories / forget", () => {
  it("8. myMemories：本人全部未删除记忆倒序返回，卡片不含 factoryId 内部列", async () => {
    selectQueue.push(
      [userRow], // sessionMe user
      [factoryRow], // sessionMe factory
      [memoryRow({ id: 9 }), memoryRow({ id: 7 })], // 倒序（mock 重演 SQL ORDER BY id DESC）
    );
    const r = await caller.myMemories({ token: "TEST_tok" });
    expect(r.items.map((m) => m.memoryId)).toEqual([9, 7]); // 出参 items（同 wbAssets.list 惯例）
    expect(r.items[0]).not.toHaveProperty("factoryId");
    expect(r.items[0]).toMatchObject({ kind: "note", importance: 4, scope: "user", uses: 0 });
  });

  it("9. forget：软删 deletedAt 置位 + 幂等 ok:true（二次/越权 id 同样 ok）", async () => {
    selectQueue.push([userRow], [factoryRow]);
    const r1 = await caller.forget({ token: "TEST_tok", memoryId: 7 });
    expect(r1.ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.deletedAt).toBeInstanceOf(Date);

    selectQueue.push([userRow], [factoryRow]);
    const r2 = await caller.forget({ token: "TEST_tok", memoryId: 7 }); // 幂等
    expect(r2.ok).toBe(true);
  });
});
