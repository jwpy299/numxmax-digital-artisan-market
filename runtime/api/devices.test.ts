/**
 * M12 设备直达验收单测：
 * 1. deviceEnroll：签发设备 + enrollKey（明文仅此一次；库只存 sha256，绝不落明文）；
 * 2. heartbeat：enrollKey 错误 → UNAUTHORIZED；正确 → status=online + last_seen_at 更新；
 * 3. issueCommand/claimCommands：B 级 print 直接排队 → 原子认领（二次认领为空，防断线重认重复执行）；
 * 4. reportResult：done 回报 → 状态落库 + st_auto_signals 信号记录；
 * 5. 白名单：白名单外 cap 拒绝；设备未声明 cap 拒绝；
 * 6. C 级 cap：无 ticket 拒绝；有效 ticket 放行；回执核销票据（一次性，重用被拒）。
 * mock 模式同 snapshots.test.ts：mock getDb + SQL 文本路由到内存夹具；测试数据 TEST_ 前缀。
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

vi.mock("./routers/modelGateway", () => ({
  callSlotChat: vi.fn(async () => ({ ok: true, content: "TEST_LLM" })),
  callModelChat: vi.fn(async () => ({ ok: true, content: "TEST_LLM" })),
}));

vi.mock("./routers/wbSession", () => ({
  sessionMe: async (token: string) => {
    if (token !== "TEST_wb") throw new TRPCError({ code: "UNAUTHORIZED", message: "会话无效" });
    return { user: { username: "TEST_boss", role: "owner" }, factory: { id: 10 } };
  },
}));

vi.mock("./routers/terminal", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/terminal")>();
  return {
    ...orig,
    requireAdmin: async (token: string) => {
      if (token !== "TEST_admin") throw new TRPCError({ code: "UNAUTHORIZED", message: "需要管理员权限" });
      return { id: 1, username: "TEST_admin", role: "admin" };
    },
  };
});

// ─── 状态ful 假 DB：内存表模拟 st_devices / st_device_commands / st_gate_tickets ──

interface DeviceRow {
  id: number;
  factory_id: number;
  name: string;
  dtype: string;
  caps: string;
  enroll_key_hash: string;
  status: string;
  last_seen_at: string | null;
}
interface CommandRow {
  id: number;
  device_id: number;
  factory_id: number;
  cap: string;
  payload: string;
  status: string;
  ticket_id: number | null;
  client_key: string | null;
  result: string | null;
  claimed_at: string | null;
  done_at: string | null;
}
interface TicketRow {
  id: number;
  factory_id: number;
  used_at: string | null;
  expires_at: string;
}

let devices: DeviceRow[];
let commands: CommandRow[];
let tickets: TicketRow[];
let signals: Array<{ factory_id: number; source: string; level: string; title: string; detail: string | null }>;
let lastInsertId: number;

function resetTables() {
  devices = [];
  commands = [];
  tickets = [];
  signals = [];
  lastInsertId = 0;
}

function route(text: string, params: unknown[]): unknown {
  // ── st_devices ──
  if (text.includes("INSERT INTO st_devices")) {
    const [factoryId, name, dtype, caps, hash] = params as [number, string, string, string, string];
    const id = devices.length + 1;
    devices.push({
      id,
      factory_id: Number(factoryId),
      name,
      dtype,
      caps,
      enroll_key_hash: String(hash),
      status: "offline",
      last_seen_at: null,
    });
    lastInsertId = id;
    return [[]];
  }
  if (text.includes("FROM st_devices") && text.includes("enroll_key_hash")) {
    const [id, hash] = params as [number, string];
    const d = devices.find((x) => x.id === Number(id) && x.enroll_key_hash === String(hash));
    return [d ? [{ id: d.id }] : []];
  }
  if (text.includes("FROM st_devices") && text.includes("lastSeenAt")) {
    const fid = Number(params[0]);
    return [
      devices
        .filter((d) => d.factory_id === fid)
        .map((d) => ({
          id: d.id,
          name: d.name,
          dtype: d.dtype,
          caps: d.caps,
          status: d.status,
          lastSeenAt: d.last_seen_at,
          createdAt: "2026-01-01 00:00:00",
        })),
    ];
  }
  if (text.includes("FROM st_devices")) {
    const d = devices.find((x) => x.id === Number(params[0]));
    return [
      d
        ? [{ id: d.id, factoryId: d.factory_id, name: d.name, dtype: d.dtype, caps: d.caps, status: d.status }]
        : [],
    ];
  }
  if (text.includes("UPDATE st_devices")) {
    const id = Number(params[params.length - 1]);
    const d = devices.find((x) => x.id === id);
    if (!d) return [{ affectedRows: 0 }];
    if (text.includes("last_seen_at")) {
      d.last_seen_at = new Date().toISOString();
      d.status = "online";
    } else if (text.includes("'disabled'")) {
      d.status = "disabled";
    } else if (text.includes("SET name")) {
      d.name = String(params[0]);
    }
    return [{ affectedRows: 1 }];
  }
  // ── st_device_commands ──
  if (text.includes("INSERT INTO st_device_commands")) {
    const [deviceId, factoryId, cap, payload, ticketId, clientKey] = params as [
      number,
      number,
      string,
      string,
      number | null,
      string | null,
    ];
    const ck = clientKey == null ? null : String(clientKey);
    // 模拟 (device_id, client_key) 唯一索引：撞键抛 ER_DUP_ENTRY（mysql2 行为）
    if (ck && commands.some((c) => c.device_id === Number(deviceId) && c.client_key === ck)) {
      const err = new Error("Duplicate entry for key 'uniq_device_client'") as Error & { code?: string };
      err.code = "ER_DUP_ENTRY";
      throw err;
    }
    const id = commands.length + 1;
    commands.push({
      id,
      device_id: Number(deviceId),
      factory_id: Number(factoryId),
      cap: String(cap),
      payload: String(payload),
      status: "pending",
      ticket_id: ticketId == null ? null : Number(ticketId),
      client_key: ck,
      result: null,
      claimed_at: null,
      done_at: null,
    });
    lastInsertId = id;
    return [[]];
  }
  if (text.includes("FROM st_device_commands") && text.includes("client_key")) {
    // 幂等去重查询 / gate undo 定位：按 (device_id, client_key) 或 (factory_id, client_key, pending)
    const first = Number(params[0]);
    const ck = String(params[1]);
    let rows = commands.filter((c) => c.client_key === ck);
    if (text.includes("device_id")) rows = rows.filter((c) => c.device_id === first);
    if (text.includes("factory_id")) rows = rows.filter((c) => c.factory_id === first);
    if (text.includes("'pending'")) rows = rows.filter((c) => c.status === "pending");
    return [rows.map((c) => ({ id: c.id }))];
  }
  if (text.includes("UPDATE st_device_commands") && text.includes("'cancelled'")) {
    // undo：仅 pending → cancelled
    const id = Number(params[0]);
    const c = commands.find((x) => x.id === id && x.status === "pending");
    if (!c) return [{ affectedRows: 0 }];
    c.status = "cancelled";
    return [{ affectedRows: 1 }];
  }
  if (text.includes("FROM st_device_commands") && text.includes("status = 'pending'")) {
    // claimCommands：params = [deviceId, factoryId, ...caps, limit]
    const deviceId = Number(params[0]);
    const factoryId = Number(params[1]);
    const caps = params.slice(2, -1).map(String);
    const limit = Number(params[params.length - 1]);
    const rows = commands
      .filter(
        (c) =>
          c.device_id === deviceId && c.factory_id === factoryId && c.status === "pending" && caps.includes(c.cap),
      )
      .slice(0, limit);
    return [rows.map((c) => ({ id: c.id, cap: c.cap, payload: c.payload, ticketId: c.ticket_id, createdAt: "2026-01-01" }))];
  }
  if (text.includes("UPDATE st_device_commands") && text.includes("'claimed'") && !text.includes("result")) {
    // 原子认领：仅 pending → claimed；并发败方 affectedRows=0（认领成功的唯一判据）
    const id = Number(params[0]);
    const c = commands.find((x) => x.id === id && x.status === "pending");
    if (!c) return [{ affectedRows: 0 }];
    c.status = "claimed";
    c.claimed_at = new Date().toISOString();
    return [{ affectedRows: 1 }];
  }
  if (text.includes("UPDATE st_device_commands") && text.includes("result")) {
    // 回报：仅 claimed → done/failed
    const [status, result, id] = params as [string, string | null, number];
    const c = commands.find((x) => x.id === Number(id) && x.status === "claimed");
    if (!c) return [{ affectedRows: 0 }];
    c.status = String(status);
    c.result = result == null ? null : String(result);
    c.done_at = new Date().toISOString();
    return [{ affectedRows: 1 }];
  }
  if (text.includes("FROM st_device_commands") && text.includes("device_id")) {
    const c = commands.find((x) => x.id === Number(params[0]) && x.device_id === Number(params[1]));
    return [c ? [{ id: c.id, cap: c.cap, status: c.status, ticketId: c.ticket_id }] : []];
  }
  if (text.includes("FROM st_device_commands")) {
    const c = commands.find((x) => x.id === Number(params[0]) && x.status === "claimed");
    return [c ? [{ status: c.status }] : []];
  }
  // ── st_gate_tickets ──
  if (text.includes("UPDATE st_gate_tickets")) {
    const t = tickets.find((x) => x.id === Number(params[0]) && x.used_at === null);
    if (!t) return [{ affectedRows: 0 }];
    t.used_at = new Date().toISOString();
    return [{ affectedRows: 1 }];
  }
  if (text.includes("FROM st_gate_tickets")) {
    const t = tickets.find((x) => x.id === Number(params[0]) && x.factory_id === Number(params[1]));
    return [t ? [{ id: t.id, usedAt: t.used_at, expiresAt: t.expires_at }] : []];
  }
  // ── st_auto_signals ──
  if (text.includes("INSERT INTO st_auto_signals")) {
    const [factoryId, source, level, title, detail] = params as [number, string, string, string, string | null];
    signals.push({ factory_id: Number(factoryId), source, level, title, detail });
    return [[]];
  }
  if (text.includes("LAST_INSERT_ID")) return [[{ id: lastInsertId }]];
  return [[]];
}

vi.mock("./queries/connection", async () => {
  const { MySqlDialect } = await import("drizzle-orm/mysql-core");
  const dialect = new MySqlDialect();
  return {
    getDb: () => {
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [],
            }),
          }),
        }),
        execute: async (stmt: unknown) => {
          const q = dialect.sqlToQuery(stmt as never);
          return route(q.sql, q.params);
        },
      };
      // R7-c143-②：事务 shim——tx 共享同一路由（内存仓等价同连接语义）
      return { ...db, transaction: async (fn: (tx: typeof db) => Promise<unknown>) => fn(db) };
    },
  };
});

import { devicesRouter, CAPS_WHITELIST } from "./routers/devices";
import { EXECUTORS, type ExecCtx } from "./routers/gate";

const caller = devicesRouter.createCaller({} as never);

/** 签发一台 TEST 设备并返回明文 enrollKey（仅测试内使用） */
async function enrollDevice(caps: string[] = ["print", "screenshot", "lock"]) {
  const r = await caller.deviceEnroll({
    token: "TEST_admin",
    factoryId: 10,
    name: "TEST_打印机-01",
    dtype: "printer",
    caps: caps as ("print" | "lock" | "screenshot" | "run_script")[],
  });
  return r;
}

beforeEach(resetTables);

describe("deviceEnroll 签发", () => {
  it("签发成功：返回明文 enrollKey 一次；库只存 sha256，不落明文", async () => {
    const r = await enrollDevice();
    expect(r.ok).toBe(true);
    expect(r.deviceId).toBeGreaterThan(0);
    expect(r.enrollKey).toMatch(/^ek_[0-9a-f]{48}$/);
    const row = devices[0];
    expect(row.enroll_key_hash).toBe(sha256(r.enrollKey));
    expect(row.enroll_key_hash).not.toContain(r.enrollKey);
    expect(JSON.stringify(devices)).not.toContain(r.enrollKey);
    expect(JSON.parse(row.caps)).toEqual(["print", "screenshot", "lock"]);
  });

  it("非管理员 token → UNAUTHORIZED", async () => {
    await expect(
      caller.deviceEnroll({ token: "TEST_bad", factoryId: 10, name: "TEST_x", caps: ["print"] }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("白名单常量即全集：无任何破坏性动作（M41 增 plugin_invoke——边缘插件调用，直发 C 级双签）", () => {
    expect([...CAPS_WHITELIST].sort()).toEqual(["lock", "plugin_invoke", "print", "run_script", "screenshot"]);
  });
});

describe("heartbeat 心跳", () => {
  it("enrollKey 正确 → status=online + last_seen_at 更新", async () => {
    const { deviceId, enrollKey } = await enrollDevice();
    const r = await caller.heartbeat({ deviceId, enrollKey });
    expect(r).toMatchObject({ ok: true, status: "online" });
    expect(devices[0].status).toBe("online");
    expect(devices[0].last_seen_at).not.toBeNull();
  });

  it("enrollKey 错误 → UNAUTHORIZED", async () => {
    const { deviceId } = await enrollDevice();
    await expect(
      caller.heartbeat({ deviceId, enrollKey: "ek_000000000000000000000000000000000000000000000000" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("B 级命令：下发 → 认领 → 回报", () => {
  it("print 直接排队；原子认领一次；二次认领为空", async () => {
    const { deviceId, enrollKey } = await enrollDevice();
    const issue = await caller.issueCommand({
      token: "TEST_wb",
      deviceId,
      cap: "print",
      payload: { file: "TEST_测试页.pdf" },
    });
    expect(issue).toMatchObject({ ok: true, status: "pending", level: "B" });

    const claim1 = await caller.claimCommands({ deviceId, enrollKey });
    expect(claim1.commands).toHaveLength(1);
    expect(claim1.commands[0]).toMatchObject({ id: issue.commandId, cap: "print" });
    expect(commands[0].status).toBe("claimed");

    // 断线重认/重复轮询：不再返回已认领命令（不重复执行）
    const claim2 = await caller.claimCommands({ deviceId, enrollKey });
    expect(claim2.commands).toHaveLength(0);
  });

  it("并发认领：两个 agent 同时轮询同一 pending 命令，仅一方拿到（affectedRows 唯一判据）", async () => {
    const { deviceId, enrollKey } = await enrollDevice();
    await caller.issueCommand({ token: "TEST_wb", deviceId, cap: "print", payload: {} });
    // 双方都会先 SELECT 到同一条 pending；原子 UPDATE 只允许一方 affectedRows=1
    const [a, b] = await Promise.all([
      caller.claimCommands({ deviceId, enrollKey }),
      caller.claimCommands({ deviceId, enrollKey }),
    ]);
    const total = a.commands.length + b.commands.length;
    expect(total).toBe(1);
    expect(commands[0].status).toBe("claimed");
  });

  it("reportResult done → 状态落库 + st_auto_signals 信号记录", async () => {
    const { deviceId, enrollKey } = await enrollDevice();
    const issue = await caller.issueCommand({ token: "TEST_wb", deviceId, cap: "print", payload: {} });
    await caller.claimCommands({ deviceId, enrollKey });
    const r = await caller.reportResult({
      deviceId,
      enrollKey,
      commandId: issue.commandId,
      status: "done",
      result: "TEST_lp: request id is 1",
    });
    expect(r).toMatchObject({ ok: true, status: "done" });
    expect(commands[0].status).toBe("done");
    expect(commands[0].done_at).not.toBeNull();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ factory_id: 10, level: "B" });
    expect(signals[0].title).toContain("TEST_打印机-01");
  });

  it("未认领的命令不可回报（pending → report 拒绝）", async () => {
    const { deviceId, enrollKey } = await enrollDevice();
    const issue = await caller.issueCommand({ token: "TEST_wb", deviceId, cap: "print", payload: {} });
    await expect(
      caller.reportResult({ deviceId, enrollKey, commandId: issue.commandId, status: "done" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("他厂 token 下发 → 拦截（设备不属本厂）", async () => {
    const { deviceId } = await enrollDevice();
    devices[0].factory_id = 99; // 设备挂到别厂
    await expect(
      caller.issueCommand({ token: "TEST_wb", deviceId, cap: "print", payload: {} }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("能力白名单", () => {
  it("白名单外 cap（如 shutdown）→ BAD_REQUEST", async () => {
    const { deviceId } = await enrollDevice();
    await expect(
      caller.issueCommand({ token: "TEST_wb", deviceId, cap: "shutdown", payload: {} }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("设备未声明的 cap → FORBIDDEN（本机声明，中枢复核）", async () => {
    const { deviceId } = await enrollDevice(["print"]); // 未声明 run_script
    await expect(
      caller.issueCommand({ token: "TEST_wb", deviceId, cap: "run_script", payload: {}, ticketId: 1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("管理端 rename/disable", () => {
  it("rename：改名成功；不存在设备 → NOT_FOUND", async () => {
    const { deviceId } = await enrollDevice();
    const r = await caller.rename({ token: "TEST_admin", deviceId, name: "TEST_新名字" });
    expect(r.ok).toBe(true);
    expect(devices[0].name).toBe("TEST_新名字");
    await expect(caller.rename({ token: "TEST_admin", deviceId: 999, name: "TEST_x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("disable：禁用后 claimCommands/heartbeat 拒绝", async () => {
    const { deviceId, enrollKey } = await enrollDevice();
    await caller.issueCommand({ token: "TEST_wb", deviceId, cap: "print", payload: {} });
    const r = await caller.disable({ token: "TEST_admin", deviceId });
    expect(r).toMatchObject({ ok: true, status: "disabled" });
    expect(devices[0].status).toBe("disabled");
    await expect(caller.claimCommands({ deviceId, enrollKey })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.heartbeat({ deviceId, enrollKey })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("C 级命令：票据门槛", () => {
  it("lock 无 ticket → FORBIDDEN（C 级绝不自动执行）", async () => {
    const { deviceId } = await enrollDevice();
    await expect(
      caller.issueCommand({ token: "TEST_wb", deviceId, cap: "lock", payload: {} }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(commands).toHaveLength(0);
  });

  it("有效 ticket → 排队成功；回执后票据核销（一次性）", async () => {
    const { deviceId, enrollKey } = await enrollDevice();
    tickets.push({ id: 7, factory_id: 10, used_at: null, expires_at: new Date(Date.now() + 60_000).toISOString() });
    const issue = await caller.issueCommand({ token: "TEST_wb", deviceId, cap: "lock", payload: {}, ticketId: 7 });
    expect(issue).toMatchObject({ ok: true, level: "C" });
    expect(commands[0].ticket_id).toBe(7);

    await caller.claimCommands({ deviceId, enrollKey });
    await caller.reportResult({ deviceId, enrollKey, commandId: issue.commandId, status: "done", result: "TEST_locked" });
    expect(tickets[0].used_at).not.toBeNull(); // 回执核销

    // 同一票据重用 → 拒绝
    await expect(
      caller.issueCommand({ token: "TEST_wb", deviceId, cap: "lock", payload: {}, ticketId: 7 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("过期 ticket → 拒绝", async () => {
    const { deviceId } = await enrollDevice();
    tickets.push({ id: 8, factory_id: 10, used_at: null, expires_at: new Date(Date.now() - 1000).toISOString() });
    await expect(
      caller.issueCommand({ token: "TEST_wb", deviceId, cap: "lock", payload: {}, ticketId: 8 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ─── LOW-3：命令幂等键（clientKey）────────────────────────────────────────────

describe("命令幂等键（LOW-3）", () => {
  it("同 clientKey 二次提交 → deduped 返回已有命令，不重复入队", async () => {
    const { deviceId } = await enrollDevice();
    const r1 = await caller.issueCommand({
      token: "TEST_wb",
      deviceId,
      cap: "print",
      payload: { file: "TEST_a.pdf" },
      clientKey: "TEST_ck-1",
    });
    expect(r1.deduped).toBe(false);
    const r2 = await caller.issueCommand({
      token: "TEST_wb",
      deviceId,
      cap: "print",
      payload: { file: "TEST_a.pdf" },
      clientKey: "TEST_ck-1",
    });
    expect(r2).toMatchObject({ deduped: true, commandId: r1.commandId });
    expect(commands).toHaveLength(1);
  });

  it("不同 clientKey / 无 clientKey → 正常各自入队", async () => {
    const { deviceId } = await enrollDevice();
    await caller.issueCommand({ token: "TEST_wb", deviceId, cap: "print", payload: {}, clientKey: "TEST_ck-a" });
    await caller.issueCommand({ token: "TEST_wb", deviceId, cap: "print", payload: {}, clientKey: "TEST_ck-b" });
    await caller.issueCommand({ token: "TEST_wb", deviceId, cap: "print", payload: {} });
    await caller.issueCommand({ token: "TEST_wb", deviceId, cap: "print", payload: {} });
    expect(commands).toHaveLength(4);
  });
});

// ─── LOW-2：gate sandbox_dispatch 执行器 device:<id> 路由 ──────────────────────

/** 构造执行器 ctx（闸口双签已过、票据已核销后的执行阶段视角） */
function gateCtx(payload: Record<string, unknown>, intentId = 42, ticketId = 7): ExecCtx {
  return {
    factoryId: 10,
    actor: { username: "TEST_boss", role: "owner", factoryId: 10 },
    payload,
    intentId,
    ticketId,
  };
}

describe("gate 执行器 device 路由（LOW-2）", () => {
  it("memberKey=device:<id> → 入队 st_device_commands（pending，ticket 溯源，client_key=gate:<intentId>）", async () => {
    const { deviceId } = await enrollDevice();
    const ex = EXECUTORS.sandbox_dispatch;
    const prepared = await ex.prepare(gateCtx({ memberKey: `device:${deviceId}`, cap: "print", instruction: "TEST_打印" }));
    const r = (await ex.execute(gateCtx({ memberKey: `device:${deviceId}`, cap: "print", instruction: "TEST_打印" }), prepared)) as Record<string, unknown>;
    expect(r).toMatchObject({ queued: true, deviceId, deduped: false });
    expect(r.commandId).toBeGreaterThan(0);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      device_id: deviceId,
      factory_id: 10,
      cap: "print",
      status: "pending",
      ticket_id: 7,
      client_key: "gate:42",
    });
    // 控制面字段不落设备指令
    expect(commands[0].payload).not.toContain("memberKey");
    expect(commands[0].payload).toContain("TEST_打印");
  });

  it("memberKey 非 device: 前缀 → prepare 返回 null（走数字员工路径，不在本测试范围）", async () => {
    const prepared = await EXECUTORS.sandbox_dispatch.prepare(gateCtx({ memberKey: "member:张三" }));
    expect(prepared).toBeNull();
  });

  it("设备不存在 → NOT_FOUND，拒绝入队", async () => {
    const ex = EXECUTORS.sandbox_dispatch;
    const ctx = gateCtx({ memberKey: "device:999", cap: "print" });
    const prepared = await ex.prepare(ctx);
    await expect(ex.execute(ctx, prepared)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(commands).toHaveLength(0);
  });

  it("他厂设备 → NOT_FOUND（越权拦截）", async () => {
    const { deviceId } = await enrollDevice();
    devices[0].factory_id = 99;
    const ex = EXECUTORS.sandbox_dispatch;
    const ctx = gateCtx({ memberKey: `device:${deviceId}`, cap: "print" });
    const prepared = await ex.prepare(ctx);
    await expect(ex.execute(ctx, prepared)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(commands).toHaveLength(0);
  });

  it("disabled 设备 → FORBIDDEN", async () => {
    const { deviceId } = await enrollDevice();
    await caller.disable({ token: "TEST_admin", deviceId });
    const ex = EXECUTORS.sandbox_dispatch;
    const ctx = gateCtx({ memberKey: `device:${deviceId}`, cap: "print" });
    const prepared = await ex.prepare(ctx);
    await expect(ex.execute(ctx, prepared)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("设备未声明 cap → FORBIDDEN（本机声明，中枢复核）", async () => {
    const { deviceId } = await enrollDevice(["print"]); // 未声明 run_script
    const ex = EXECUTORS.sandbox_dispatch;
    const ctx = gateCtx({ memberKey: `device:${deviceId}`, cap: "run_script", confirmed: true });
    const prepared = await ex.prepare(ctx);
    await expect(ex.execute(ctx, prepared)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("白名单外 cap → BAD_REQUEST（prepare 阶段即拒）", async () => {
    const { deviceId } = await enrollDevice();
    await expect(
      EXECUTORS.sandbox_dispatch.prepare(gateCtx({ memberKey: `device:${deviceId}`, cap: "shutdown" })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("C 级 cap（lock/run_script）无 confirmed=true → FORBIDDEN，不入队", async () => {
    const { deviceId } = await enrollDevice();
    await expect(
      EXECUTORS.sandbox_dispatch.prepare(gateCtx({ memberKey: `device:${deviceId}`, cap: "lock" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // confirmed=true → 放行（执行器跑到即已过闸双签，confirmed 为企业主两段式确认回执）
    const ex = EXECUTORS.sandbox_dispatch;
    const ctx = gateCtx({ memberKey: `device:${deviceId}`, cap: "lock", confirmed: true });
    const prepared = await ex.prepare(ctx);
    const r = (await ex.execute(ctx, prepared)) as Record<string, unknown>;
    expect(r).toMatchObject({ queued: true, deviceId });
    expect(commands[0].cap).toBe("lock");
  });

  it("undo：取消该意图入队的 pending 命令（仅 pending 可取消）", async () => {
    const { deviceId, enrollKey } = await enrollDevice();
    const ex = EXECUTORS.sandbox_dispatch;
    const ctx = gateCtx({ memberKey: `device:${deviceId}`, cap: "print" }, 55);
    const prepared = await ex.prepare(ctx);
    await ex.execute(ctx, prepared);
    expect(commands[0].status).toBe("pending");
    await ex.undo(ctx, prepared);
    expect(commands[0].status).toBe("cancelled");

    // 已 claimed 的命令 undo 不动（agent 已拿走，绝不撤回执行中的动作）
    const ctx2 = gateCtx({ memberKey: `device:${deviceId}`, cap: "print" }, 56);
    const prepared2 = await ex.prepare(ctx2);
    const r2 = (await ex.execute(ctx2, prepared2)) as { commandId: number };
    await caller.claimCommands({ deviceId, enrollKey });
    expect(commands.find((c) => c.id === r2.commandId)?.status).toBe("claimed");
    await ex.undo(ctx2, prepared2);
    expect(commands.find((c) => c.id === r2.commandId)?.status).toBe("claimed");
  });

  it("gate 路由幂等：同 intentId 重复入队只一条（client_key=gate:<intentId> 撞唯一索引 → deduped）", async () => {
    const { deviceId } = await enrollDevice();
    const ex = EXECUTORS.sandbox_dispatch;
    const ctx = gateCtx({ memberKey: `device:${deviceId}`, cap: "print" }, 77);
    const prepared = await ex.prepare(ctx);
    const r1 = (await ex.execute(ctx, prepared)) as Record<string, unknown>;
    const r2 = (await ex.execute(ctx, prepared)) as Record<string, unknown>;
    expect(r1.deduped).toBe(false);
    expect(r2).toMatchObject({ deduped: true, commandId: r1.commandId });
    expect(commands).toHaveLength(1);
  });
});
