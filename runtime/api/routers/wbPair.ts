/**
 * wbPair —— M17 扫码绑设备（一次性配对码 pd_ + 设备凭证 dt_ + 终端台账）。
 *
 * 纪律（与 wb_tickets/wb_invites 同构）：
 * - 明文配对码（pd_+48hex）仅 open 响应返回一次；明文设备凭证（dt_）仅首次 status 拉取返回一次；
 *   库中只存 sha256，绝不落盘/输出明文或 codeHash/tokenHash；
 * - token 只在请求体（框架层无自动鉴权，业务层 sessionMe/requireWbRole 校验）；
 * - dt_ 投递：明文不可持久化（红线），故 claim 时写入的 tokenHash 是永不投递的占位凭据；
 *   真正的 dt_ 在设备首次 status 拉取时现场生成——事务内原子置 tokenPulledAt=NOW() 且轮换
 *   tokenHash=sha256(dt_new)，明文随该次响应返回且仅此一次（等价「明文一次」语义）。
 * - 权限（设计 §5）：open/status 公开（码即权柄坯子）；claim 不挑角色（全员可扫码绑定）；
 *   list admin/manager；revoke 仅 admin（C 级，前端显式确认）；heartbeat 仅 dt_ 设备凭证。
 *
 * M72（v2.1.9 信号源自动发现）：ps_ 邻近短码与 pd_ 同表同链——
 * - signalOpen（公开，设备端插件）：发 60s 短码 ps_（pd_ 300s 对空口广播太长），设备经
 *   BLE 广播/mDNS TXT 随空气发出；channel 列落审计（ble/mdns，存量 NULL='qr'）；
 * - claim/status 口径 widen 为 p[ds]_：APP 发现 ps_ 后走既有 claim 事务（零分叉），
 *   设备持 ps_ 轮询既有 status 自取 dt_（零分叉）；claim 响应附 channel 供 APP 文案。
 * - 安全口径：物理邻近 + 60s 旋转短码 ≥ QR 可被远拍的暴露面；限频与 open 共用同计数。
 */
import { z } from "zod";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import {
  wbDevices,
  wbFactories,
  wbPairCodes,
  wbUsers,
  type WbDevice,
  type WbPairCode,
} from "@db/schema";
import { newCredential, requireWbRole, sessionMe, sha256 } from "./wbSession";

const PAIR_INVALID = "配对码无效或已过期";
const PAIR_CONSUMED = "配对码已被使用或已过期";
const DEVICE_BOUND = "该设备已绑定，请先解绑";
const DEVICE_LIST_DENIED = "仅企业负责人或部门负责人可查看设备列表";
const DEVICE_REVOKE_DENIED = "仅企业负责人可解绑设备"; // C 级动作，前端显式确认
const DEVICE_TOKEN_INVALID = "设备凭证无效或已解绑";
const PAIR_RATE_DENIED = "操作太频繁，请稍后再试";

/** 配对码 TTL：固定 5 分钟（与 WB_TICKET_TTL_SECONDS 同风格） */
export const WB_PAIR_TTL_SECONDS = 300;
/** M72 邻近短码 TTL：60s（空口广播旋转用，暴露窗口远小于扫码码） */
export const WB_SIGNAL_TTL_SECONDS = 60;
/**
 * open 限频：同一设备指纹 60s 内最多开 10 个配对码（DB 计数，重启不丢）。
 * 注：open 公开无 token、wb_pair_codes 亦无 factoryId 列（码在 claim 时才关联企业），
 * 设备指纹是 open 唯一可用的调用方标识。
 */
export const WB_PAIR_OPEN_LIMIT = 10;
const PAIR_RATE_WINDOW_MS = 60_000;
/** 在线判定：心跳周期 30s 的 3 倍宽限 */
const ONLINE_GRACE_MS = 90_000;

const tokenInput = { token: z.string().trim().min(1) };
const codeInput = z
  .string()
  .trim()
  .regex(/^p[ds]_[0-9a-f]{48}$/, "配对码格式不正确"); // M72：pd_ 扫码码 | ps_ 邻近短码，同链处理
const signalChannelInput = z.enum(["ble", "mdns"]);
const deviceTokenInput = z
  .string()
  .trim()
  .regex(/^dt_[0-9a-f]{48}$/, "设备凭证格式不正确");
const deviceTypeInput = z.enum(["desktop", "tablet", "box", "other"]);

/** 配对码状态（一次性语义：consumed > expired > pending） */
function pairState(code: WbPairCode, now: Date): "pending" | "claimed" | "expired" {
  if (code.consumedAt) return "claimed";
  if (new Date(code.expiresAt).getTime() <= now.getTime()) return "expired";
  return "pending";
}

/** 设备状态：revoked > online（90s 内心跳）> offline */
function deviceStatus(d: WbDevice, now: Date): "online" | "offline" | "revoked" {
  if (d.revokedAt) return "revoked";
  if (d.lastSeenAt && now.getTime() - new Date(d.lastSeenAt).getTime() <= ONLINE_GRACE_MS) {
    return "online";
  }
  return "offline";
}

export const wbPairRouter = createRouter({
  /**
   * open（mutation，公开）：设备端生成一次性配对码（设备此时无任何凭证，码即凭证坯子）。
   * 明文 pd_ 仅本次响应返回（前端仅用于渲染二维码）；库写 sha256。TTL 固定 300s。
   */
  open: publicQuery
    .input(
      z.object({
        deviceName: z.string().trim().min(1).max(64),
        deviceType: deviceTypeInput,
        fingerprint: z.string().trim().min(8).max(128),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      // lazy 清理：open 是唯一高频写入口，顺带删全表过期码（走 expiresIdx 索引，代价极低；
      // 表无 factoryId 列——open 公开无企业上下文，故按全表而非本企业清理）
      await db.execute(sql`DELETE FROM wb_pair_codes WHERE expiresAt < NOW()`);
      // 限频（DB 计数，重启不丢）：同指纹 60s 内 ≥10 码 → TOO_MANY_REQUESTS
      const since = new Date(Date.now() - PAIR_RATE_WINDOW_MS);
      const rows = await db
        .select({ count: sql<number>`count(*)` })
        .from(wbPairCodes)
        .where(
          and(eq(wbPairCodes.fingerprint, input.fingerprint), gte(wbPairCodes.createdAt, since)),
        );
      if (Number(rows[0]?.count ?? 0) >= WB_PAIR_OPEN_LIMIT) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: PAIR_RATE_DENIED });
      }
      const code = newCredential("pd_"); // 明文仅此一处，随响应返回一次
      const expiresAt = new Date(Date.now() + WB_PAIR_TTL_SECONDS * 1000);
      await db.insert(wbPairCodes).values({
        codeHash: sha256(code),
        deviceName: input.deviceName,
        deviceType: input.deviceType,
        fingerprint: input.fingerprint,
        expiresAt,
      });
      return {
        code, // 明文仅本次
        qrPayload: { t: "pair" as const, c: code, v: 1 as const },
        expiresAt,
      };
    }),

  /**
   * signalOpen（mutation，公开，M72）：设备端插件取邻近短码 ps_（60s TTL）经 BLE/mDNS 广播。
   * 与 open 同表同限频同清理；唯一差别：TTL 短 + channel 落审计。
   * 设备随后持 ps_ 轮询既有 status 自取 dt_（全链零分叉）。
   */
  signalOpen: publicQuery
    .input(
      z.object({
        deviceName: z.string().trim().min(1).max(64),
        deviceType: deviceTypeInput,
        fingerprint: z.string().trim().min(8).max(128),
        channel: signalChannelInput,
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.execute(sql`DELETE FROM wb_pair_codes WHERE expiresAt < NOW()`); // 同 open：lazy 清理
      const since = new Date(Date.now() - PAIR_RATE_WINDOW_MS);
      const rows = await db
        .select({ count: sql<number>`count(*)` })
        .from(wbPairCodes)
        .where(
          and(eq(wbPairCodes.fingerprint, input.fingerprint), gte(wbPairCodes.createdAt, since)),
        );
      if (Number(rows[0]?.count ?? 0) >= WB_PAIR_OPEN_LIMIT) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: PAIR_RATE_DENIED });
      }
      const code = newCredential("ps_"); // 明文仅此一处，随响应返回一次
      const expiresAt = new Date(Date.now() + WB_SIGNAL_TTL_SECONDS * 1000);
      await db.insert(wbPairCodes).values({
        codeHash: sha256(code),
        deviceName: input.deviceName,
        deviceType: input.deviceType,
        fingerprint: input.fingerprint,
        channel: input.channel,
        expiresAt,
      });
      return {
        code, // 明文仅本次
        /** 空口广播载荷：BLE adv manufacturer data / mDNS TXT 共用同一 JSON 契约（APP 侧解析） */
        broadcast: { t: "sig" as const, c: code, ch: input.channel, v: 1 as const },
        expiresAt,
      };
    }),

  /**
   * status（query，公开）：设备端 3s 轮询等待绑定结果。
   * state=claimed 且 tokenPulledAt IS NULL（凭证待自取）→ 事务内原子置位 + 轮换 tokenHash，
   * dt_ 明文随本次响应返回且仅此一次；之后再拉不再返回明文。绝不泄露跨码细节（不存在=expired）。
   */
  status: publicQuery.input(z.object({ code: codeInput })).query(async ({ input }) => {
    const db = getDb();
    const [code] = await db
      .select()
      .from(wbPairCodes)
      .where(eq(wbPairCodes.codeHash, sha256(input.code)))
      .limit(1);
    if (!code) {
      return { state: "expired" as const }; // 不泄露码存在性细节
    }
    const state = pairState(code, new Date());
    if (state !== "claimed") {
      return { state };
    }
    // 绑定事实：F1 按 claim 事务回写的 consumedDeviceId 精确找在册设备（绝不按 fingerprint 捞，
    // 否则旧设备 revoke 后同指纹重绑，旧码会误领新设备 dt_）；链接缺失（旧数据）只报告事实不发 token
    if (!code.consumedDeviceId) {
      return { state: "claimed" as const };
    }
    const [device] = await db
      .select()
      .from(wbDevices)
      .where(
        and(eq(wbDevices.id, Number(code.consumedDeviceId)), isNull(wbDevices.revokedAt)),
      )
      .limit(1);
    if (!device) {
      return { state: "expired" as const }; // 设备不存在/已解绑：统一口径，绝不泄露细节、绝不发 token
    }
    const [factory] = await db
      .select()
      .from(wbFactories)
      .where(eq(wbFactories.id, device.factoryId))
      .limit(1);
    const base = {
      state: "claimed" as const,
      deviceId: device.id,
      deviceName: device.name,
      factoryName: factory?.enterpriseName ?? null,
    };
    if (device.tokenPulledAt) {
      return base; // dt_ 已被拉取过：只报告绑定事实，绝不重发明文
    }
    // 首次拉取：原子置 tokenPulledAt（并发轮询仅一胜）+ 轮换 tokenHash=sha256(新 dt_)
    const deviceToken = newCredential("dt_"); // 明文仅此一处，随响应返回一次
    const upd = await db.execute(
      sql`UPDATE wb_devices SET tokenPulledAt = NOW(), tokenHash = ${sha256(deviceToken)} WHERE id = ${device.id} AND tokenPulledAt IS NULL AND revokedAt IS NULL`,
    );
    const affected = Number(
      (upd[0] as { affectedRows?: number | string } | undefined)?.affectedRows ?? 0,
    );
    if (affected !== 1) {
      return base; // 并发败方：另一轮询已取走，不再返回明文
    }
    return { ...base, deviceToken }; // 明文仅本次
  }),

  /**
   * claim（mutation，需登录，不挑角色——设计 §5：员工/老板 App 扫码均可绑定）。
   * 单事务：原子消费配对码（影响行=0 → CONFLICT）→ fingerprint 在册设备查重（CONFLICT）
   * → INSERT wb_devices（factoryId=扫码人企业，tokenHash=占位凭据 sha256，dt_ 由设备自取）。
   * 响应只回台账信息，绝不含 dt_（App 不持设备凭证，减少泄露面）。
   */
  claim: publicQuery
    .input(z.object({ ...tokenInput, code: codeInput }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const { user, factory } = await sessionMe(input.token);
      const [code] = await db
        .select()
        .from(wbPairCodes)
        .where(eq(wbPairCodes.codeHash, sha256(input.code)))
        .limit(1);
      if (!code || pairState(code, new Date()) !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: PAIR_INVALID }); // 统一口径不泄露细节
      }
      let deviceId = 0;
      await db.transaction(async (tx) => {
        // 原子置 consumedAt 先行：一次性消费，并发抢用/过期败方影响行=0 → CONFLICT
        const upd = await tx.execute(
          sql`UPDATE wb_pair_codes SET consumedAt = NOW() WHERE id = ${code.id} AND consumedAt IS NULL AND expiresAt > NOW()`,
        );
        const affected = Number(
          (upd[0] as { affectedRows?: number | string } | undefined)?.affectedRows ?? 0,
        );
        if (affected !== 1) {
          throw new TRPCError({ code: "CONFLICT", message: PAIR_CONSUMED });
        }
        // 同一设备重复绑定防护：在册（未解绑）同 fingerprint → CONFLICT；已解绑允许重绑。
        // F2：SELECT ... FOR UPDATE 序列化并发——RR 下普通快照读不加锁，双并发同指纹可双双
        // 查空双插；FOR UPDATE 借 wb_devices_fingerprint_idx 邻键锁（行在锁行/行不在锁间隙），
        // 同指纹并发 claim 串行化，后进入者读到前者已提交的设备 → CONFLICT。
        const [dup] = await tx
          .select({ id: wbDevices.id })
          .from(wbDevices)
          .where(and(eq(wbDevices.fingerprint, code.fingerprint), isNull(wbDevices.revokedAt)))
          .limit(1)
          .for("update");
        if (dup) {
          throw new TRPCError({ code: "CONFLICT", message: DEVICE_BOUND });
        }
        // tokenHash 占位：明文不持久化，真正 dt_ 在首次 status 拉取时生成并轮换（见文件头纪律）
        const [{ id }] = await tx
          .insert(wbDevices)
          .values({
            factoryId: factory.id,
            name: code.deviceName,
            deviceType: code.deviceType,
            fingerprint: code.fingerprint,
            tokenHash: sha256(newCredential("dt_")), // 占位凭据，明文即刻废弃、永不可用
            claimedBy: user.id,
          })
          .$returningId();
        deviceId = id;
        // F1：同事务回写码→设备链接列，status 按此精确找设备（杜绝旧码领新设备 dt_）
        await tx
          .update(wbPairCodes)
          .set({ consumedDeviceId: String(id) })
          .where(eq(wbPairCodes.id, code.id));
      });
      return {
        ok: true as const,
        deviceId,
        deviceName: code.deviceName,
        deviceType: code.deviceType,
        enterpriseName: factory.enterpriseName,
        channel: code.channel ?? ("qr" as const), // M72：审计回显（ble/mdns/qr），APP 文案用
      };
    }),

  /**
   * list（query，admin/manager）：本企业设备台账。绝不输出 tokenHash；fingerprint 仅前 8 位辅助识别。
   */
  list: publicQuery.input(z.object({ ...tokenInput })).query(async ({ input }) => {
    const db = getDb();
    const { factory } = await requireWbRole(input.token, ["admin", "manager"], DEVICE_LIST_DENIED);
    const rows = await db.select().from(wbDevices).where(eq(wbDevices.factoryId, factory.id));
    const claimerNameOf = new Map<number, string>();
    if (rows.length > 0) {
      const members = await db
        .select({ id: wbUsers.id, displayName: wbUsers.displayName })
        .from(wbUsers)
        .where(eq(wbUsers.factoryId, factory.id));
      for (const u of members) claimerNameOf.set(u.id, u.displayName);
    }
    const now = new Date();
    return rows
      .map((d) => ({
        deviceId: d.id,
        name: d.name,
        deviceType: d.deviceType,
        status: deviceStatus(d, now),
        lastSeenAt: d.lastSeenAt,
        createdAt: d.createdAt,
        claimedByName: claimerNameOf.get(d.claimedBy) ?? null,
        fingerprintHint: d.fingerprint.slice(0, 8), // 仅前 8 位辅助识别
      }))
      .sort((a, b) => b.deviceId - a.deviceId);
  }),

  /**
   * revoke（mutation，仅 admin，C 级）：解绑设备，token 立即失效（heartbeat 拒）。
   * 同企业校验（NOT_FOUND 不泄露跨企业存在性）；幂等（已解绑重复调用返回 ok:true）。
   */
  revoke: publicQuery
    .input(z.object({ ...tokenInput, deviceId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const { factory } = await requireWbRole(input.token, ["admin"], DEVICE_REVOKE_DENIED);
      const [device] = await db
        .select()
        .from(wbDevices)
        .where(and(eq(wbDevices.id, input.deviceId), eq(wbDevices.factoryId, factory.id)))
        .limit(1);
      if (!device) {
        throw new TRPCError({ code: "NOT_FOUND", message: "设备不存在" });
      }
      if (device.revokedAt) {
        return { ok: true as const, deviceId: device.id }; // 幂等：重复解绑
      }
      await db
        .update(wbDevices)
        .set({ revokedAt: new Date() })
        .where(eq(wbDevices.id, device.id));
      return { ok: true as const, deviceId: device.id };
    }),

  /**
   * heartbeat（mutation，dt_ 设备凭证，token 在 body 红线）：更新 lastSeenAt。
   * 未命中 / 已解绑 / 凭证未被拉取（tokenPulledAt NULL）→ UNAUTHORIZED 统一口径。
   */
  heartbeat: publicQuery
    .input(
      z.object({
        deviceToken: deviceTokenInput,
        meta: z
          .object({ version: z.string().max(64).optional(), ip: z.string().max(64).optional() })
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [device] = await db
        .select()
        .from(wbDevices)
        .where(eq(wbDevices.tokenHash, sha256(input.deviceToken)))
        .limit(1);
      if (!device || device.revokedAt || !device.tokenPulledAt) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: DEVICE_TOKEN_INVALID });
      }
      await db.update(wbDevices).set({ lastSeenAt: new Date() }).where(eq(wbDevices.id, device.id));
      return { ok: true as const, serverTime: new Date() };
    }),
});
