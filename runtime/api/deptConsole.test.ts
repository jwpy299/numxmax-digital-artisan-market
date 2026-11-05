/**
 * M47 部门工作台单测：
 * 1. 非管理员一律拒绝；
 * 2. listConsoles 返回三部门并正确解析驻部智能体 JSON；
 * 3. setChief/setAgents 校验在役花名册（不在册拒绝）；
 * 4. chat 选中主官、DSH 开→runtime=dsh、关→bridge；
 * 5. 未配置主官且驻部为空 → 明确 PRECONDITION_FAILED，不猜不编。
 */
import { describe, expect, it, vi } from "vitest";

const updates: Array<{ sql: string; params?: unknown[]; raw?: string }> = [];
const chatCalls: Array<{ agentCode: string; runtime?: string }> = [];

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    execute: async (q: unknown) => {
      const t = sqlTextOf(q);
      if (/FROM st_dept_consoles/.test(t)) {
        return [[
          { id: 1, dept_code: "ops", dept_name: "运营部", chief_agent_code: "ayun", agent_codes: ["ayun", "chenzao"], dsh_enabled: 1, model_slot: "chat", config: { staffDeptKeys: ["ops"] }, updated_at: "2026-08-16" },
          { id: 2, dept_code: "brand", dept_name: "品牌部", chief_agent_code: null, agent_codes: "[]", dsh_enabled: 1, model_slot: "chat", updated_at: "2026-08-16" },
          { id: 3, dept_code: "marketing", dept_name: "市场部", chief_agent_code: null, agent_codes: "not-json", dsh_enabled: 0, model_slot: "flash", updated_at: "2026-08-16" },
        ]];
      }
      if (/UPDATE st_dept_consoles/.test(t)) {
        updates.push({ sql: t, params: [], raw: JSON.stringify(q) });
        return [{ affectedRows: 1 }];
      }
      return [[]];
    },
  }),
}));
vi.mock("./routers/terminal", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/terminal")>();
  return {
    ...orig,
    requireAdmin: async (token: string) => {
      if (token !== "TEST_admin") throw new Error("管理员凭证无效");
      return { id: 1, username: "TEST_admin" };
    },
  };
});
vi.mock("./routers/staff", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/staff")>();
  return {
    ...orig,
    requireStaff: async (token: string) => {
      if (token === "STAFF_ops") return { id: 9, username: "xiaoyun", displayName: "小云", deptKey: "ops", role: "staff", disabled: 0 };
      if (token === "STAFF_nowhere") return { id: 10, username: "youzi", displayName: "游子", deptKey: "finance", role: "staff", disabled: 0 };
      throw new Error("staff 凭证无效");
    },
  };
});
vi.mock("./routers/agentBridge", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/agentBridge")>();
  return {
    ...orig,
    listVoiceAgentRoster: async () => [
      { code: "ayun", name: "阿云", title: "运营专员", deptCode: "ops" },
      { code: "chenzao", name: "晨早", title: "内容专员", deptCode: "brand" },
    ],
    runWorkbenchAgentTask: async (opts: { agentCode: string; runtime?: "bridge" | "dsh" }) => {
      chatCalls.push({ agentCode: opts.agentCode, runtime: opts.runtime });
      return {
        ok: true,
        agentCode: opts.agentCode,
        agentName: opts.agentCode === "ayun" ? "阿云" : "晨早",
        agentTitle: "驻部数字员工",
        reply: "收到",
        artifacts: [],
      };
    },
  };
});

function sqlParamsOf(q: unknown): unknown[] {
  const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return [];
  return chunks
    .filter((c) => (c as { constructor?: { name?: string } })?.constructor?.name !== "StringChunk")
    .map((c) => (c as { value?: unknown }).value);
}

function sqlTextOf(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return String(q ?? "");
  return chunks
    .filter((c) => (c as { constructor?: { name?: string } })?.constructor?.name === "StringChunk")
    .map((c) => {
      const v = (c as { value?: unknown }).value;
      return Array.isArray(v) ? v.join("") : String(v ?? "");
    })
    .join("");
}

import { deptConsoleRouter, deptPrimaryModelOf, parseAllowedModels } from "./routers/deptConsole";

const caller = deptConsoleRouter.createCaller({} as never);

describe("M47 部门工作台", () => {
  it("JSON 列双形态：mysql2 已解析的数组/对象不再被二次 parse 吞掉", async () => {
    const rows = await caller.listConsoles({ token: "TEST_admin" });
    expect(rows[0].agentCodes).toEqual(["ayun", "chenzao"]);
    expect(rows[0].staffDeptKeys).toEqual(["ops"]);
    expect(rows[0].agentCount).toBe(2);
  });

  it("非管理员拒绝", async () => {
    await expect(caller.listConsoles({ token: "bad" })).rejects.toThrow();
  });

  it("listConsoles：三部门 + JSON 解析 + 主官画像", async () => {
    const rows = await caller.listConsoles({ token: "TEST_admin" });
    expect(rows.map((r) => r.deptCode)).toEqual(["ops", "brand", "marketing"]);
    expect(rows[0].agentCodes).toEqual(["ayun", "chenzao"]);
    expect(rows[0].chiefAgent?.name).toBe("阿云");
    expect(rows[0].dshEnabled).toBe(true);
    expect(rows[2].agentCodes).toEqual([]); // 坏 JSON 安全落空
    expect(rows[2].dshEnabled).toBe(false);
  });

  it("setChief：不在册拒绝，在册落库", async () => {
    await expect(
      caller.setChief({ token: "TEST_admin", deptCode: "brand", agentCode: "ghost" }),
    ).rejects.toThrow(/在役花名册/);
    const r = await caller.setChief({ token: "TEST_admin", deptCode: "brand", agentCode: "chenzao" });
    expect(r.ok).toBe(true);
    expect(updates.length).toBeGreaterThan(0);
  });

  it("setAgents：含不在册成员整体拒绝", async () => {
    await expect(
      caller.setAgents({ token: "TEST_admin", deptCode: "ops", agentCodes: ["ayun", "ghost"] }),
    ).rejects.toThrow(/ghost/);
  });

  it("chat：命中主官且 DSH 开 → runtime=dsh", async () => {
    chatCalls.length = 0;
    const r = await caller.chat({ token: "TEST_admin", deptCode: "ops", message: "今天设备稼动率如何" });
    expect(r.ok).toBe(true);
    expect(chatCalls[0].agentCode).toBe("ayun");
    expect(chatCalls[0].runtime).toBe("dsh");
  });

  it("APP 员工通道：归属部门命中主官并走 DSH；无归属诚实拒绝", async () => {
    chatCalls.length = 0;
    const me = await caller.myConsole({ token: "STAFF_ops" });
    expect(me.joined).toBe(true);
    if (me.joined) expect(me.chiefAgent?.name).toBe("阿云");
    const r = await caller.chatStaff({ token: "STAFF_ops", message: "帮我整理今天的运营纪要" });
    expect(r.ok).toBe(true);
    expect(r.runtime).toBe("dsh");
    expect(chatCalls[0].agentCode).toBe("ayun");
    const outsider = await caller.myConsole({ token: "STAFF_nowhere" });
    expect(outsider.joined).toBe(false);
    await expect(
      caller.chatStaff({ token: "STAFF_nowhere", message: "我也想问" }),
    ).rejects.toThrow(/尚未接入部门工作台/);
  });

  it("chat：DSH 关 → bridge；无主官无驻部 → 明确报错", async () => {
    chatCalls.length = 0;
    // marketing：dsh_enabled=0，chief=null，agent_codes 坏 JSON → 无可用智能体
    await expect(
      caller.chat({ token: "TEST_admin", deptCode: "marketing", message: "市场部今天干什么" }),
    ).rejects.toThrow(/尚未配置在役智能体/);
    expect(chatCalls.length).toBe(0);
  });
});

describe("M79 部门适配模型集合（彭总 2026-08-24 指派令）", () => {
  it("setEngine 写 allowedModels：目录内 id 落库 JSON", async () => {
    updates.length = 0;
    const r = await caller.setEngine({ token: "TEST_admin", deptCode: "ops", allowedModels: ["gpt-5.5-pro", "gpt-5.6-sol"] });
    expect(r.ok).toBe(true);
    const u = updates.find((x) => x.sql.includes("allowed_models"));
    expect(u).toBeTruthy();
    expect(u!.raw ?? JSON.stringify(u!.params)).toContain("gpt-5.5-pro");
  });
  it("目录外 id 精确拒绝（笔误宁可拒）", async () => {
    await expect(
      caller.setEngine({ token: "TEST_admin", deptCode: "ops", allowedModels: ["gpt-99-ultra"] }),
    ).rejects.toThrow("不在海禛云目录");
  });
  it("空数组=清除限制（写 NULL）", async () => {
    updates.length = 0;
    await caller.setEngine({ token: "TEST_admin", deptCode: "ops", allowedModels: [] });
    const u = updates.find((x) => x.sql.includes("allowed_models"));
    expect(u).toBeTruthy();
  });
  it("listConsoles 载荷带 allowedModels（null 兜底不炸）", async () => {
    const rows = await caller.listConsoles({ token: "TEST_admin" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].allowedModels ?? null).toBeNull(); // 假库行未带列 → null
  });
  it("deptPrimaryModelOf：假库无列 → null（槽位默认），不抛", async () => {
    const m = await deptPrimaryModelOf("ops");
    expect(m).toBeNull();
  });
  it("parseAllowedModels 纯函数：字符串/对象/坏值三态", async () => {
    expect(parseAllowedModels('["kimi-k3"]')).toEqual(["kimi-k3"]);
    expect(parseAllowedModels(["deepseek-v4-flash"])).toEqual(["deepseek-v4-flash"]);
    expect(parseAllowedModels("not-json")).toBeNull();
    expect(parseAllowedModels(null)).toBeNull();
    expect(parseAllowedModels([])).toBeNull();
  });
});
