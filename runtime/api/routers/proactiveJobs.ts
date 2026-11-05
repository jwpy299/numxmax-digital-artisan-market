/**
 * proactiveJobs —— M23b 主动服务触发器（每 10 分钟一轮，boot.ts 注册 interval，
 * 跟随 [evo] weekly scheduler 的注册模式：生产环境 + 环境变量可关 + 失败静默）。
 *
 * 触发规则（纪律：主动≠骚扰——一切写入先按 dedupeKey 查重，同 key 存在即跳过）：
 * a. 设备离线：wb_devices lastSeenAt < NOW()-30min AND revokedAt IS NULL（NULL=从未心跳，不算离线）
 *    → dedupeKey=`dev-offline-{deviceId}-{YYYY-MM-DD}`（按天查重，同设备一天最多烦一次）
 *    → v1.4.0：speak 级升级为「灵枢来电」pushProactiveCall（persona=lingshu，全员广播）；
 * b. 邀请临期：wb_invites consumedAt IS NULL AND revokedAt IS NULL
 *    AND expiresAt < NOW()+24h AND createdAt < NOW()-24h（发出满一天仍未用且 24h 内到期）
 *    → dedupeKey=`invite-expire-{inviteId}`（每邀请终身最多烦一次）
 *    → v1.4.0：升级为「星云来电」pushProactiveCall（persona=xingyun，全员广播）。
 *
 * 多实例并发说明：dedupeKey 是普通索引非唯一键，check-then-insert 在双实例同刻
 * 并发下理论上可能各插一条（概率极低、后果仅是重复提醒一次），可接受；如需绝对
 * 唯一再升级唯一键（additive 迁移）。
 */
import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { wbDevices, wbInvites, wbProactiveMsgs } from "@db/schema";
import { pushProactiveCall } from "./wbCalls";

type Db = ReturnType<typeof getDb>;

const OFFLINE_THRESHOLD_MS = 30 * 60 * 1000;
const INVITE_EXPIRE_WINDOW_MS = 24 * 3600 * 1000;
const INVITE_MIN_AGE_MS = 24 * 3600 * 1000;

/** dedupeKey 查重：同 key 已存在（无论已读未读）→ 跳过（主动≠骚扰） */
async function alreadySent(db: Db, dedupeKey: string): Promise<boolean> {
  const rows = await db
    .select({ id: wbProactiveMsgs.id })
    .from(wbProactiveMsgs)
    .where(eq(wbProactiveMsgs.dedupeKey, dedupeKey))
    .limit(1);
  return rows.length > 0;
}

export interface SweepResult {
  deviceAlerts: number;
  inviteAlerts: number;
}

/** runProactiveSweep：跑一轮主动服务扫描（boot interval 与单测共用一个入口） */
export async function runProactiveSweep(now: Date = new Date(), db: Db = getDb()): Promise<SweepResult> {
  const day = now.toISOString().slice(0, 10); // YYYY-MM-DD（UTC 口径，与 dedupeKey 注释一致）
  let deviceAlerts = 0;
  let inviteAlerts = 0;

  // a. 设备离线（lastSeenAt NULL=绑定后从未心跳，不算「离线超 30 分钟」，不打扰）
  const offlineDevices = await db
    .select({ id: wbDevices.id, factoryId: wbDevices.factoryId, name: wbDevices.name })
    .from(wbDevices)
    .where(
      and(
        isNull(wbDevices.revokedAt),
        isNotNull(wbDevices.lastSeenAt),
        lt(wbDevices.lastSeenAt, new Date(now.getTime() - OFFLINE_THRESHOLD_MS)),
      ),
    );
  for (const d of offlineDevices) {
    const dedupeKey = `dev-offline-${d.id}-${day}`;
    // v1.4.0 灵枢来电：wb_calls(callerId=0, ringing) + incoming_call 推送（persona=lingshu）
    const r = await pushProactiveCall(
      {
        factoryId: d.factoryId,
        targetUserId: null, // 全员广播：设备台账是厂级事项
        persona: "lingshu",
        content: `老板，设备「${String(d.name).slice(0, 60)}」已离线超过 30 分钟，去设备台账看看？`,
        kind: "device_offline",
        dedupeKey,
      },
      db,
    );
    if (r.ok) deviceAlerts += 1;
  }

  // b. 邀请临期（发满 24h 未用且 24h 内到期）
  const expiringInvites = await db
    .select({ id: wbInvites.id, factoryId: wbInvites.factoryId, displayName: wbInvites.displayName })
    .from(wbInvites)
    .where(
      and(
        isNull(wbInvites.consumedAt),
        isNull(wbInvites.revokedAt),
        lt(wbInvites.expiresAt, new Date(now.getTime() + INVITE_EXPIRE_WINDOW_MS)),
        lt(wbInvites.createdAt, new Date(now.getTime() - INVITE_MIN_AGE_MS)),
      ),
    );
  for (const inv of expiringInvites) {
    const dedupeKey = `invite-expire-${inv.id}`;
    // v1.4.0 星云来电：经营/邀请事项由星云拨打（persona=xingyun）
    const r = await pushProactiveCall(
      {
        factoryId: inv.factoryId,
        targetUserId: null,
        persona: "xingyun",
        content: `发给${String(inv.displayName).slice(0, 30)}的邀请快过期了，去组织页看看？`,
        kind: "invite_expire",
        dedupeKey,
      },
      db,
    );
    if (r.ok) inviteAlerts += 1;
  }

  // v148 汇报总线挂尾（独立 try/catch——总线故障绝不拖垮原触发器）
  try {
    const { runReportSweep } = await import("./reportBus");
    await runReportSweep(now);
  } catch {
    // 静默：汇报缺席不影响设备/邀请告警主链
  }
  // v149 北极星快照（独立隔离：采集器故障不影响主链 F4）
  try {
    const { snapshotNorthStar } = await import("./feedbackCollector");
    await snapshotNorthStar();
  } catch {
    // 静默
  }
  // v153 分身实习派单+在职月数累计（独立隔离）
  try {
    const { runInternDispatch, refreshHireMonths } = await import("./internDispatch");
    await refreshHireMonths();
    await runInternDispatch(now);
  } catch {
    // 静默
  }
  // v164 情绪节点：注册满 7 天扫描（独立隔离——锦上添花绝不拖垮主链）
  try {
    const { runEmotionSweep } = await import("./emotionNodes");
    await runEmotionSweep();
  } catch {
    // 静默
  }
  // v165 学习环第二步：预审结果对账（独立隔离）
  try {
    const { reconcileOutcomes } = await import("../harness/sdlcLearning");
    await reconcileOutcomes();
  } catch {
    // 静默
  }
  // v172 城市智能运行时：城市运营官节拍（独立隔离）
  try {
    const { runCityBeat } = await import("./cityRuntime");
    await runCityBeat(now);
  } catch {
    // 静默
  }
  return { deviceAlerts, inviteAlerts };
}

/** 供未来系统事件直写主动消息（M23b 其余触发器复用同一查重纪律） */
export async function pushProactiveMsg(
  msg: {
    factoryId: number;
    userId: number | null;
    kind: string;
    content: string;
    priority: "card" | "speak";
    dedupeKey: string;
  },
  db: Db = getDb(),
): Promise<boolean> {
  if (await alreadySent(db, msg.dedupeKey)) return false;
  await db.insert(wbProactiveMsgs).values({
    factoryId: msg.factoryId,
    userId: msg.userId,
    kind: msg.kind.slice(0, 32),
    content: msg.content.slice(0, 500),
    priority: msg.priority,
    dedupeKey: msg.dedupeKey.slice(0, 128),
  });
  return true;
}
