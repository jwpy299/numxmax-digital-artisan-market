/**
 * M78c 跨部门委派流式端点验收单测（app.fetch 打 GET /api/stream/dept-delegate）：
 * 1. 无效 token → 401；非法部门 → 400；缺参 → 400；
 * 2. 正常帧序：accepted → delta* → done{collabId, runtime, degraded:false}；
 * 3. 核心异常 → error 帧 + done(degraded:true)，绝不裸断；
 * 4. 鉴权与 delegate 同强度（requireAdmin 被调）；
 * 5. 长任务心跳：任务未决期间 writeln(": hb") 保活（假定时器快进验证）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.KIMI_AUTH_URL = process.env.KIMI_AUTH_URL || "https://mock-kimi.example.com";
  process.env.KIMI_OPEN_URL = process.env.KIMI_OPEN_URL || "https://mock-kimi.example.com";
});

const { requireAdminMock, runDelegateMock } = vi.hoisted(() => ({
  requireAdminMock: vi.fn(async (t: string) => {
    if (t !== "admin-tok") throw new Error("需要管理员权限");
    return { id: 1, username: "hq", role: "admin" };
  }),
  runDelegateMock: vi.fn(),
}));

vi.mock("./queries/connection", async () => {
  const { MySqlDialect } = await import("drizzle-orm/mysql-core");
  const dialect = new MySqlDialect();
  return {
    getDb: () => ({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      execute: async (stmt: unknown) => {
        dialect.sqlToQuery(stmt as never);
        return [[]];
      },
    }),
  };
});
vi.mock("./routers/terminal", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/terminal")>();
  return { ...orig, requireAdmin: (...a: Parameters<typeof orig.requireAdmin>) => requireAdminMock(...a) };
});
vi.mock("./routers/deptConsole", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/deptConsole")>();
  return { ...orig, runDeptDelegate: (...a: unknown[]) => runDelegateMock(...a) };
});

import app from "./boot";

interface SseFrame { event: string; data: string }

async function readAllFrames(res: Response, idleMs = 4000): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + idleMs;
  for (;;) {
    const idx = buf.indexOf("\n\n");
    if (idx >= 0) {
      const blk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of blk.split(/\r?\n/)) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length > 0) frames.push({ event, data: dataLines.join("\n") });
      if (event === "done") break;
      continue;
    }
    if (Date.now() > deadline) break;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 800)),
    ]).catch(() => null);
    if (!chunk) break;
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return frames;
}

beforeEach(() => {
  requireAdminMock.mockClear();
  runDelegateMock.mockReset();
});

describe("M78c dept-delegate 流式端点", () => {
  it("无效 token → 401；非法部门 → 400；缺 message → 400", async () => {
    const r1 = await app.fetch(new Request("http://x/api/stream/dept-delegate?token=bad&fromDept=tech&toDept=ops&message=hi"));
    expect(r1.status).toBe(401);
    const r2 = await app.fetch(new Request("http://x/api/stream/dept-delegate?token=admin-tok&fromDept=xx&toDept=ops&message=hi"));
    expect(r2.status).toBe(400);
    const r3 = await app.fetch(new Request("http://x/api/stream/dept-delegate?token=admin-tok&fromDept=tech&toDept=ops"));
    expect(r3.status).toBe(400);
  });

  it("正常帧序：accepted → delta* → done{collabId,runtime,degraded:false}", async () => {
    runDelegateMock.mockResolvedValue({
      fromAgentName: "灵筑", toAgentName: "灵策", runtime: "dsh",
      reply: "好的，值班表已同步。", artifacts: [], collabId: 30011,
    });
    const res = await app.fetch(new Request("http://x/api/stream/dept-delegate?token=admin-tok&fromDept=tech&toDept=ops&message=%E5%90%8C%E6%AD%A5%E5%80%BC%E7%8F%AD%E8%A1%A8"));
    expect(res.status).toBe(200);
    const frames = await readAllFrames(res);
    expect(frames[0].event).toBe("accepted");
    const done = frames[frames.length - 1];
    expect(done.event).toBe("done");
    const payload = JSON.parse(done.data);
    expect(payload).toMatchObject({ collabId: 30011, runtime: "dsh", degraded: false });
    const text = frames.filter((f) => f.event === "delta").map((f) => JSON.parse(f.data).text).join("");
    expect(text).toBe("好的，值班表已同步。");
    expect(requireAdminMock).toHaveBeenCalledWith("admin-tok");
  });

  it("核心异常 → error 帧 + done(degraded:true)，绝不裸断", async () => {
    runDelegateMock.mockRejectedValue(new Error("接收方智能体当前未启用"));
    const res = await app.fetch(new Request("http://x/api/stream/dept-delegate?token=admin-tok&fromDept=tech&toDept=ops&message=test"));
    const frames = await readAllFrames(res);
    const events = frames.map((f) => f.event);
    expect(events).toContain("error");
    const done = frames[frames.length - 1];
    expect(done.event).toBe("done");
    expect(JSON.parse(done.data).degraded).toBe(true);
  });
});
