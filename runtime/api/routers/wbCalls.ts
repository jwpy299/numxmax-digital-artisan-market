/**
 * wbCalls —— v1.4.0 波1 呼叫信令（成员 1v1 音视频通话 + 灵枢来电）。
 *
 * 纪律：
 * - 框架层无自动鉴权，token 只在请求体；一切 procedure 走 sessionMe（同 wbProactive）；
 * - 状态机：ringing→active→ended（hangup 落 durationSec）；ringing→rejected（被叫拒接）；
 *   ringing 超 RING_TIMEOUT_MS(60s，与 App 主叫等待 60s 对齐) 未接 → missed（惰性判定：wbProactive.poll 开头顺带
 *   清扫本企业超时呼叫 + accept 时二次判定；如需全局兜底可在 boot interval 挂
 *   sweepMissedCalls，当前 poll 驱动已覆盖来电屏场景）；
 * - 越权：callId 仅主/被叫可操作（accept/reject 仅被叫；hangup 双方），否则 FORBIDDEN；
 *   灵枢来电广播（calleeId NULL）本企业任一成员可接/挂；
 * - UserSig（TLSSigAPI@v2 官方算法）只在服务端生成；SecretKey 仅驻留 env
 *   （TRTC_SDK_APP_ID/TRTC_SECRET_KEY），绝不下发、绝不打日志；无 key 时返回 dev 假签名
 *   （仅开发联调，TRTC 校验必失败，波2 接真流前必须配置 env）；
 * - 来电推送复用 wbProactive 通道：wb_proactive_msgs.kind='incoming_call'，
 *   content=JSON 字符串载荷 IncomingCallPayload（priority='speak'，token body 既有通道）；
 * - 隐私红线：只落通话元数据（谁/何时/时长/类型），**不录音不录像**。
 */
import { createHmac } from "node:crypto";
import { deflateSync } from "node:zlib";
import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { wbCalls, wbProactiveMsgs, wbUsers, type WbCall } from "@db/schema";
import { sessionMe } from "./wbSession";

type Db = ReturnType<typeof getDb>;

const tokenInput = { token: z.string().trim().min(1) };

/** 振铃超时：60s 未接 → missed（惰性判定；与 App 主叫等待 60s 上限对齐） */
export const RING_TIMEOUT_MS = 60_000;

/** UserSig 有效期：7 天（腾讯官方 demo 口径；波2 TRTC 进房凭据） */
export const USERSIG_EXPIRE_SEC = 7 * 86400;

// ─── UserSig（TLSSigAPI@v2 官方算法，腾讯云文档 647/17275）──────────────────
/**
 * 官方算法（与 tencentyun/tls-sig-api-v2-node 逐字节一致）：
 * 1) HMAC-SHA256(secretKey, "TLS.identifier:{u}\nTLS.sdkappid:{app}\nTLS.time:{t}\nTLS.expire:{e}\n") → base64；
 * 2) sigDoc JSON（键序 TLS.ver/TLS.identifier/TLS.sdkappid/TLS.expire/TLS.time/TLS.sig）；
 * 3) zlib deflate 压缩 → base64 → URL 转义（+→*，/→-，=→_）。
 * now 参数仅测试对拍用（固定时间戳复现官方签名值）。
 */
export function genUserSig(
  sdkAppId: number,
  secretKey: string,
  userId: string,
  expire: number,
  now?: number,
): string {
  const currTime = now ?? Math.floor(Date.now() / 1000);
  const contentToBeSigned =
    `TLS.identifier:${userId}\n` +
    `TLS.sdkappid:${sdkAppId}\n` +
    `TLS.time:${currTime}\n` +
    `TLS.expire:${expire}\n`;
  const sig = createHmac("sha256", secretKey).update(contentToBeSigned, "utf8").digest("base64");
  const sigDoc = {
    "TLS.ver": "2.0",
    "TLS.identifier": userId,
    "TLS.sdkappid": sdkAppId,
    "TLS.expire": expire,
    "TLS.time": currTime,
    "TLS.sig": sig,
  };
  const compressed = deflateSync(Buffer.from(JSON.stringify(sigDoc), "utf8"));
  return compressed
    .toString("base64")
    .replace(/\+/g, "*")
    .replace(/\//g, "-")
    .replace(/=/g, "_");
}

/**
 * TRTC SDKAppID：单一事实源为 env TRTC_SDK_APP_ID（必须与 userSigFor 签发同源，
 * 否则 App 进房 sdkAppId 与 UserSig 内嵌 sdkappid 不一致必验签失败）；
 * 未配置 env 时兜底腾讯云官方 demo appId 1600156498（仅开发联调）。
 */
export function trtcSdkAppId(): number {
  return Number(process.env.TRTC_SDK_APP_ID) || 1600156498;
}

/**
 * 服务端签发 UserSig。SecretKey 只读 env，绝不下发/打日志；
 * 未配置 TRTC_SDK_APP_ID/TRTC_SECRET_KEY 时返回 dev 假签名：必须与 App 波1仪式通话/人格来电
 * 本地路径配套（仅本地演示，不真连 TRTC），真 TRTC 进房前必须配置 env。
 */
export function userSigFor(userId: number | string): string {
  const sdkAppId = Number(process.env.TRTC_SDK_APP_ID);
  const secretKey = process.env.TRTC_SECRET_KEY;
  if (sdkAppId && secretKey) {
    return genUserSig(sdkAppId, secretKey, String(userId), USERSIG_EXPIRE_SEC);
  }
  // dev 假签名：不含任何真实密钥，TRTC 校验必失败；必须与 App 波1仪式通话/人格来电
  // 本地路径配套，真 TRTC 进房前必须配 env（TRTC_SDK_APP_ID/TRTC_SECRET_KEY）
  return `dev.${Buffer.from(`usersig:${userId}`, "utf8").toString("base64")}.dev`;
}

// ─── 灵枢来电（数字人主动打电话）─────────────────────────────────────────────
export type CallPersona = "lingshu" | "xingyun";

/** 人格 → 来电显示名（谁触发谁来电：灵枢=生产/设备，星云=经营/邀请） */
export const PERSONA_CALLER_NAME: Record<CallPersona, string> = {
  lingshu: "灵枢",
  xingyun: "星云",
};

/**
 * incoming_call 推送载荷（wb_proactive_msgs.kind='incoming_call'，content=JSON 字符串）。
 * App 端 poll 到 kind='incoming_call' 时 JSON.parse(content) → 跳全屏来电屏。
 */
export interface IncomingCallPayload {
  callId: number;
  media: "audio" | "video";
  callerName: string; // 成员 displayName 或人格名（灵枢/星云）
  persona: CallPersona | null; // null=成员互拨
  summary?: string; // 灵枢来电口播详情（接听后 speak）
}

/**
 * pushProactiveCall：灵枢/星云来电（wb_calls callerId=0 + proactive 来电推送）。
 * targetUserId=null → 全员广播来电（同 wbProactive 广播语义，多设备同收）。
 * dedupeKey 查重（同 key 跳过——主动≠骚扰）；返回 ok:false 表示已发过。
 */
export async function pushProactiveCall(
  opts: {
    factoryId: number;
    targetUserId: number | null;
    persona: CallPersona;
    content: string; // 口播详情（≤300 字截断）
    kind: string; // 触发源（device_offline/invite_expire/...）
    dedupeKey: string;
  },
  db: Db = getDb(),
): Promise<{ ok: boolean; callId?: number }> {
  const dup = await db
    .select({ id: wbProactiveMsgs.id })
    .from(wbProactiveMsgs)
    .where(eq(wbProactiveMsgs.dedupeKey, opts.dedupeKey))
    .limit(1);
  if (dup.length > 0) return { ok: false };

  const summary = opts.content.slice(0, 300);
  const [ref] = await db
    .insert(wbCalls)
    .values({
      factoryId: opts.factoryId,
      callerId: 0, // 数字人来电
      calleeId: opts.targetUserId, // NULL=全员广播
      media: "audio",
      roomId: "", // 占位，取到 id 后回填 call_{id}
      status: "ringing",
      meta: { persona: opts.persona, content: summary, kind: opts.kind },
    })
    .$returningId();
  const callId = ref.id;
  await db
    .update(wbCalls)
    .set({ roomId: `call_${callId}` })
    .where(eq(wbCalls.id, callId));

  const payload: IncomingCallPayload = {
    callId,
    media: "audio",
    callerName: PERSONA_CALLER_NAME[opts.persona],
    persona: opts.persona,
    summary,
  };
  await db.insert(wbProactiveMsgs).values({
    factoryId: opts.factoryId,
    userId: opts.targetUserId,
    kind: "incoming_call",
    content: JSON.stringify(payload).slice(0, 500),
    priority: "speak",
    dedupeKey: opts.dedupeKey.slice(0, 128),
  });
  return { ok: true, callId };
}

// ─── 超时清扫（missed 惰性判定）──────────────────────────────────────────────
/**
 * sweepMissedCalls：本企业 ringing 超 60s（RING_TIMEOUT_MS，与 App 主叫等待对齐）未接 → missed + endedAt。
 * 接线点：wbProactive.poll 开头（被叫轮询时顺带清扫）；返回清扫行数（尽力而为）。
 */
export async function sweepMissedCalls(
  factoryId: number,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<number> {
  const result = await db
    .update(wbCalls)
    .set({ status: "missed", endedAt: now })
    .where(
      and(
        eq(wbCalls.factoryId, factoryId),
        eq(wbCalls.status, "ringing"),
        lt(wbCalls.startedAt, new Date(now.getTime() - RING_TIMEOUT_MS)),
      ),
    );
  const header = Array.isArray(result) ? result[0] : undefined;
  return (header as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

// ─── 路由 ───────────────────────────────────────────────────────────────────
async function loadCall(db: Db, callId: number, factoryId: number): Promise<WbCall> {
  const [call] = await db
    .select()
    .from(wbCalls)
    .where(and(eq(wbCalls.id, callId), eq(wbCalls.factoryId, factoryId)))
    .limit(1);
  if (!call) {
    throw new TRPCError({ code: "NOT_FOUND", message: "呼叫不存在" });
  }
  return call;
}

export const wbCallsRouter = createRouter({
  /**
   * call.invite {token, calleeUserId, media}
   *   → {ok, callId, roomId, callerSig, trtcUserId, sdkAppId}
   * trtcUserId = String(主叫 user.id)，与 callerSig 签发 identifier 必然一致（App 进房 userId 直用）；
   * sdkAppId 单一事实源 env TRTC_SDK_APP_ID（无 env 兜底 1600156498，见 trtcSdkAppId()）。
   * 一期仅同企业成员互拨；被叫经 wbProactive.poll 收到 incoming_call 推送。
   */
  invite: publicQuery
    .input(
      z.object({
        ...tokenInput,
        calleeUserId: z.number().int().positive(),
        media: z.enum(["audio", "video"]),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { user, factory } = await sessionMe(input.token);
      if (input.calleeUserId === user.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "不能呼叫自己" });
      }
      // 被叫必须本企业成员（跨企业统一 BAD_REQUEST，不泄露他企业成员存在性）
      const [callee] = await db
        .select()
        .from(wbUsers)
        .where(and(eq(wbUsers.id, input.calleeUserId), eq(wbUsers.factoryId, factory.id)))
        .limit(1);
      if (!callee) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "被叫用户不存在或非本企业成员" });
      }
      const [ref] = await db
        .insert(wbCalls)
        .values({
          factoryId: factory.id,
          callerId: user.id,
          calleeId: callee.id,
          media: input.media,
          roomId: "", // 占位，取到 id 后回填 call_{id}
          status: "ringing",
        })
        .$returningId();
      const roomId = `call_${ref.id}`;
      await db.update(wbCalls).set({ roomId }).where(eq(wbCalls.id, ref.id));
      const payload: IncomingCallPayload = {
        callId: ref.id,
        media: input.media,
        callerName: user.displayName,
        persona: null,
      };
      await db.insert(wbProactiveMsgs).values({
        factoryId: factory.id,
        userId: callee.id, // 定向推送：仅被叫可见
        kind: "incoming_call",
        content: JSON.stringify(payload),
        priority: "speak",
        dedupeKey: `call-invite-${ref.id}`,
      });
      return {
        ok: true as const,
        callId: ref.id,
        roomId,
        callerSig: userSigFor(user.id),
        trtcUserId: String(user.id), // 主叫进房 userId = UserSig 签发 identifier
        sdkAppId: trtcSdkAppId(),
      };
    }),

  /**
   * call.accept {token, callId} → {ok, roomId, calleeSig, trtcUserId, sdkAppId}
   * trtcUserId = String(被叫 user.id)，与 calleeSig 签发 identifier 必然一致；
   * sdkAppId 单一事实源 env TRTC_SDK_APP_ID（无 env 兜底 1600156498）。
   * 仅被叫（灵枢来电广播 calleeId NULL 则本企业成员均可接）；ringing→active；
   * ringing 超 60s 惰性落 missed 后拒绝接听；active 幂等重入仍返 calleeSig。
   * 竞态护栏：ringing→active 的 UPDATE 带 WHERE status='ringing'，与 hangup/reject
   * 并发时败方 affectedRows=0 → BAD_REQUEST（严禁 ended/rejected 复活为 active）。
   */
  accept: publicQuery
    .input(z.object({ ...tokenInput, callId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const { user, factory } = await sessionMe(input.token);
      const call = await loadCall(db, input.callId, factory.id);
      if (call.calleeId !== null && call.calleeId !== user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅被叫可接听" });
      }
      const accepted = {
        roomId: call.roomId,
        calleeSig: userSigFor(user.id),
        trtcUserId: String(user.id), // 被叫进房 userId = UserSig 签发 identifier
        sdkAppId: trtcSdkAppId(),
      };
      if (call.status === "active") {
        // 幂等重入（来电屏双击/网络重试）
        return { ok: true as const, ...accepted };
      }
      if (call.status !== "ringing") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "呼叫已结束" });
      }
      // 惰性超时判定：ringing 超 60s → missed
      if (Date.now() - call.startedAt.getTime() > RING_TIMEOUT_MS) {
        await db
          .update(wbCalls)
          .set({ status: "missed", endedAt: new Date() })
          .where(eq(wbCalls.id, call.id));
        throw new TRPCError({ code: "BAD_REQUEST", message: "呼叫已超时未接" });
      }
      // 竞态护栏：WHERE status='ringing' 条件更新——与 hangup/reject 并发时败方 0 行，
      // 终态（ended/rejected/missed）绝不复活为 active
      const result = await db
        .update(wbCalls)
        .set({ status: "active", answeredAt: new Date() })
        .where(and(eq(wbCalls.id, call.id), eq(wbCalls.status, "ringing")));
      const header = Array.isArray(result) ? result[0] : undefined;
      const affected = (header as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
      if (affected === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "呼叫已被挂断或结束" });
      }
      return { ok: true as const, ...accepted };
    }),

  /** call.reject {token, callId} → {ok}：仅被叫；ringing→rejected；终态幂等 ok */
  reject: publicQuery
    .input(z.object({ ...tokenInput, callId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const { user, factory } = await sessionMe(input.token);
      const call = await loadCall(db, input.callId, factory.id);
      if (call.calleeId !== null && call.calleeId !== user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅被叫可拒接" });
      }
      if (call.status === "ringing") {
        await db
          .update(wbCalls)
          .set({ status: "rejected", endedAt: new Date() })
          .where(eq(wbCalls.id, call.id));
      }
      return { ok: true as const }; // 终态幂等（不泄露状态机细节）
    }),

  /**
   * call.hangup {token, callId} → {ok}：主被叫均可（灵枢来电广播本企业成员均可挂）；
   * active/ringing→ended + durationSec（answeredAt 起算，未应答=0）；终态幂等 ok。
   */
  hangup: publicQuery
    .input(z.object({ ...tokenInput, callId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const { user, factory } = await sessionMe(input.token);
      const call = await loadCall(db, input.callId, factory.id);
      const isParty =
        call.callerId === user.id || call.calleeId === null || call.calleeId === user.id;
      if (!isParty) {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅通话双方可操作" });
      }
      if (call.status === "active" || call.status === "ringing") {
        const now = new Date();
        const durationSec = call.answeredAt
          ? Math.max(0, Math.floor((now.getTime() - call.answeredAt.getTime()) / 1000))
          : 0;
        await db
          .update(wbCalls)
          .set({ status: "ended", endedAt: now, durationSec })
          .where(eq(wbCalls.id, call.id));
      }
      return { ok: true as const };
    }),
});
