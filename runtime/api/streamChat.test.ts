/**
 * M8-c 流式输出验收单测（app.fetch 直接打 GET /api/stream/duty-chat）：
 * 1. 帧序 facts → delta* → done（facts 同步先行，delta 逐段，done 收尾）；
 * 2. stripSecrets 帧级生效：LLM 回复里的 st_/pk_ 敏感串不出现在任何帧；
 * 3. 无效 token → 401（SSE 未开启）；缺 message → 400；
 * 4. LLM 失败 → error 帧 + done(degraded:true)，且 facts 已送达。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// boot.ts → kimi/auth 在模块加载期建 JWKS URL，测试环境需先补合法地址
vi.hoisted(() => {
  process.env.KIMI_AUTH_URL = process.env.KIMI_AUTH_URL || "https://mock-kimi.example.com";
  process.env.KIMI_OPEN_URL = process.env.KIMI_OPEN_URL || "https://mock-kimi.example.com";
});

const fastMock = vi.fn();
const slowMock = vi.fn();

vi.mock("./routers/modelGateway", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/modelGateway")>();
  return {
    ...orig,
    callSlotChatFast: (...args: unknown[]) => fastMock(...args),
    callSlotChat: (...args: unknown[]) => slowMock(...args),
  };
});

// ─── 假 DB：select 链服务 sessionMe（wbUsers/wbFactories），execute 服务实况聚合 ──

type Row = Record<string, unknown>;
let authUser: Row | null;
let authFactory: Row | null;
let protocols: Row[];
let signals: Row[];
let plansAgg: Row;
let silent: Row[];
let frozenAgg: Row[];

function route(text: string): unknown {
  if (text.includes("FROM st_protocols")) return [protocols];
  if (text.includes("FROM st_auto_signals")) return [signals];
  if (text.includes("FROM st_intent_plans")) return [[plansAgg]];
  if (text.includes("FROM wb_factories")) return [silent];
  if (text.includes("FROM st_freeze_events")) return [frozenAgg];
  return [[]];
}

vi.mock("./queries/connection", async () => {
  const { MySqlDialect } = await import("drizzle-orm/mysql-core");
  const { wbUsers, wbFactories } = await import("@db/schema");
  const dialect = new MySqlDialect();
  return {
    getDb: () => ({
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => {
              if (table === wbUsers) return authUser ? [authUser] : [];
              if (table === wbFactories) return authFactory ? [authFactory] : [];
              return [];
            },
          }),
        }),
      }),
      execute: async (stmt: unknown) => {
        const q = dialect.sqlToQuery(stmt as never);
        return route(q.sql);
      },
    }),
  };
});

import app from "./boot";

// ─── SSE 帧解析 ──────────────────────────────────────────────────────────────

interface SseFrame {
  event: string;
  data: string;
}

/** 解析完整 SSE 文本为帧序列（注释行/心跳块丢弃） */
function parseSse(raw: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const blk of raw.split(/\r?\n\r?\n/)) {
    const lines = blk.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith(":")) continue; // 注释心跳
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    frames.push({ event, data: dataLines.join("\n") });
  }
  return frames;
}

const ENDPOINT = "http://localhost/api/stream/duty-chat";
const REPLY = "结论：平台平稳。依据：票据 st_abc123 与 pk_xyz999 均已核销，信号在控。建议例行巡检即可。";

beforeEach(() => {
  fastMock.mockReset();
  slowMock.mockReset();
  fastMock.mockResolvedValue({ ok: true, content: REPLY, provider: "mock-flash", latencyMs: 5, hedged: false });
  slowMock.mockResolvedValue({ ok: false, reason: "should_not_fallback" });
  authUser = { id: 1, username: "admin", displayName: "总管理员", role: "admin", factoryId: 1 };
  authFactory = { id: 10, enterpriseName: "TEST_甲厂" };
  protocols = [{ code: "p1", name: "测试协议", level: "B", status: "draft" }];
  signals = [{ level: "C", c: 2 }];
  plansAgg = { total: 5, today: 1, executed: 3, pendingConfirm: 1, failed: 1 };
  silent = [{ id: 9, name: "某某厂" }];
  frozenAgg = [{ factory_id: 1, fz: 1, ufz: 0 }];
});

describe("GET /api/stream/duty-chat（M8-c）", () => {
  it("帧序 facts → delta* → done，facts 为真实数据要点", async () => {
    const res = await app.fetch(new Request(`${ENDPOINT}?token=TEST_t&message=${encodeURIComponent("今天怎么样")}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const raw = await res.text();
    const frames = parseSse(raw);
    const seq = frames.map((f) => f.event);

    expect(seq[0]).toBe("facts");
    expect(seq[seq.length - 1]).toBe("done");
    const deltaSeq = seq.slice(1, -1);
    expect(deltaSeq.length).toBeGreaterThanOrEqual(2); // 按标点切成了多段
    expect(deltaSeq.every((e) => e === "delta")).toBe(true);

    const facts = JSON.parse(frames[0]!.data) as { facts: string[] };
    expect(facts.facts.join("\n")).toContain("p1");
    expect(facts.facts.join("\n")).toContain("C级 2 条");

    const reply = frames
      .filter((f) => f.event === "delta")
      .map((f) => (JSON.parse(f.data) as { text: string }).text)
      .join("");
    expect(reply).toContain("平台平稳");
    expect(reply).toContain("例行巡检");

    const done = JSON.parse(frames[frames.length - 1]!.data) as { degraded: boolean; truncated: boolean };
    expect(done).toEqual({ degraded: false, truncated: false });
    expect(fastMock).toHaveBeenCalled();
    expect(slowMock).not.toHaveBeenCalled(); // 竞速成功不回落
  });

  it("stripSecrets 帧级生效：st_/pk_ 敏感串不出现在任何帧", async () => {
    const res = await app.fetch(new Request(`${ENDPOINT}?token=TEST_t&message=x`));
    const raw = await res.text();
    expect(raw).not.toMatch(/st_abc123|pk_xyz999/);
    expect(raw).toContain("[已遮蔽]");
  });

  it("竞速双败 → 回落 callSlotChat 顺序链路", async () => {
    fastMock.mockRejectedValue(new Error("双通道均失败"));
    slowMock.mockResolvedValue({ ok: true, content: "回落链路回复：一切正常。" });
    const res = await app.fetch(new Request(`${ENDPOINT}?token=TEST_t&message=x`));
    const frames = parseSse(await res.text());
    const reply = frames
      .filter((f) => f.event === "delta")
      .map((f) => (JSON.parse(f.data) as { text: string }).text)
      .join("");
    expect(reply).toContain("回落链路回复");
    expect(slowMock).toHaveBeenCalled();
  });

  it("LLM 全链路失败 → error 帧 + done(degraded:true)，facts 已送达", async () => {
    fastMock.mockRejectedValue(new Error("双通道均失败"));
    slowMock.mockResolvedValue({ ok: false, reason: "not_configured" });
    const res = await app.fetch(new Request(`${ENDPOINT}?token=TEST_t&message=x`));
    const frames = parseSse(await res.text());
    const seq = frames.map((f) => f.event);
    expect(seq[0]).toBe("facts"); // facts 先行已送达
    const facts = JSON.parse(frames[0]!.data) as { facts: string[] };
    expect(facts.facts.length).toBeGreaterThan(0);
    const errIdx = seq.indexOf("error");
    expect(errIdx).toBeGreaterThan(0);
    expect(seq[seq.length - 1]).toBe("done");
    const done = JSON.parse(frames[frames.length - 1]!.data) as { degraded: boolean };
    expect(done.degraded).toBe(true);
    // error 帧不带内部错误细节
    const errData = JSON.parse(frames[errIdx]!.data) as { message: string };
    expect(errData.message).not.toContain("not_configured");
  });

  it("无效 token → 401（SSE 未开启）", async () => {
    authUser = null;
    const res = await app.fetch(new Request(`${ENDPOINT}?token=TEST_bad&message=x`));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("管理员");
    expect(fastMock).not.toHaveBeenCalled();
  });

  it("H1 反向：企业号 member token → 401（平台级聚合数据不跨租户暴露）", async () => {
    authUser = { id: 9, username: "boss", displayName: "老板", role: "member", factoryId: 10 };
    const res = await app.fetch(new Request(`${ENDPOINT}?token=TEST_member&message=x`));
    expect(res.status).toBe(401);
    expect(fastMock).not.toHaveBeenCalled();
  });

  it("缺 message → 400", async () => {
    const res = await app.fetch(new Request(`${ENDPOINT}?token=TEST_t`));
    expect(res.status).toBe(400);
  });
});
