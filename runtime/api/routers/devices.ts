/**
 * devices —— M12「设备直达」中枢侧路由。
 *
 * 链路：企业端/闸口 issueCommand 排队（st_device_commands pending）
 *      → Device Agent 长轮询 claimCommands（原子认领 → claimed）
 *      → 真机执行 → reportResult（done/failed + result，写信号 + SSE 播报）。
 *
 * 安全铁律：
 * - enrollKey 只在 deviceEnroll 签发时返回一次明文；库里只存 sha256；日志绝不打印明文。
 * - 能力白名单 CAPS_WHITELIST = print/lock/screenshot/run_script（V1 无任何破坏性动作）；
 *   白名单外一律拒绝，设备自报 caps 之外的下发也拒绝（本机声明，中枢复核）。
 * - cap 分级：B 级（print/screenshot）可直接排队；C 级（lock/run_script）必须带有效
 *   双签票据（st_gate_tickets：存在、属本厂、未过期、未使用），回执时中枢核销（一次性）。
 * - C 级动作绝不自动执行：issueCommand 只是排队，执行权在过闸票据与企业侧 agent。
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { stQuery, requireAdmin } from "./terminal";
import { parseDbUtc } from "./dbTime";
import { sessionMe } from "./wbSession";
import { emitSignal } from "./autoEngine";
import { publishBroadcast } from "./streamBus";
import { isDupEntry } from "../queries/dupEntry";
import { txInsertId } from "../queries/txInsertId"; // R7-c143-②/R7-c145-①：事务径单点叶同引（dup 透传在叶——撞键域内信号保真）
import { GATE_TABLES_HINT, DEVICE_TABLES_HINT } from "./tableHints"; // R7-c147-③/R7-c159-⑤/R7-c160-⑥：gate 族+设备族提示同引中立足单源（不冒他族名）
import { infraUnavailable500 } from "../auth/identity"; // R7-c146-④：撞键回读未命中掩码上行同引

// ─── 能力白名单（V1：无任何破坏性动作）─────────────────────────────────────

// R7-c159-⑤/R7-c160-⑥：DEVICE_TABLES_HINT 归 tableHints 中立足（提示常量族单源——本文件 import 同引）

/** 设备族查询兜底（R7-c147-② security low）：stQuery 带本族提示——设备表缺表不再指错 sync-terminal.mts
 *  （老部署 operator 被指向修不了问题的脚本=412 死不露面封死；读面/写径同一正确脚本名） */
const devQuery = (statement: ReturnType<typeof sql>) => stQuery(statement, DEVICE_TABLES_HINT);

export const CAPS_WHITELIST = ["print", "lock", "screenshot", "run_script", "plugin_invoke"] as const;
export type DeviceCap = (typeof CAPS_WHITELIST)[number];

/** cap → 风险分级：B 级可直接排队；C 级必须带有效双签票据 */
export const CAP_LEVEL: Record<DeviceCap, "B" | "C"> = {
  print: "B",
  screenshot: "B",
  lock: "C",
  run_script: "C",
  // M41 二期边缘网关：插件调用直通厂区 LAN（可触达生产设备），直接下发一律 C 级双签；
  // 设备插件路由层（devicePlugins）读数走 B 级语义由插件层自控，不经过 issueCommand。
  plugin_invoke: "C",
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ─── 行类型 ──────────────────────────────────────────────────────────────────

interface DeviceRow {
  id: number;
  factoryId: number;
  name: string;
  dtype: string;
  caps: string[];
  status: string;
}

function parseCaps(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw ?? "[]")) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

async function loadDevice(deviceId: number): Promise<DeviceRow | null> {
  const rows = await devQuery(
    sql`SELECT id, factory_id AS factoryId, name, dtype, caps, status
        FROM st_devices WHERE id = ${deviceId} LIMIT 1`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    factoryId: Number(r.factoryId),
    name: String(r.name),
    dtype: String(r.dtype),
    caps: parseCaps(r.caps),
    status: String(r.status),
  };
}

/**
 * agentAuth：设备身份认证（enrollKey → sha256 比对）。
 * 命中返回设备行；未命中/设备禁用一律 UNAUTHORIZED。enrollKey 明文只存在于内存瞬时，绝不落库/日志。
 */
export async function agentAuth(deviceId: number, enrollKey: string): Promise<DeviceRow> {
  const rows = await devQuery(
    sql`SELECT id FROM st_devices WHERE id = ${deviceId} AND enroll_key_hash = ${sha256(enrollKey)} LIMIT 1`,
  );
  if (!rows[0]) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "设备认证失败：deviceId 或 enrollKey 不匹配" });
  }
  const device = await loadDevice(deviceId);
  if (!device) throw new TRPCError({ code: "UNAUTHORIZED", message: "设备不存在" });
  if (device.status === "disabled") {
    throw new TRPCError({ code: "FORBIDDEN", message: "设备已被禁用" });
  }
  return device;
}

/** 票据校验（下发时）：存在、属本厂、未过期、未使用 → 放行；回执时 consumeTicket 核销 */
async function validateTicket(ticketId: number, factoryId: number): Promise<void> {
  const rows = await stQuery( // R7-c148-②：读 gate 族表不走设备族包装——GATE 提示归位（st_gate_tickets=sync-iter100 系）
    sql`SELECT id, used_at AS usedAt, expires_at AS expiresAt FROM st_gate_tickets
        WHERE id = ${ticketId} AND factory_id = ${factoryId} LIMIT 1`,
    GATE_TABLES_HINT,
  );
  const t = rows[0];
  if (!t) throw new TRPCError({ code: "FORBIDDEN", message: "票据不存在或不属本厂" });
  if (t.usedAt) throw new TRPCError({ code: "FORBIDDEN", message: "票据已使用（一次性）" });
  if (parseDbUtc(t.expiresAt) < Date.now()) {
    throw new TRPCError({ code: "FORBIDDEN", message: "票据已过期" });
  }
}

/** 票据核销（回执时，一次性；已核销则静默跳过） */
async function consumeTicket(ticketId: number): Promise<void> {
  await stQuery(sql`UPDATE st_gate_tickets SET used_at = NOW() WHERE id = ${ticketId} AND used_at IS NULL`, GATE_TABLES_HINT); // R7-c147-③：gate 族表提示归其族脚本（不冒设备族名——devQuery 系设备族单参包装，本句系 gate 族直走 stQuery）
}

// ─── 入队核心（issueCommand 与 gate 执行器 device 路由共用）────────────────────

export interface EnqueueResult {
  commandId: number;
  deduped: boolean;
}

/**
 * 设备命令入队（中枢复核全链路）：
 * 设备存在、属本厂、未 disabled、声明了对应 cap（白名单内）→ INSERT pending。
 * 幂等：带 clientKey 时撞 (device_id, client_key) 唯一索引 → 返回已有命令（deduped），不报错。
 * 注意：本函数不做票据校验——企业端直发由 issueCommand 验票；闸口路由的票据已核销，仅作溯源记录。
 */
export async function enqueueDeviceCommand(opts: {
  factoryId: number;
  deviceId: number;
  cap: string;
  payload: Record<string, unknown>;
  ticketId?: number | null;
  clientKey?: string | null;
}): Promise<EnqueueResult> {
  if (!(CAPS_WHITELIST as readonly string[]).includes(opts.cap)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `未知能力 ${opts.cap}：不在设备能力白名单内` });
  }
  const cap = opts.cap as DeviceCap;
  const device = await loadDevice(opts.deviceId);
  if (!device || device.factoryId !== opts.factoryId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "设备不存在或不属本厂" });
  }
  if (device.status === "disabled") {
    throw new TRPCError({ code: "FORBIDDEN", message: "设备已被禁用，拒绝下发" });
  }
  if (!device.caps.includes(cap)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `设备 ${device.name} 未声明能力 ${cap}（本机声明，中枢复核不通过）`,
    });
  }
  const clientKey = opts.clientKey == null ? null : opts.clientKey.slice(0, 64);
  let commandId: number; // R7-c146-②：不初始 0（0 像合法默认命令 id=控制流回归静默面封死——catch 恒 throw/return，编译器强制赋值）
  try {
    // R7-c141-③ 连带修：撞键信号系域内语义（幂等键判别要原始 cause 链）——本写径直读不经 stQuery 掩码
    //  （掩码会把 ER_DUP_ENTRY 裹成 500=幂等撞键判别死面）；dup 判别+既有命令回读成立即返，其余故障走政策点掩码上行
    // R7-c143-② bug high：写+读同事务（同连接）——LAST_INSERT_ID() 连接域竞态封死（池化另查可落他连接拿错 id）；
    //  事务径不改语句文本形态（mock 面零扰动——RSH 直读径已回摆）；tx 抛错带原始 cause 链外出（dup 判别保真）
    commandId = await txInsertId(
      sql`INSERT INTO st_device_commands (device_id, factory_id, cap, payload, status, ticket_id, client_key)
          VALUES (${device.id}, ${opts.factoryId}, ${cap}, ${JSON.stringify(opts.payload).slice(0, 4000)},
                  'pending', ${opts.ticketId ?? null}, ${clientKey})`,
      "[routers/devices] 命令入队写入失败",
      DEVICE_TABLES_HINT,
      { dupPassthrough: true }, // R7-c155-⑨：本站自判撞键（幂等回读在下）——显式声明才收原链（泄密面默认不开）
    );
  } catch (e) {
    if (isDupEntry(e) && clientKey) { // 撞键域内信号（叶透传原链——幂等判别保真）
      const rows = await devQuery(
        sql`SELECT id FROM st_device_commands WHERE device_id = ${device.id} AND client_key = ${clientKey} LIMIT 1`,
      );
      if (rows[0]) return { commandId: Number(rows[0].id), deduped: true };
    }
    // R7-c146-④ security low：撞键但回读未命中（竞态/并发删）/clientKey 空——原始驱动错（内嵌 INSERT 全 SQL+payload/clientKey
    //  绑定参数）不裸抛（本仓无自定义 errorFormatter=逐字泄客户端面）——走政策点掩码上行
    if (isDupEntry(e)) infraUnavailable500("[routers/devices] 命令入队撞键回读未命中", e);
    throw e; // 叶政策点已裹（412/掩码 500=TRPCError 透传）——不重裹不重记（R7-c145-①：双记面封死）
  }
  return { commandId, deduped: false };
}

/** 取消 pending 命令（gate 执行器 device 路由的逆操作；仅 pending 可取消，已被认领则不动） */
export async function cancelPendingDeviceCommand(commandId: number, factoryId: number): Promise<boolean> {
  const upd = await devQuery(
    sql`UPDATE st_device_commands SET status = 'cancelled'
        WHERE id = ${commandId} AND factory_id = ${factoryId} AND status = 'pending'`,
  );
  return Number((upd[0] as { affectedRows?: number | string } | undefined)?.affectedRows ?? 0) === 1;
}

// ─── 路由 ────────────────────────────────────────────────────────────────────

const agentCredInput = {
  deviceId: z.number().int().positive(),
  enrollKey: z.string().trim().min(16).max(128),
};

export const devicesRouter = createRouter({
  /** devices.deviceEnroll（mutation, admin）：签发设备 + enrollKey（明文仅此返回一次；库只存 sha256） */
  deviceEnroll: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        factoryId: z.number().int().positive(),
        name: z.string().trim().min(1).max(128),
        dtype: z.string().trim().min(1).max(48).optional().default("workstation"),
        caps: z.array(z.enum(CAPS_WHITELIST)).min(1).max(CAPS_WHITELIST.length),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      // 中枢侧复核：注册声明的 caps 必须在白名单内（zod enum 已过滤，双保险）
      const caps = input.caps.filter((c) => (CAPS_WHITELIST as readonly string[]).includes(c));
      if (caps.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "caps 须在白名单内" });
      const enrollKey = `ek_${randomBytes(24).toString("hex")}`;
      // R7-c143-② 同类面：写+读同事务（同连接——LAST_INSERT_ID() 连接域竞态封死；语句文本形态不变=mock 面零扰动）；
      //  stQuery 412 语义让位本径自带缺表判（1146→412 同口径；余故障归 500 政策点）
      // R7-c147-⑥→R7-c148-④：撞键守卫摘除——st_devices 无唯一键（sync-devices.mts 只建 idx_factory/idx_status+PK，
      //  enroll_key_hash 无 UNIQUE）——dup 结构性不可达=死码面封死（注释不再谎称约束）；
      //  政策全在叶（1146→412/余→掩码 500）；若未来真给 enroll_key_hash 加唯一键=先评审幂等语义再加守卫
      const deviceId = await txInsertId(
        sql`INSERT INTO st_devices (factory_id, name, dtype, caps, enroll_key_hash, status)
            VALUES (${input.factoryId}, ${input.name}, ${input.dtype}, ${JSON.stringify(caps)},
                    ${sha256(enrollKey)}, 'offline')`,
        "[routers/devices] 设备注册写入失败",
        DEVICE_TABLES_HINT,
      );
      return {
        ok: true as const,
        deviceId,
        enrollKey, // 明文仅此一次返回，请立即写入设备侧 ~/.lingshu-agent.conf
        caps,
      };
    }),

  /** devices.heartbeat（mutation, agent）：30s 心跳，更新 last_seen_at/status=online */
  heartbeat: publicQuery.input(z.object(agentCredInput)).mutation(async ({ input }) => {
    const device = await agentAuth(input.deviceId, input.enrollKey);
    await devQuery(
      sql`UPDATE st_devices SET last_seen_at = NOW(), status = 'online' WHERE id = ${device.id}`,
    );
    return { ok: true as const, deviceId: device.id, status: "online" };
  }),

  /**
   * devices.claimCommands（mutation, agent）：长轮询认领。
   * 只发设备 caps 白名单内的 pending 命令；认领为原子 UPDATE（WHERE status='pending'），
   * 断线重认不重复执行。
   */
  claimCommands: publicQuery
    .input(z.object({ ...agentCredInput, limit: z.number().int().min(1).max(10).optional().default(5) }))
    .mutation(async ({ input }) => {
      const device = await agentAuth(input.deviceId, input.enrollKey);
      const allowed = device.caps.filter((c) => (CAPS_WHITELIST as readonly string[]).includes(c));
      if (allowed.length === 0) return { commands: [] as never[] };
      const rows = await devQuery(
        sql`SELECT id, cap, payload, ticket_id AS ticketId, created_at AS createdAt
            FROM st_device_commands
            WHERE device_id = ${device.id} AND factory_id = ${device.factoryId} AND status = 'pending'
              AND cap IN (${sql.join(allowed.map((c) => sql`${c}`), sql`, `)})
            ORDER BY id ASC LIMIT ${input.limit}`,
      );
      const claimed: Array<{ id: number; cap: string; payload: string | null; ticketId: number | null }> = [];
      for (const r of rows) {
        const id = Number(r.id);
        // 原子认领：仅当仍 pending 才置 claimed；认领成功的唯一判据是 UPDATE 的 affectedRows===1
        // （并发双 agent 轮询时，败方 affectedRows=0，绝不靠二次 SELECT 判定——否则会误中胜方置的 claimed）
        const upd = await devQuery(
          sql`UPDATE st_device_commands SET status = 'claimed', claimed_at = NOW()
              WHERE id = ${id} AND status = 'pending'`,
        );
        const affected = Number((upd[0] as { affectedRows?: number | string } | undefined)?.affectedRows ?? 0);
        if (affected === 1) {
          claimed.push({
            id,
            cap: String(r.cap),
            payload: r.payload == null ? null : String(r.payload),
            ticketId: r.ticketId == null ? null : Number(r.ticketId),
          });
        }
      }
      return { commands: claimed };
    }),

  /**
   * devices.reportResult（mutation, agent）：执行回报 done/failed + result。
   * 核销所携票据（一次性）；写 st_auto_signals 记录；publish 到 streamBus 让 SSE 订阅者可见。
   */
  reportResult: publicQuery
    .input(
      z.object({
        ...agentCredInput,
        commandId: z.number().int().positive(),
        status: z.enum(["done", "failed"]),
        result: z.string().trim().max(4000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const device = await agentAuth(input.deviceId, input.enrollKey);
      const rows = await devQuery(
        sql`SELECT id, cap, status, ticket_id AS ticketId FROM st_device_commands
            WHERE id = ${input.commandId} AND device_id = ${device.id} AND factory_id = ${device.factoryId} LIMIT 1`,
      );
      const cmd = rows[0];
      if (!cmd) throw new TRPCError({ code: "NOT_FOUND", message: `命令 #${input.commandId} 不存在或不属本设备` });
      if (String(cmd.status) !== "claimed") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `命令 #${input.commandId} 当前状态 ${String(cmd.status)}，仅 claimed 可回报`,
        });
      }
      const resultText = (input.result ?? "").slice(0, 4000) || null;
      await devQuery(
        sql`UPDATE st_device_commands SET status = ${input.status}, result = ${resultText}, done_at = NOW()
            WHERE id = ${input.commandId} AND status = 'claimed'`,
      );
      // 票据核销（C 级能力所携票据，回执即一次性作废）
      const ticketId = cmd.ticketId == null ? null : Number(cmd.ticketId);
      if (ticketId) await consumeTicket(ticketId);

      const cap = String(cmd.cap);
      const ok = input.status === "done";
      await emitSignal(
        device.factoryId,
        "ticket",
        ok ? "B" : "C",
        ok
          ? `设备命令执行成功：${device.name} · ${cap}`
          : `设备命令执行失败：${device.name} · ${cap}`,
        `命令 #${input.commandId} 设备 ${device.name}（#${device.id}）回报 ${input.status}${resultText ? `：${resultText.slice(0, 200)}` : ""}`,
      );
      publishBroadcast({
        factoryId: device.factoryId,
        level: ok ? "B" : "C",
        title: ok ? `设备 ${device.name} 已完成 ${cap}` : `设备 ${device.name} 执行 ${cap} 失败`,
      });
      return { ok: true as const, commandId: input.commandId, status: input.status };
    }),

  /**
   * devices.issueCommand（mutation, wb）：企业端/闸口侧下发命令。
   * - cap 须在全局白名单且在目标设备 caps 声明内（本机声明，中枢复核）；
   * - B 级 cap（print/screenshot）直接排队；C 级 cap（lock/run_script）必须带有效双签票据。
   */
  issueCommand: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        deviceId: z.number().int().positive(),
        cap: z.string().trim().min(1).max(32),
        payload: z.record(z.string(), z.unknown()).optional().default({}),
        ticketId: z.number().int().positive().optional(),
        clientKey: z.string().trim().min(1).max(64).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const factoryId = Number(factory.id);
      const cap = input.cap as DeviceCap;
      // C 级 cap：必须携带有效双签票据（票据在回执时核销）
      if ((CAPS_WHITELIST as readonly string[]).includes(cap) && CAP_LEVEL[cap] === "C") {
        if (!input.ticketId) {
          throw new TRPCError({ code: "FORBIDDEN", message: `C 级能力 ${cap} 必须携带有效双签票据（ticketId）` });
        }
        await validateTicket(input.ticketId, factoryId);
      }
      const r = await enqueueDeviceCommand({
        factoryId,
        deviceId: input.deviceId,
        cap: input.cap,
        payload: input.payload,
        ticketId: input.ticketId ?? null,
        clientKey: input.clientKey ?? null,
      });
      return {
        ok: true as const,
        commandId: r.commandId,
        deduped: r.deduped,
        status: "pending",
        level: CAP_LEVEL[cap],
      };
    }),

  /** devices.rename（mutation, admin）：设备改名（管理端） */
  rename: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        deviceId: z.number().int().positive(),
        name: z.string().trim().min(1).max(128),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const upd = await devQuery(
        sql`UPDATE st_devices SET name = ${input.name} WHERE id = ${input.deviceId}`,
      );
      const affected = Number((upd[0] as { affectedRows?: number | string } | undefined)?.affectedRows ?? 0);
      if (affected !== 1) throw new TRPCError({ code: "NOT_FOUND", message: `设备 #${input.deviceId} 不存在` });
      return { ok: true as const, deviceId: input.deviceId, name: input.name };
    }),

  /** devices.disable（mutation, admin）：禁用设备（status='disabled'；agentAuth 拒绝其心跳/认领/回报） */
  disable: publicQuery
    .input(z.object({ token: z.string().trim().min(1), deviceId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const upd = await devQuery(
        sql`UPDATE st_devices SET status = 'disabled' WHERE id = ${input.deviceId}`,
      );
      const affected = Number((upd[0] as { affectedRows?: number | string } | undefined)?.affectedRows ?? 0);
      if (affected !== 1) throw new TRPCError({ code: "NOT_FOUND", message: `设备 #${input.deviceId} 不存在` });
      return { ok: true as const, deviceId: input.deviceId, status: "disabled" };
    }),

  /** devices.list（query, wb）：本厂设备台账（在线状态/最近心跳，不含任何密钥材料） */
  list: publicQuery.input(z.object({ token: z.string().trim().min(1) })).query(async ({ input }) => {
    const { factory } = await sessionMe(input.token);
    const rows = await devQuery(
      sql`SELECT id, name, dtype, caps, status, last_seen_at AS lastSeenAt, created_at AS createdAt
          FROM st_devices WHERE factory_id = ${factory.id} ORDER BY id DESC LIMIT 100`,
    );
    return {
      devices: rows.map((r) => ({
        id: Number(r.id),
        name: String(r.name),
        dtype: String(r.dtype),
        caps: parseCaps(r.caps),
        status: String(r.status),
        lastSeenAt: r.lastSeenAt ? String(r.lastSeenAt) : null,
        createdAt: r.createdAt ? String(r.createdAt) : null,
      })),
    };
  }),
});
