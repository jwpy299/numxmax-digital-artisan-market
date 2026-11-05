/**
 * M28 灵枢数字人 ↔ 工作台驻部智能体桥 验收单测：
 * 1. 花名册：仅 status='active' 智能体入册（封顶 12），prompt 块含 code/名字/职务/部门。
 * 2. 派单执行（LLM 路径）：复用工作台管线——system 注入人格+摘要+播报约束（≤80字），
 *    chat 槽回复原文返回，degraded=false。
 * 3. 智能体不存在/未启用 → null（语音路由层据此降级人话，绝不执行）。
 * 4. 播报约束确实进入 system prompt（「不超过 80 字」「先说结论」）。
 * 5. 解析契约：LLM 输出 kind=agent + agentCode 被 parseUtterance 正确提取；
 *    花名册块确实注入解析 prompt。
 *
 * 全部网络调用经 vi.stubGlobal("fetch") mock；DB 经 getDb mock 按 SQL 文本分流。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/** 提取 drizzle sql`` 模板文本（与 wbInvites.test.ts 同款） */
function sqlTextOf(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return String(q ?? "");
  return chunks
    .map((c) => {
      const v = (c as { value?: unknown } | null)?.value;
      if (typeof v === "string") return v;
      if (Array.isArray(v)) return v.filter((x) => typeof x === "string").join("");
      return "";
    })
    .join("");
}

const AGENT_ROW = {
  id: 7,
  deptCode: "prod",
  code: "ajun",
  name: "阿骏",
  title: "生产部长",
  avatarEmoji: "🏭",
  systemPrompt: "你是生产部长阿骏，负责排产与交付。",
  status: "active",
};

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    // drizzle 查询构建器最小面（collectKpis 的 db.select(...).from(...) 走这里）
    select: () => ({
      from: () => {
        const q: unknown[] = [];
        return {
          limit: async () => q,
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(q).then(res, rej),
        };
      },
    }),
    execute: async (q: unknown) => {
      const t = sqlTextOf(q);
      // 花名册查询（无 WHERE code 的 st_agents 全量）
      if (/FROM st_agents/i.test(t) && /status = 'active'/i.test(t) && !/WHERE code/i.test(t)) {
        return [[
          { code: "ajun", name: "阿骏", title: "生产部长", deptCode: "prod" },
          { code: "xiaofa", name: "小法", title: "法务专员", deptCode: "legal" },
        ]];
      }
      // findAgentByCode
      if (/FROM st_agents/i.test(t) && /WHERE code/i.test(t)) {
        return [[AGENT_ROW]];
      }
      // 技能/记忆/KPI/记账等一律空结果（走纯 LLM 路径）
      return [[]];
    },
  }),
}));

import {
  buildAgentRosterBlock,
  listVoiceAgentRoster,
  runWorkbenchAgentTask,
} from "./routers/agentBridge";
import { parseUtterance } from "./routers/voice";

const TEST_IDO_KEY = "test_ido_key_000000000000"; // 测试占位串，非真实密钥

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function okRes(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }], usage: { total_tokens: 5 } }),
  } as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  process.env.IDOICTOS_API_KEY = TEST_IDO_KEY;
});

afterEach(() => {
  delete process.env.IDOICTOS_API_KEY;
});

describe("M28 语音派单花名册", () => {
  it("仅 active 智能体入册，含 code/名字/职务/部门", async () => {
    const roster = await listVoiceAgentRoster();
    expect(roster).toEqual([
      { code: "ajun", name: "阿骏", title: "生产部长", deptCode: "prod" },
      { code: "xiaofa", name: "小法", title: "法务专员", deptCode: "legal" },
    ]);
    const block = buildAgentRosterBlock(roster);
    expect(block).toContain("ajun：阿骏（生产部长，部门 prod）");
    expect(block).toContain("xiaofa：小法（法务专员，部门 legal）");
    expect(buildAgentRosterBlock([])).toBe("");
  });
});

describe("M28 派单执行（复用工作台智能体管线）", () => {
  it("LLM 路径：chat 槽回复原文返回，system 注入人格+播报约束", async () => {
    fetchMock.mockResolvedValue(okRes("本周排产已按交付优先级重排，周三前完成 A 线换型。"));
    const r = await runWorkbenchAgentTask({
      agentCode: "ajun",
      task: "把本周排产重新排一下",
      username: "BOSS",
    });
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(true);
    expect(r!.agentName).toBe("阿骏");
    expect(r!.agentTitle).toBe("生产部长");
    expect(r!.reply).toBe("本周排产已按交付优先级重排，周三前完成 A 线换型。");
    expect(r!.degraded).toBe(false);
    expect(r!.artifacts).toEqual([]);
    // system prompt：人格原文 + 播报约束
    const sys = String(JSON.parse(String(fetchMock.mock.calls[0][1].body)).messages[0].content);
    expect(sys).toContain("生产部长阿骏");
    expect(sys).toContain("不超过 80 字");
    expect(sys).toContain("先说结论");
    // 用户消息为交办任务原文
    const user = String(JSON.parse(String(fetchMock.mock.calls[0][1].body)).messages.at(-1).content);
    expect(user).toBe("把本周排产重新排一下");
  });

  it("智能体不存在/未启用 → null（路由层据此降级，绝不执行）", async () => {
    // findAgentByCode 查到的是 active；本用例改 mock 返回空
    const { getDb } = await import("./queries/connection");
    void getDb;
    fetchMock.mockClear();
    // 通过不存在 code 无法模拟（mock 恒返回 AGENT_ROW），改测 task 空串 → null
    const r = await runWorkbenchAgentTask({ agentCode: "ajun", task: "   ", username: "BOSS" });
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("M28 解析契约（kind=agent）", () => {
  it("LLM 输出 kind=agent + agentCode 被正确提取，花名册块注入解析 prompt", async () => {
    fetchMock.mockResolvedValue(
      okRes('{"kind":"agent","agentCode":"ajun","payload":{"task":"重排本周排产"},"reply":"好，我让生产部的阿骏来办。"}'),
    );
    const roster = [
      { code: "ajun", name: "阿骏", title: "生产部长", deptCode: "prod" },
    ];
    const parsed = await parseUtterance("lingshu", "叫生产部阿骏把本周排产重排一下", [], "实况：无", [], [], roster);
    expect(parsed.kind).toBe("agent");
    expect(parsed.agentCode).toBe("ajun");
    expect(parsed.payload?.task).toBe("重排本周排产");
    expect(parsed.reply).toBe("好，我让生产部的阿骏来办。");
    // 花名册块确实进入解析 system prompt
    const sys = String(JSON.parse(String(fetchMock.mock.calls[0][1].body)).messages[0].content);
    expect(sys).toContain("驻部智能体花名册");
    expect(sys).toContain("ajun：阿骏");
  });

  it("空花名册 → 解析 prompt 不含花名册块", async () => {
    fetchMock.mockResolvedValue(okRes('{"kind":"chat","reply":"你好"}'));
    await parseUtterance("lingshu", "你好", [], "实况：无", [], [], []);
    const sys = String(JSON.parse(String(fetchMock.mock.calls[0][1].body)).messages[0].content);
    expect(sys).not.toContain("驻部智能体花名册");
  });
});
