/**
 * M30 班组语音房验收单测：
 * 1. create：admin/manager 可开，staff 拒；同席智能体必须在役（不在役点名拒绝）。
 * 2. join：本企业可进，返回 TRTC 凭据（trtcUserId=String(user.id) 与签发同源）+ 房流快照；
 *    他企业房间 NOT_FOUND；closed 房拒进。
 * 3. say + mention：人话落房流；点名同席智能体 → agentBridge 应答落 kind=agent 房流；
 *    点名非同席 → 拒；应答限频（同房 60s 12 次）。
 * 4. messages 增量拉流（afterId 语义）。
 * 5. close：房主/admin 可关，第三人拒；幂等。
 *
 * 全部 DB 经 getDb mock（状态ful 假表），agentBridge 打桩，绝不发真实请求。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("./routers/wbSession", () => ({
  sessionMe: async (token: string) => {
    if (token === "TEST_admin") return { user: { id: 7, username: "boss", displayName: "老板", role: "admin" }, factory: { id: 10 } };
    if (token === "TEST_mgr") return { user: { id: 8, username: "mgr", displayName: "经理", role: "manager" }, factory: { id: 10 } };
    if (token === "TEST_staff") return { user: { id: 9, username: "staff", displayName: "员工", role: "member" }, factory: { id: 10 } };
    if (token === "TEST_other") return { user: { id: 99, username: "other", displayName: "外人", role: "admin" }, factory: { id: 20 } };
    throw new TRPCError({ code: "UNAUTHORIZED", message: "token 无效或已过期" });
  },
  normalizeRole: (role: string) => (role === "admin" || role === "owner" ? "admin" : role === "manager" ? "manager" : "staff"),
}));

const agentTaskMock = vi.fn();
vi.mock("./routers/agentBridge", () => ({
  runWorkbenchAgentTask: (...args: unknown[]) => agentTaskMock(...args),
}));

// ─── 状态ful 假 DB ───────────────────────────────────────────────────────────
interface RoomFake {
  id: number;
  factoryId: number;
  roomId: string;
  title: string;
  createdBy: number;
  agentCodes: string;
  status: string;
  createdAt: Date;
  closedAt: Date | null;
}
interface MsgFake {
  id: number;
  roomId: number;
  factoryId: number;
  userId: number | null;
  agentCode: string | null;
  kind: string;
  text: string;
  createdAt: Date;
}

let rooms: RoomFake[];
let msgs: MsgFake[];
let roomSeq: number;
let msgSeq: number;

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
/** 参数按占位顺序提取：非 StringChunk 的 chunk —— 有 value 字段取其值，否则 chunk 本身即值（Number/String 包装） */
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
      if (/INSERT INTO st_voice_rooms/.test(t)) {
        const id = roomSeq++;
        rooms.push({
          id,
          factoryId: Number(p[0]),
          roomId: "",
          title: String(p[1]),
          createdBy: Number(p[2]),
          agentCodes: String(p[3]),
          status: "open",
          createdAt: new Date(),
          closedAt: null,
        });
        return [{ insertId: id, affectedRows: 1 }];
      }
      if (/UPDATE st_voice_rooms SET roomId/.test(t)) {
        const room = rooms.find((r) => r.id === Number(p[1]));
        if (room) room.roomId = String(p[0]);
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE st_voice_rooms SET status = 'closed'/.test(t)) {
        const room = rooms.find((r) => r.id === Number(p[0]));
        if (room) {
          room.status = "closed";
          room.closedAt = new Date();
        }
        return [{ affectedRows: room ? 1 : 0 }];
      }
      if (/INSERT INTO st_voice_room_msgs/.test(t)) {
        const id = msgSeq++;
        msgs.push({
          id,
          roomId: Number(p[0]),
          factoryId: Number(p[1]),
          userId: p[2] == null ? null : Number(p[2]),
          agentCode: p[3] == null ? null : String(p[3]),
          kind: String(p[4]),
          text: String(p[5]),
          createdAt: new Date(),
        });
        return [{ insertId: id, affectedRows: 1 }];
      }
      if (/COUNT\(\*\) AS c FROM st_voice_room_msgs/.test(t)) {
        const c = msgs.filter((m) => m.roomId === Number(p[0]) && m.kind === "agent").length;
        return [[{ c }]];
      }
      return [[]];
    },
  }),
}));

vi.mock("./routers/terminal", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/terminal")>();
  return {
    ...orig,
    findAgentByCode: async (code: string) =>
      code === "ajun"
        ? { id: 1, deptCode: "prod", code: "ajun", name: "阿骏", title: "生产部长", avatarEmoji: "🏭", systemPrompt: "", status: "active" }
        : code === "xiaofa"
          ? { id: 2, deptCode: "legal", code: "xiaofa", name: "小法", title: "法务专员", avatarEmoji: "⚖️", systemPrompt: "", status: "active" }
          : null,
    stQuery: async (q: unknown) => {
      const t = sqlTextOf(q);
      const p = sqlParamsOf(q);
      if (/FROM st_voice_rooms WHERE id/.test(t)) {
        const room = rooms.find((r) => r.id === Number(p[0]) && r.factoryId === Number(p[1]));
        return room ? [{ ...room }] : [];
      }
      if (/FROM st_voice_rooms r LEFT JOIN wb_users/.test(t)) {
        return rooms
          .filter((r) => r.factoryId === 10)
          .map((r) => ({ ...r, creatorName: r.createdBy === 7 ? "老板" : "经理" }));
      }
      if (/FROM st_voice_room_msgs m/.test(t)) {
        const afterId = Number(p[2]);
        const limit = Number(p[3]) || 100;
        return msgs
          .filter((m) => m.roomId === Number(p[0]) && m.factoryId === Number(p[1]) && m.id > afterId)
          .sort((a, b) => a.id - b.id)
          .slice(0, limit)
          .map((m) => ({ ...m, speakerName: m.userId === 7 ? "老板" : m.userId === 8 ? "经理" : m.userId === 9 ? "员工" : "" }));
      }
      if (/COUNT\(\*\) AS c FROM st_voice_room_msgs/.test(t)) {
        const c = msgs.filter((m) => m.roomId === Number(p[0]) && m.kind === "agent").length;
        return [{ c }];
      }
      return [];
    },
    rawRows: (r: unknown) => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as Record<string, unknown>[],
  };
});

import { wbRoomsRouter } from "./routers/wbRooms";

const caller = wbRoomsRouter.createCaller({} as never);

beforeEach(() => {
  rooms = [];
  msgs = [];
  roomSeq = 1;
  msgSeq = 1;
  agentTaskMock.mockReset();
  agentTaskMock.mockResolvedValue({
    ok: true,
    agentCode: "ajun",
    agentName: "阿骏",
    agentTitle: "生产部长",
    reply: "排产已按交付优先级重排，周三前完成 A 线换型。",
    artifacts: [],
    usedSkills: [],
    degraded: false,
  });
});

describe("M30 班组语音房", () => {
  it("create：admin 开房成功（系统消息落流），staff 被拒，不在役智能体点名拒绝", async () => {
    const r = await caller.create({ token: "TEST_admin", title: "生产排产会", agentCodes: ["ajun", "xiaofa"] });
    expect(r.ok).toBe(true);
    expect(r.roomId).toBe("room_1");
    expect(r.agents.map((a) => a.name)).toEqual(["阿骏", "小法"]);
    expect(msgs.some((m) => m.kind === "system" && m.text.includes("阿骏、小法"))).toBe(true);

    await expect(caller.create({ token: "TEST_staff", title: "员工私自开房", agentCodes: [] })).rejects.toThrow(/负责人或管理员/);
    await expect(caller.create({ token: "TEST_admin", title: "幽灵席位", agentCodes: ["ghost"] })).rejects.toThrow(/不存在或未启用/);
  });

  it("join：本企业进房取 TRTC 凭据+房流快照；他企业 NOT_FOUND", async () => {
    const c = await caller.create({ token: "TEST_admin", title: "晨会", agentCodes: ["ajun"] });
    const j = await caller.join({ token: "TEST_staff", id: c.id });
    expect(j.ok).toBe(true);
    expect(j.trtcUserId).toBe("9");
    expect(typeof j.userSig).toBe("string");
    expect(j.sdkAppId).toBeGreaterThan(0);
    expect(j.agents[0]?.name).toBe("阿骏");
    expect(j.messages.length).toBeGreaterThan(0); // 系统创建消息在快照内

    await expect(caller.join({ token: "TEST_other", id: c.id })).rejects.toThrow(/不存在/);
  });

  it("say+mention：人话落流，同席智能体经 agentBridge 应答落 kind=agent 流；非同席拒绝", async () => {
    const c = await caller.create({ token: "TEST_admin", title: "排产会", agentCodes: ["ajun"] });
    const r = await caller.say({ token: "TEST_mgr", id: c.id, text: "阿骏，把本周排产重排一下", mention: "ajun" });
    expect(r.ok).toBe(true);
    expect(r.agentReply).not.toBeNull();
    expect(r.agentReply!.agentName).toBe("阿骏");
    // agentBridge 收到的任务带房间语境与说话人
    const task = String(agentTaskMock.mock.calls[0][0].task);
    expect(task).toContain("排产会");
    expect(task).toContain("经理");
    // 房流：user 一句 + agent 一句
    const flow = msgs.filter((m) => m.roomId === c.id);
    expect(flow.some((m) => m.kind === "user" && m.userId === 8)).toBe(true);
    expect(flow.some((m) => m.kind === "agent" && m.agentCode === "ajun" && m.text.includes("周三前完成"))).toBe(true);

    await expect(
      caller.say({ token: "TEST_mgr", id: c.id, text: "小法你在吗", mention: "xiaofa" }),
    ).rejects.toThrow(/不在本房席位/);
  });

  it("agentSpeak 限频：同房 12 次 agent 应答后第 13 次 TOO_MANY_REQUESTS", async () => {
    const c = await caller.create({ token: "TEST_admin", title: "马拉松会", agentCodes: ["ajun"] });
    for (let i = 0; i < 12; i++) {
      await caller.say({ token: "TEST_admin", id: c.id, text: `第${i + 1}问`, mention: "ajun" });
    }
    await expect(
      caller.say({ token: "TEST_admin", id: c.id, text: "第13问", mention: "ajun" }),
    ).rejects.toThrow(/太密/);
  });

  it("messages：afterId 增量拉流；close：房主可关且幂等，第三人拒", async () => {
    const c = await caller.create({ token: "TEST_admin", title: "收尾会", agentCodes: [] });
    await caller.say({ token: "TEST_staff", id: c.id, text: "第一句" });
    const m1 = await caller.messages({ token: "TEST_staff", id: c.id, afterId: 0 });
    const last = m1.messages[m1.messages.length - 1]!;
    await caller.say({ token: "TEST_staff", id: c.id, text: "第二句" });
    const m2 = await caller.messages({ token: "TEST_staff", id: c.id, afterId: last.id });
    expect(m2.messages).toHaveLength(1);
    expect(m2.messages[0]!.text).toBe("第二句");

    await expect(caller.close({ token: "TEST_staff", id: c.id })).rejects.toThrow(/房主或管理员/);
    const cl = await caller.close({ token: "TEST_admin", id: c.id });
    expect(cl.ok).toBe(true);
    expect((await caller.close({ token: "TEST_admin", id: c.id })).already).toBe(true);
    await expect(caller.join({ token: "TEST_staff", id: c.id })).rejects.toThrow(/已关闭/);
  });
});
