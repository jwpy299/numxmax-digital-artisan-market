/**
 * M9-c 记忆个性化验收单测（SQL 层 mock，不连库）：
 * 1. 规则识别：记住/以后都/我喜欢/别叫我X叫我Y/忘掉类指令 → 正确提炼 (mkey,mvalue)；闲聊不误判；
 * 2. 记住 → 落库 + 回复确认「已记住：…」（响应结构与正常 chat 一致）；
 * 3. 注入：后续正常对话的 system 上下文含「用户偏好：k=v」（≤5 条）；
 * 4. 同键重复记住 → upsert 覆盖；
 * 5. 忘掉所有偏好/清空记忆 → 该用户记忆清空 + 确认，后续对话不再注入；
 * 6. 跨厂隔离：A 厂用户记忆不泄到 B 厂（同名用户也不可见）；
 * 7. 安全：mvalue 落库前过 stripSecrets（st_/pk_ 敏感串不落记忆）；单条 mvalue ≤200 字截断。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const chatMock = vi.fn();

vi.mock("./routers/modelGateway", () => ({
  callSlotChat: (...args: unknown[]) => chatMock(...args),
  callSlotChatFast: (...args: unknown[]) => chatMock(...args),
}));

// ─── 状态ful 假 DB：sessionMe 走 select 队列；st_user_memory 用内存表模拟 ──────

type Row = Record<string, unknown>;
interface MemRow {
  factory_id: number;
  username: string;
  mkey: string;
  mvalue: string;
  seq: number;
}

let selectQueue: Row[][] = [];
let memoryTable: MemRow[] = [];
let memSeq = 0;

function route(text: string, params: unknown[]): unknown {
  if (text.includes("INSERT INTO st_user_memory")) {
    const [factoryId, username, mkey, mvalue] = params as [number, string, string, string];
    const existing = memoryTable.find(
      (r) => r.factory_id === factoryId && r.username === username && r.mkey === mkey,
    );
    if (existing) existing.mvalue = mvalue; // ON DUPLICATE KEY UPDATE
    else memoryTable.push({ factory_id: factoryId, username, mkey, mvalue, seq: ++memSeq });
    return [[]];
  }
  // 注意顺序：DELETE FROM st_user_memory 也含 "FROM st_user_memory"，须先判 DELETE
  if (text.includes("DELETE FROM st_user_memory")) {
    const [factoryId, username] = params as [number, string];
    memoryTable = memoryTable.filter((r) => !(r.factory_id === factoryId && r.username === username));
    return [[]];
  }
  if (text.includes("FROM st_user_memory")) {
    const [factoryId, username, limit] = params as [number, string, number];
    const rows = memoryTable
      .filter((r) => r.factory_id === factoryId && r.username === username)
      .sort((a, b) => b.seq - a.seq)
      .slice(0, Number(limit) || 5)
      .map((r) => ({ mkey: r.mkey, mvalue: r.mvalue }));
    return [rows];
  }
  // buildOrgBrief / isFactoryFrozen：空态
  return [[]];
}

vi.mock("./queries/connection", async () => {
  const { MySqlDialect } = await import("drizzle-orm/mysql-core");
  const dialect = new MySqlDialect();
  return {
    getDb: () => ({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => selectQueue.shift() ?? [],
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

import { voiceBuddyRouter, detectMemoryCommand } from "./routers/voiceBuddy";

const caller = voiceBuddyRouter.createCaller({} as never);

const userA = { id: 5, username: "boss", displayName: "王老板", role: "owner", factoryId: 10 };
const factoryA = { id: 10, enterpriseName: "A厂" };
const userB = { id: 6, username: "boss", displayName: "李老板", role: "owner", factoryId: 20 };
const factoryB = { id: 20, enterpriseName: "B厂" };

function login(u: Row, f: Row) {
  selectQueue.push([u], [f]);
}

async function chatAs(u: Row, f: Row, message: string) {
  login(u, f);
  return caller.chat({ token: "nt_test", persona: "lingshu", message });
}

beforeEach(() => {
  chatMock.mockReset();
  chatMock.mockResolvedValue({ ok: true, content: '{"reply":"今天一切正常","emotion":"calm"}' });
  selectQueue = [];
  memoryTable = [];
  memSeq = 0;
});

describe("记忆指令规则识别（detectMemoryCommand）", () => {
  it("记住我喜欢… → 喜好", () => {
    expect(detectMemoryCommand("记住我喜欢喝浓茶")).toEqual({ type: "remember", mkey: "喜好", mvalue: "喝浓茶" });
  });
  it("别叫我X叫我Y → 称呼", () => {
    expect(detectMemoryCommand("别叫我小王，叫我王总")).toEqual({ type: "remember", mkey: "称呼", mvalue: "王总" });
    expect(detectMemoryCommand("以后叫我老李")).toEqual({ type: "remember", mkey: "称呼", mvalue: "老李" });
  });
  it("以后都… → 习惯", () => {
    expect(detectMemoryCommand("以后都用简短回复")).toEqual({ type: "remember", mkey: "习惯", mvalue: "用简短回复" });
    expect(detectMemoryCommand("记住以后都先报风险")).toEqual({ type: "remember", mkey: "习惯", mvalue: "先报风险" });
  });
  it("裸句我喜欢…（≤30字）→ 喜好；我不喜欢 → 忌讳", () => {
    expect(detectMemoryCommand("我喜欢简洁的汇报")).toEqual({ type: "remember", mkey: "喜好", mvalue: "简洁的汇报" });
    expect(detectMemoryCommand("记住我不喜欢太长的回复")).toEqual({ type: "remember", mkey: "忌讳", mvalue: "太长的回复" });
  });
  it("其余记住… → 备注", () => {
    expect(detectMemoryCommand("记住我的车牌是沪A12345")).toEqual({ type: "remember", mkey: "备注", mvalue: "我的车牌是沪A12345" });
  });
  it("忘掉/清空类 → forget", () => {
    expect(detectMemoryCommand("忘掉所有偏好")).toEqual({ type: "forget" });
    expect(detectMemoryCommand("清空记忆")).toEqual({ type: "forget" });
    expect(detectMemoryCommand("忘记我的所有记忆")).toEqual({ type: "forget" });
  });
  it("普通闲聊不误判", () => {
    expect(detectMemoryCommand("今天产量怎么样")).toBeNull();
    expect(detectMemoryCommand("帮我看看昨天的报表")).toBeNull();
  });
});

describe("记住 → 确认 → 注入后续对话", () => {
  it("记住指令：落库 + 回复「已记住：…」，响应结构不变", async () => {
    const r = await chatAs(userA, factoryA, "记住我喜欢喝浓茶");
    expect(r.reply).toContain("已记住：喜好=喝浓茶");
    expect(["joy", "calm", "anxious", "frustrated", "urgent"]).toContain(r.emotion);
    expect(typeof r.rate).toBe("number");
    expect(typeof r.pitch).toBe("number");
    expect(memoryTable).toHaveLength(1);
    expect(memoryTable[0]).toMatchObject({ factory_id: 10, username: "boss", mkey: "喜好", mvalue: "喝浓茶" });
    // 记忆指令走规则路径，不消耗 LLM
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("后续正常对话：system 上下文注入「用户偏好」", async () => {
    await chatAs(userA, factoryA, "别叫我小王叫我王总");
    const r = await chatAs(userA, factoryA, "今天厂里怎么样");
    expect(r.reply).toBe("今天一切正常");
    expect(chatMock).toHaveBeenCalledTimes(1);
    const sys = String(chatMock.mock.calls[0][1].messages[0].content);
    expect(sys).toContain("称呼=王总");
  });

  it("无记忆用户：system 不含用户偏好段", async () => {
    await chatAs(userA, factoryA, "今天厂里怎么样");
    const sys = String(chatMock.mock.calls[0][1].messages[0].content);
    expect(sys).not.toContain("称呼=");
  });

  it("同键重复记住 → upsert 覆盖，只留一条", async () => {
    await chatAs(userA, factoryA, "记住我喜欢喝浓茶");
    await chatAs(userA, factoryA, "记住我喜欢喝美式");
    expect(memoryTable).toHaveLength(1);
    expect(memoryTable[0]!.mvalue).toBe("喝美式");
  });
});

describe("忘掉 → 清空", () => {
  it("忘掉所有偏好：记忆清空 + 确认，后续对话不再注入", async () => {
    await chatAs(userA, factoryA, "记住我喜欢喝浓茶");
    await chatAs(userA, factoryA, "以后都叫我王总");
    expect(memoryTable.length).toBeGreaterThan(0);
    const r = await chatAs(userA, factoryA, "忘掉所有偏好");
    expect(r.reply).toContain("已忘掉");
    expect(memoryTable).toHaveLength(0);
    await chatAs(userA, factoryA, "今天怎么样");
    const sys = String(chatMock.mock.calls[0][1].messages[0].content);
    expect(sys).not.toContain("喝浓茶");
    expect(sys).not.toContain("王总");
  });

  it("本就没有记忆时：确认无需清空", async () => {
    const r = await chatAs(userA, factoryA, "清空记忆");
    expect(r.reply).toContain("无需清空");
  });
});

describe("跨厂/跨人隔离", () => {
  it("A 厂记忆不泄到 B 厂（同名用户也隔离）", async () => {
    await chatAs(userA, factoryA, "记住我喜欢喝浓茶");
    await chatAs(userB, factoryB, "今天怎么样");
    const sys = String(chatMock.mock.calls[0][1].messages[0].content);
    expect(sys).not.toContain("喝浓茶");
    // B 厂自己记住后只看到自己的
    await chatAs(userB, factoryB, "记住我喜欢看日报");
    await chatAs(userB, factoryB, "今天怎么样");
    const sysB = String(chatMock.mock.calls[1][1].messages[0].content);
    expect(sysB).toContain("喜好=看日报");
    expect(sysB).not.toContain("喝浓茶");
  });
});

describe("安全约束", () => {
  it("mvalue 落库前过 stripSecrets：st_/pk_ 敏感串不落记忆", async () => {
    const r = await chatAs(userA, factoryA, "记住我的口令是 st_abc123 和 pk_xyz999");
    expect(r.reply).toContain("[已遮蔽]");
    expect(r.reply).not.toMatch(/st_abc123|pk_xyz999/);
    expect(memoryTable[0]!.mvalue).not.toMatch(/st_abc123|pk_xyz999/);
    expect(memoryTable[0]!.mvalue).toContain("[已遮蔽]");
  });

  it("单条 mvalue 超长截断至 200 字", async () => {
    const long = "记住" + "很长的偏好".repeat(60); // >200 字
    const r = await chatAs(userA, factoryA, long);
    expect(r.reply).toContain("已记住");
    expect(memoryTable[0]!.mvalue.length).toBeLessThanOrEqual(200);
  });
});
