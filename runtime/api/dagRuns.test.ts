/**
 * M33 Agent DAG 任务编排验收单测：
 * 1. plan：LLM 拆步（orggen 槽）→ 花名册过滤；LLM 不可用 → 单步兜底绝不放空。
 * 2. create：花名册外智能体拒；staff 拒；合法 → ready 落库。
 * 3. run：异步执行器逐步跑（agentBridge 桩）→ 全 done → 图 done；
 *    执行期重入 → 幂等 running。
 * 4. 失败：第 2 步失败 → 后续 skipped、图 failed；retry 断点续跑 → 全 done。
 * 5. 惰性恢复：running 且 updatedAt 停滞 >5min → 读侧标 failed。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("./routers/wbSession", () => ({
  sessionMe: async (token: string) => {
    if (token === "TEST_admin") return { user: { id: 7, username: "boss", displayName: "老板", role: "admin" }, factory: { id: 10 } };
    if (token === "TEST_staff") return { user: { id: 9, username: "staff", displayName: "员工", role: "member" }, factory: { id: 10 } };
    if (token === "TEST_other") return { user: { id: 99, username: "other", displayName: "外人", role: "admin" }, factory: { id: 20 } };
    throw new TRPCError({ code: "UNAUTHORIZED", message: "token 无效" });
  },
  normalizeRole: (role: string) => (role === "admin" || role === "owner" ? "admin" : role === "manager" ? "manager" : "staff"),
}));

const taskMock = vi.fn();
vi.mock("./routers/agentBridge", () => ({
  listVoiceAgentRoster: async () => [
    { code: "lingsCe", name: "灵策", title: "COO", deptCode: "ops" },
    { code: "lingsSuan", name: "灵算", title: "财务官", deptCode: "finance" },
  ],
  runWorkbenchAgentTask: (...args: unknown[]) => taskMock(...args),
}));

const llmMock = vi.fn();
vi.mock("./routers/modelGateway", () => ({
  callSlotChat: (...args: unknown[]) => llmMock(...args),
}));

// ─── 状态ful 假 DB ───────────────────────────────────────────────────────────
interface RunFake {
  id: number;
  factoryId: number;
  goal: string;
  steps: string;
  status: string;
  runtime: string;
  createdBy: number;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}
let runs: RunFake[];
let seq: number;

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
function sqlParamsOf(q: unknown): unknown[] {
  const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return [];
  const out: unknown[] = [];
  for (const c of chunks) {
    const isText = (c as { constructor?: { name?: string } })?.constructor?.name === "StringChunk";
    if (isText) continue;
    const rec = c as { value?: unknown };
    out.push(rec && typeof rec === "object" && "value" in rec ? rec.value : c);
  }
  return out;
}

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    execute: async (q: unknown) => {
      const t = sqlTextOf(q);
      const p = sqlParamsOf(q);
      if (/INSERT INTO st_dag_runs/.test(t)) {
        const id = seq++;
        runs.push({
          id,
          factoryId: Number(p[0]),
          goal: String(p[1]),
          steps: String(p[2]),
          status: "ready", // INSERT 文本里 'ready' 是字面量不进参数列
          runtime: String(p[3] ?? "bridge"),
          createdBy: Number(p[4]),
          createdAt: new Date(),
          updatedAt: new Date(),
          finishedAt: null,
        });
        return [{ insertId: id, affectedRows: 1 }];
      }
      if (/UPDATE st_dag_runs/.test(t)) {
        // 嵌套 sql 片段会把 status 藏进子 chunk：递归收集叶子参数再判定
        const leaf: unknown[] = [];
        const walk = (c: unknown): void => {
          const rec = c as { constructor?: { name?: string }; value?: unknown; queryChunks?: unknown[] };
          if (rec?.constructor?.name === "StringChunk") return;
          if (rec && Array.isArray(rec.queryChunks)) {
            for (const cc of rec.queryChunks) walk(cc);
            return;
          }
          if (rec && typeof rec === "object" && "value" in rec) leaf.push(rec.value);
          else leaf.push(c);
        };
        for (const c of (q as { queryChunks?: unknown[] }).queryChunks ?? []) walk(c);
        const run = runs.find((r) => leaf.some((v) => typeof v === "number" && v === r.id));
        if (run) {
          for (const v of leaf) {
            if (typeof v === "string" && v.startsWith("[")) run.steps = v;
            if (typeof v === "string" && ["ready", "running", "done", "failed"].includes(v)) run.status = v;
          }
          if (t.includes("'running'")) run.status = "running";
          run.updatedAt = new Date();
          if (/finishedAt = UTC_TIMESTAMP/.test(t)) run.finishedAt = new Date();
          if (/finishedAt = NULL/.test(t)) run.finishedAt = null;
        }
        return [{ affectedRows: run ? 1 : 0 }];
      }
      return [[]];
    },
  }),
}));

vi.mock("./routers/terminal", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/terminal")>();
  return {
    ...orig,
    stQuery: async (q: unknown) => {
      const t = sqlTextOf(q);
      const p = sqlParamsOf(q);
      if (/FROM st_dag_runs WHERE id/.test(t)) {
        const r = runs.find((x) => x.id === Number(p[0]) && x.factoryId === Number(p[1]));
        return r ? [{ ...r }] : [];
      }
      if (/FROM st_dag_runs r LEFT JOIN wb_users/.test(t)) {
        return runs.filter((r) => r.factoryId === 10).map((r) => ({ ...r, creatorName: "老板" }));
      }
      return [];
    },
  };
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { dagRunsRouter } from "./routers/dagRuns";
import { parseDbUtc } from "./routers/dbTime";

const caller = dagRunsRouter.createCaller({} as never);

/** 等图到终态（done/failed），最多 3s */
async function waitFinal(id: number): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const d = await caller.detail({ token: "TEST_admin", id });
    if (d.status === "done" || d.status === "failed") return d.status;
    await new Promise((r) => setTimeout(r, 100));
  }
  return "timeout";
}

beforeEach(() => {
  runs = [];
  seq = 1;
  process.env.DSH_SERVICE_TOKEN = "test_dsh_token";
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, answer: "DSH 底座应答：步骤已完成", durationMs: 1200 }),
  });
  taskMock.mockReset();
  llmMock.mockReset();
  taskMock.mockResolvedValue({ ok: true, agentCode: "lingsCe", agentName: "灵策", agentTitle: "COO", reply: "本步完成。", artifacts: [], usedSkills: [], degraded: false });
  llmMock.mockResolvedValue({
    ok: true,
    content: '[{"key":"s1","title":"盘点数据","agentCode":"lingsCe"},{"key":"s2","title":"核算成本","agentCode":"lingsSuan"}]',
  });
});

describe("M33 DAG 编排", () => {
  it("plan：LLM 拆步+花名册过滤；LLM 失败→单步兜底；staff 拒", async () => {
    const r = await caller.plan({ token: "TEST_admin", goal: "把三季度生产成本压 5%" });
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0]!.agentCode).toBe("lingsCe");

    llmMock.mockResolvedValue({ ok: false });
    const r2 = await caller.plan({ token: "TEST_admin", goal: "给全厂做一次安全巡检" });
    expect(r2.steps).toHaveLength(1);
    expect(r2.steps[0]!.agentCode).toBe("lingsCe");

    await expect(caller.plan({ token: "TEST_staff", goal: "员工越权试建图" })).rejects.toThrow(/负责人或管理员/);
  });

  it("create：花名册外拒；合法 ready；run 全绿到 done", async () => {
    await expect(
      caller.create({ token: "TEST_admin", goal: "测试任务图", steps: [{ key: "s1", title: "步一", agentCode: "ghost" }] }),
    ).rejects.toThrow(/花名册/);

    const c = await caller.create({
      token: "TEST_admin",
      goal: "分析 3 号机数据并出报告",
      runtime: "bridge",
      steps: [
        { key: "s1", title: "取数清洗", agentCode: "lingsCe" },
        { key: "s2", title: "出分析报告", agentCode: "lingsSuan" },
      ],
    });
    expect(c.ok).toBe(true);
    const r = await caller.run({ token: "TEST_admin", id: c.id });
    expect(r.status).toBe("running");
    // 执行期重入幂等：running（执行中）或 done（mock 秒回已跑完）都证明未双跑
    const r2 = await caller.run({ token: "TEST_admin", id: c.id });
    expect(["running", "done"]).toContain(r2.status);

    expect(await waitFinal(c.id)).toBe("done");
    const d = await caller.detail({ token: "TEST_admin", id: c.id });
    expect(d.steps.every((s) => s.status === "done")).toBe(true);
    // 两次 run 调用没有造成重复执行（幂等：仍只跑了 2 步）
    expect(taskMock).toHaveBeenCalledTimes(2);
  });

  it("失败即断：第 2 步失败 → 后续 skipped + 图 failed；retry 断点续跑到 done", async () => {
    taskMock
      .mockResolvedValueOnce({ ok: true, agentCode: "lingsCe", agentName: "灵策", agentTitle: "COO", reply: "第一步好", artifacts: [], usedSkills: [], degraded: false })
      .mockRejectedValueOnce(new Error("灵算线路忙"));

    const c = await caller.create({
      token: "TEST_admin",
      goal: "三步链路图",
      runtime: "bridge",
      steps: [
        { key: "s1", title: "步一", agentCode: "lingsCe" },
        { key: "s2", title: "步二", agentCode: "lingsSuan" },
        { key: "s3", title: "步三", agentCode: "lingsCe" },
      ],
    });
    await caller.run({ token: "TEST_admin", id: c.id });
    expect(await waitFinal(c.id)).toBe("failed");
    let d = await caller.detail({ token: "TEST_admin", id: c.id });
    expect(d.steps.map((s) => s.status)).toEqual(["done", "failed", "skipped"]);
    expect(d.steps[1]!.error).toContain("线路忙");

    // retry 断点续跑：s2 复位 + s3 复位，s1 的 done 保留不重跑
    taskMock.mockResolvedValue({ ok: true, agentCode: "lingsSuan", agentName: "灵算", agentTitle: "财务官", reply: "续跑完成", artifacts: [], usedSkills: [], degraded: false });
    await caller.retry({ token: "TEST_admin", id: c.id, stepKey: "s2" });
    expect(await waitFinal(c.id)).toBe("done");
    d = await caller.detail({ token: "TEST_admin", id: c.id });
    expect(d.steps.map((s) => s.status)).toEqual(["done", "done", "done"]);
    expect(d.steps[0]!.result).toBe("第一步好"); // 前序结果保留
  });

  it("惰性恢复：running 停滞 >5min → 读侧标 failed + running 步落 failed", async () => {
    const c = await caller.create({
      token: "TEST_admin",
      goal: "断片恢复图",
      runtime: "bridge",
      steps: [{ key: "s1", title: "步一", agentCode: "lingsCe" }],
    });
    // 手工摆一个断片 running（模拟进程重启）
    runs[0]!.status = "running";
    runs[0]!.updatedAt = new Date(Date.now() - 10 * 60_000);
    runs[0]!.steps = JSON.stringify([{ key: "s1", title: "步一", agentCode: "lingsCe", status: "running" }]);
    const d = await caller.detail({ token: "TEST_admin", id: c.id });
    expect(d.status).toBe("failed");
    expect(d.steps[0]!.status).toBe("failed");
    expect(d.steps[0]!.error).toContain("进程重启");
  });

  it("企业隔离：他企业读图 404", async () => {
    const c = await caller.create({
      token: "TEST_admin",
      goal: "企业隔离图",
      runtime: "bridge",
      steps: [{ key: "s1", title: "步一", agentCode: "lingsCe" }],
    });
    await expect(caller.detail({ token: "TEST_other", id: c.id })).rejects.toThrow(/不存在/);
  });
});

describe("parseDbUtc 时区口径（同坑第三变身回归保险）", () => {
  it("库内 UTC 墙钟按 UTC 解析，不按本地时区", () => {
    const ms = parseDbUtc("2026-08-13 03:41:22");
    expect(ms).toBe(Date.parse("2026-08-13T03:41:22Z"));
    // 带 T 无 Z 同样补 Z；带 Z 原样
    expect(parseDbUtc("2026-08-13T03:41:22")).toBe(ms);
    expect(parseDbUtc("2026-08-13T03:41:22Z")).toBe(ms);
    expect(Number.isNaN(parseDbUtc(""))).toBe(true);
  });
});

describe("M34b DAG 运行时双轨（DSH 底座试点 lane）", () => {
  it("runtime=dsh：步骤走 DSH 服务（fetch 18795 本机 runtime——18790 旧隧道面废），bridge 不动", async () => {
    const c = await caller.create({
      token: "TEST_admin",
      goal: "DSH 试点图",
      runtime: "dsh",
      steps: [{ key: "s1", title: "底座试跑", agentCode: "lingsCe" }],
    });
    await caller.run({ token: "TEST_admin", id: c.id });
    expect(await waitFinal(c.id)).toBe("done");
    const d = await caller.detail({ token: "TEST_admin", id: c.id });
    expect(d.runtime).toBe("dsh");
    expect(d.steps[0]!.result).toContain("[DSH]");
    // agentBridge 未被调用（全走 DSH）
    expect(taskMock).not.toHaveBeenCalled();
    // 打到了 DSH 服务且带 Bearer
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:18795/run");
    expect(String((init.headers as Record<string, string>).authorization)).toBe("Bearer test_dsh_token");
  });

  it("runtime 缺省=bridge：行为与原版一致（回归钉死）", async () => {
    const c = await caller.create({
      token: "TEST_admin",
      goal: "默认轨道图",
      runtime: "bridge",
      steps: [{ key: "s1", title: "默认走桥", agentCode: "lingsCe" }],
    });
    await caller.run({ token: "TEST_admin", id: c.id });
    expect(await waitFinal(c.id)).toBe("done");
    expect(taskMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
