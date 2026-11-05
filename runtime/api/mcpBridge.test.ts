/**
 * M38「技能插件上总线」mcpBridge 验收单测：
 * 1. 内部令牌：无效令牌拒；env 未配置时通道整体关闭（绝不裸奔）。
 * 2. skillCatalog：只回可见集（基础包+已雇佣已挂载），无敏感字段。
 * 3. skillExec：not_visible → FORBIDDEN；budget → TOO_MANY；成功 → brief + 24h 产出物链接。
 */
import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";
import { TRPCError } from "@trpc/server";

const catalogMock = vi.fn();
const execMock = vi.fn();
vi.mock("./routers/voiceSkills", () => ({
  loadVisibleSkills: (...args: unknown[]) => catalogMock(...args),
  execSkillDirect: (...args: unknown[]) => execMock(...args),
}));

const rosterMock = vi.fn();
const taskMock = vi.fn();
vi.mock("./routers/agentBridge", () => ({
  listVoiceAgentRoster: (...args: unknown[]) => rosterMock(...args),
  runWorkbenchAgentTask: (...args: unknown[]) => taskMock(...args),
}));

vi.mock("./routers/terminal", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/terminal")>();
  return {
    ...orig,
    stQuery: async (q: unknown) => {
      const t = JSON.stringify(q) ?? "";
      if (t.includes("st_gate_tickets")) return [{ c: 3 }];
      if (t.includes("st_evo_proposals")) return [{ c: 2 }];
      if (t.includes("st_skill_calls")) return [{ c: 41 }];
      if (t.includes("st_device_plugins")) return [{ c: 1 }];
      if (t.includes("st_dag_runs")) return [{ id: 7, goal: "写放假通知", status: "done", runtime: "dsh", createdAt: "2026-08-14 10:30:00" }];
      return [];
    },
  };
});

import { mcpBridgeRouter } from "./routers/mcpBridge";

const caller = mcpBridgeRouter.createCaller({} as never);
const OLD_ENV = process.env.MCP_INTERNAL_TOKEN;

beforeEach(() => {
  process.env.MCP_INTERNAL_TOKEN = "TEST_INTERNAL_TOKEN";
  catalogMock.mockReset();
  execMock.mockReset();
  rosterMock.mockReset();
  taskMock.mockReset();
  catalogMock.mockResolvedValue([
    { skillKey: "docx_make", name: "文书起草", description: "生成 Word 文书", pricePerCall: 100 },
    { skillKey: "data_analysis", name: "经营分析", description: "分析经营数据", pricePerCall: 100 },
  ]);
  rosterMock.mockResolvedValue([
    { code: "lingsCe", name: "灵策", title: "COO 运营官", deptCode: "ops" },
    { code: "lingsSuan", name: "灵算", title: "首席财务官", deptCode: "finance" },
  ]);
  taskMock.mockResolvedValue({
    agentCode: "lingsSuan",
    agentName: "灵算",
    agentTitle: "首席财务官",
    reply: "本月毛利率 32%，环比 +2pt。",
    artifacts: [],
    usedSkills: [],
    degraded: false,
  });
});

afterAll(() => {
  if (OLD_ENV === undefined) delete process.env.MCP_INTERNAL_TOKEN;
  else process.env.MCP_INTERNAL_TOKEN = OLD_ENV;
});

describe("内部令牌纪律", () => {
  it("无效令牌拒（两个端点同纪律）", async () => {
    await expect(caller.skillCatalog({ token: "wrong", factoryId: 10 })).rejects.toThrowError(/令牌无效/);
    await expect(
      caller.skillExec({ token: "wrong", factoryId: 10, skillKey: "docx_make", task: "写个通知" }),
    ).rejects.toThrowError(/令牌无效/);
  });
  it("env 未配置 → 通道关闭（绝不裸奔）", async () => {
    delete process.env.MCP_INTERNAL_TOKEN;
    await expect(caller.skillCatalog({ token: "anything", factoryId: 10 })).rejects.toThrowError(/通道关闭/);
  });
});

describe("skillCatalog", () => {
  it("回可见集（key/name/description，无价格等敏感字段外溢到工具面）", async () => {
    const r = await caller.skillCatalog({ token: "TEST_INTERNAL_TOKEN", factoryId: 10 });
    expect(r.skills).toHaveLength(2);
    expect(r.skills[0]).toEqual({ skillKey: "docx_make", name: "文书起草", description: "生成 Word 文书" });
    expect(catalogMock).toHaveBeenCalledWith(10);
  });
});

describe("skillExec", () => {
  it("成功：brief + 产出物链接透传，actor 口径 mcp:<factoryId>", async () => {
    execMock.mockResolvedValue({ ok: true, brief: "文书已生成", artifactUrl: "/files/ab48.docx", artifactTitle: "通知.docx" });
    const r = await caller.skillExec({ token: "TEST_INTERNAL_TOKEN", factoryId: 10, skillKey: "docx_make", task: "写个放假通知" });
    expect(r.ok).toBe(true);
    expect(r.brief).toBe("文书已生成");
    expect(r.artifactUrl).toBe("/files/ab48.docx");
    expect(execMock).toHaveBeenCalledWith({ factoryId: 10, skillKey: "docx_make", task: "写个放假通知", actor: "mcp:10" });
  });
  it("not_visible → FORBIDDEN；budget → TOO_MANY；exec_failed → ok:false 不抛错", async () => {
    execMock.mockResolvedValueOnce({ ok: false, brief: "技能不可见（未雇佣或未挂载）", reason: "not_visible" });
    await expect(
      caller.skillExec({ token: "TEST_INTERNAL_TOKEN", factoryId: 10, skillKey: "nope", task: "x" }),
    ).rejects.toThrowError(/不可见/);
    execMock.mockResolvedValueOnce({ ok: false, brief: "今日技能额度已用完", reason: "budget" });
    await expect(
      caller.skillExec({ token: "TEST_INTERNAL_TOKEN", factoryId: 10, skillKey: "docx_make", task: "x" }),
    ).rejects.toThrowError(TRPCError);
    execMock.mockResolvedValueOnce({ ok: false, brief: "技能执行线路异常", reason: "exec_failed" });
    const r = await caller.skillExec({ token: "TEST_INTERNAL_TOKEN", factoryId: 10, skillKey: "docx_make", task: "x" });
    expect(r.ok).toBe(false);
  });
});

describe("deptAsk（P3 部门插件）", () => {
  it("按部门映射主官执行（finance→灵算），actor 口径 mcp:<factoryId>", async () => {
    const r = await caller.deptAsk({ token: "TEST_INTERNAL_TOKEN", factoryId: 10, deptCode: "finance", question: "本月毛利率多少" });
    expect(r.ok).toBe(true);
    expect(r.agent.name).toBe("灵算");
    expect(r.reply).toContain("32%");
    expect(taskMock).toHaveBeenCalledWith({ agentCode: "lingsSuan", task: "本月毛利率多少", username: "mcp:10", runtime: "bridge", factoryId: 10 });
  });
  it("M44：runtime=dsh 透传（智能体走 DSH 底座）", async () => {
    taskMock.mockResolvedValueOnce({
      agentCode: "lingsSuan", agentName: "灵算", agentTitle: "首席财务官",
      reply: "[DSH] 深度分析完成", artifacts: [], usedSkills: ["dsh-runtime"], degraded: false,
    });
    const r = await caller.deptAsk({ token: "TEST_INTERNAL_TOKEN", factoryId: 10, deptCode: "finance", question: "深度拆解成本", runtime: "dsh" });
    expect(r.ok).toBe(true);
    expect(taskMock).toHaveBeenCalledWith({ agentCode: "lingsSuan", task: "深度拆解成本", username: "mcp:10", runtime: "dsh", factoryId: 10 });
  });
  it("主官缺位退同部门在役；整部门无在役 → PRECONDITION_FAILED", async () => {
    rosterMock.mockResolvedValue([{ code: "lingsMou", name: "灵眸", title: "CMO", deptCode: "ops" }]);
    const r = await caller.deptAsk({ token: "TEST_INTERNAL_TOKEN", factoryId: 10, deptCode: "ops", question: "这周排产顺不顺" });
    expect(r.ok).toBe(true);
    rosterMock.mockResolvedValue([]);
    await expect(
      caller.deptAsk({ token: "TEST_INTERNAL_TOKEN", factoryId: 10, deptCode: "legal", question: "合同能签吗" }),
    ).rejects.toThrowError(/无在役/);
  });
  it("智能体未启用（run null）→ PRECONDITION_FAILED；坏令牌拒", async () => {
    taskMock.mockResolvedValueOnce(null);
    await expect(
      caller.deptAsk({ token: "TEST_INTERNAL_TOKEN", factoryId: 10, deptCode: "finance", question: "问一句" }),
    ).rejects.toThrowError(/未启用/);
    await expect(
      caller.deptAsk({ token: "wrong", factoryId: 10, deptCode: "finance", question: "问一句" }),
    ).rejects.toThrowError(/令牌无效/);
  });
});

describe("adminDigest（P4 超终插件）", () => {
  it("平台域只读摘要：五类计数 + 近期任务图", async () => {
    const r = await caller.adminDigest({ token: "TEST_INTERNAL_TOKEN" });
    expect(r.gateTicketsOpen).toBe(3);
    expect(r.evoProposalsPending).toBe(2);
    expect(r.skillCallsToday).toBe(41);
    expect(r.devicePluginsActive).toBe(1);
    expect(r.dagRecent[0]).toMatchObject({ id: 7, runtime: "dsh", status: "done" });
  });
  it("坏令牌拒", async () => {
    await expect(caller.adminDigest({ token: "nope" })).rejects.toThrowError(/令牌无效/);
  });
});
