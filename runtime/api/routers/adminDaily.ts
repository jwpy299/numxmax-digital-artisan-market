/** 邀测口令运营与组织运行时管理面：全 admin 鉴权；写动作按舱角色，C 级动作双签并留真实审计。 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows, warnThrottled } from "../queries/rawRows";
import { requireAdmin } from "../auth/adminGate";
import { cabinIdentityOf, requireCabinAction } from "../auth/cabinGate";
import { requireDualSign } from "../auth/adminDualSign";
import { guardInfra } from "../auth/identity";
import { affectedRowsOf } from "../lib/dbResult";
import { hqFactoryId } from "../lib/hq";
import { newCredential, sha256 } from "./wbSession";
import { ensureBetaInvites, withBetaInvitePhoneLock } from "./betaInvites";
import { todayRow, BETA_DAILY_QUOTA_MIN, BETA_DAILY_QUOTA_MAX } from "./betaDaily";
import { writeAdminAudit } from "./adminAnalytics";
import { BETA_KINDS } from "@contracts/betaKinds";

const tokenInput = z.object({ token: z.string().trim().min(1) });
const reviewTokenInput = z.object({ reviewToken: z.string().trim().min(1) });
const DEFAULT_HARNESS_BASE = "http://127.0.0.1:18800";
const HARNESS_BASE = (process.env.HARNESS_POOL_URL ?? process.env.HARNESS_POOL_BASE ?? DEFAULT_HARNESS_BASE).trim().replace(/\/+$/, "") || DEFAULT_HARNESS_BASE;
const HARNESS_CACHE_MS = (() => { const n = Number(process.env.ADMIN_RUNTIME_CACHE_MS ?? "5000"); return Number.isInteger(n) && n >= 0 && n <= 30_000 ? n : 5_000; })();
const harnessCache = new Map<string, { at: number; value: Promise<Record<string, unknown> | null> }>();

async function harnessGetUncached(path: string): Promise<Record<string, unknown> | null> {
  const token = (process.env.DSH_SERVICE_TOKEN ?? "").trim();
  if (!token) {
    warnThrottled("adminDaily.runtime.token", "DSH_SERVICE_TOKEN 未配置——运行时管理面降级，不发送空 Bearer");
    return null;
  }
  try {
    const r = await fetch(`${HARNESS_BASE}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => null) as unknown;
    if (!r.ok || !j || typeof j !== "object" || "error" in j || (j as { ok?: unknown }).ok === false) {
      warnThrottled(`adminDaily.runtime.http:${path}:${r.status}`, `Harness 响应不可用：${path} status=${r.status}`);
      return null;
    }
    return j as Record<string, unknown>;
  } catch (e) {
    warnThrottled(`adminDaily.runtime.error:${path}`, `Harness 未达：${path} ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
    return null;
  }
}

function harnessGet(path: string): Promise<Record<string, unknown> | null> {
  if (HARNESS_CACHE_MS === 0) return harnessGetUncached(path);
  const now = Date.now();
  const cached = harnessCache.get(path);
  if (cached && now - cached.at < HARNESS_CACHE_MS) return cached.value;
  const value = harnessGetUncached(path);
  harnessCache.set(path, { at: now, value });
  return value;
}

/** 总数缺失且页已满=计数未知，不把截断页长度冒充全量。 */
function totalOf(payload: Record<string, unknown>, items: readonly unknown[], pageLimit: number): number | null {
  const raw = payload.total ?? payload.totalCount ?? payload.count;
  if (raw !== undefined) {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }
  return items.length < pageLimit ? items.length : null;
}

function itemsOf(payload: Record<string, unknown> | null): Array<Record<string, unknown>> | null {
  if (payload === null || !Array.isArray(payload.items)) return null;
  return payload.items as Array<Record<string, unknown>>;
}

function onDbDay(rawValue: unknown, today: string, startEpoch: number, endEpoch: number): boolean {
  const raw = String(rawValue ?? "");
  const zoned = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
  if (!zoned) return raw.slice(0, 10) === today;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || !Number.isFinite(startEpoch) || !Number.isFinite(endEpoch)) return false;
  return ms >= startEpoch * 1000 && ms < endEpoch * 1000;
}

function maskPhone(p: string): string {
  return p.length >= 7 ? `${p.slice(0, 3)}****${p.slice(-4)}` : "***";
}

const INVITE_LIST_SELECT = sql`SELECT id, phone, codeHash, enterprise_name, DATE_FORMAT(expires_at,'%Y-%m-%dT%H:%i:%s') AS expires_at, DATE_FORMAT(consumed_at,'%Y-%m-%dT%H:%i:%s') AS consumed_at, DATE_FORMAT(revoked_at,'%Y-%m-%dT%H:%i:%s') AS revoked_at, DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s') AS created_at, CASE WHEN revoked_at IS NOT NULL THEN '已吊销' WHEN consumed_at IS NOT NULL THEN '已开户' WHEN expires_at <= NOW() THEN '已过期' ELSE '已兑出' END AS status FROM st_beta_invites`;

export const adminDailyRouter = createRouter({
  me: publicQuery.input(tokenInput).query(async ({ input }) => {
    return guardInfra("adminDaily.me", async () => {
      const identity = cabinIdentityOf(await requireAdmin(input.token));
      return { username: identity.username, displayName: identity.displayName, cabin: identity.cabin, cabinRole: identity.cabinRole };
    });
  }),

  runtime: publicQuery.input(tokenInput).query(async ({ input }) => {
    return guardInfra("adminDaily.runtime", async () => {
      await requireAdmin(input.token);
      const factoryId = hqFactoryId();
      const db = getDb();
      const [load, tasks, revs, health, notices, dayRows] = await Promise.all([
        harnessGet(`/org/load?factoryId=${factoryId}`),
        harnessGet(`/org/tasks?factoryId=${factoryId}&limit=200`),
        harnessGet(`/reviews?factoryId=${factoryId}&status=pending&limit=20`),
        harnessGet(`/org/health?factoryId=${factoryId}`),
        harnessGet(`/notices?factoryId=${factoryId}&status=unread&limit=20`),
        db.execute(sql`SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS biz_date, UNIX_TIMESTAMP(CURDATE()) AS day_start_epoch, UNIX_TIMESTAMP(DATE_ADD(CURDATE(), INTERVAL 1 DAY)) AS day_end_epoch`),
      ]);
      const items = itemsOf(tasks);
      const revItems = itemsOf(revs);
      const healthItems = itemsOf(health);
      const noticeItems = itemsOf(notices);
      const taskTotal = tasks && items ? totalOf(tasks, items, 200) : null;
      const taskCountsComplete = tasks !== null && items !== null && taskTotal !== null && taskTotal <= items.length;
      const reviewsPending = revs && revItems ? totalOf(revs, revItems, 20) : null;
      const noticesUnread = notices && noticeItems ? totalOf(notices, noticeItems, 20) : null;
      const degraded = load === null || tasks === null || revs === null || health === null || notices === null
        || items === null || revItems === null || healthItems === null || noticeItems === null
        || !taskCountsComplete || reviewsPending === null || noticesUnread === null;
      const dayRow = rawRows(dayRows)[0] ?? {};
      const today = String(dayRow.biz_date ?? "");
      if (!today) throw new Error("CURDATE 返回空值——今日失败计数不可用");
      const dayStart = Number(dayRow.day_start_epoch);
      const dayEnd = Number(dayRow.day_end_epoch);
      const failed = taskCountsComplete && items ? items.filter((t) => t.status === "failed" && onDbDay(t.updated_at ?? t.created_at, today, dayStart, dayEnd)) : [];
      const running = (items ?? []).filter((t) => t.status === "claimed");
      const queued = (items ?? []).filter((t) => t.status === "pending");
      return {
        ok: true as const,
        workers: { online: (load?.workers ?? load?.count ?? null), load },
        degraded,
        executing: taskCountsComplete ? running.length : null,
        queued: taskCountsComplete ? queued.length : null,
        failedToday: taskCountsComplete ? failed.length : null,
        failedItems: failed.slice(0, 10).map((t) => ({ id: t.id, title: t.title, stationKey: t.station_key, retryCount: t.retry_count })),
        reviewsPending,
        health: health === null || healthItems === null ? null : healthItems,
        noticesUnread,
        costEstimate: { available: false, label: "scnet 用量 API 未接——成本不估算", chiefCalls: null, stationCalls: null, trainHours: null, amountCny: null },
      };
    });
  }),

  stats: publicQuery.input(tokenInput).query(async ({ input }) => {
    return guardInfra("adminDaily.stats", async () => {
      await requireAdmin(input.token);
      const db = getDb();
      await ensureBetaInvites();
      const t = await todayRow(db);
      const opened = rawRows(await db.execute(sql`SELECT COUNT(*) AS n FROM st_beta_invites WHERE kind=${BETA_KINDS[1]} AND consumed_at >= CURDATE() AND revoked_at IS NULL`));
      const pending = rawRows(await db.execute(sql`SELECT COUNT(*) AS n FROM st_beta_invites WHERE kind=${BETA_KINDS[1]} AND enterprise_name <> '' AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`));
      return {
        date: t.bizDate,
        codeText: t.codeText,
        quota: t.quota,
        used: t.usedCount,
        left: Math.max(0, t.quota - t.usedCount),
        redeemedToday: t.usedCount, // 只读当日口令表真实兑换计数；审批/短信签发不混入口径
        openedToday: Number(opened[0]?.n ?? 0),
        pendingIssue: Number(pending[0]?.n ?? 0),
      };
    });
  }),

  quotaSet: publicQuery
    .input(tokenInput.extend({ quota: z.number().int().min(BETA_DAILY_QUOTA_MIN).max(BETA_DAILY_QUOTA_MAX), ...reviewTokenInput.shape }))
    .mutation(async ({ input }) => {
      return guardInfra("adminDaily.quotaSet", async () => {
        const sign = await requireDualSign(input.token, input.reviewToken, "invite");
        const db = getDb();
        const before = await todayRow(db);
        const updated = await db.execute(sql`UPDATE st_beta_daily_codes SET quota = ${input.quota} WHERE id = ${before.id} AND biz_date = CURDATE()`);
        if (affectedRowsOf(updated) !== 1) throw new TRPCError({ code: "CONFLICT", message: "当日口令行已变化或跨午夜——配额未修改，请刷新后重试" });
        writeAdminAudit(sign.operatorId, sign.operator, "adminDaily.quotaSet", before.bizDate, { before: before.quota, after: input.quota, reviewer: sign.reviewer, reviewerId: sign.reviewerId });
        return { ok: true as const, quota: input.quota };
      });
    }),

  issue: publicQuery
    .input(tokenInput.extend({
      phone: z.string().trim().regex(/^1[3-9]\d{9}$/, "手机号须 11 位"),
      enterpriseName: z.string().trim().min(2).max(128),
      ttlHours: z.number().int().min(24).max(720).default(72),
    }))
    .mutation(async ({ input }) => {
      return guardInfra("adminDaily.issue", async () => {
        const actor = await requireCabinAction(input.token, "invite");
        await ensureBetaInvites();
        const ivPlain = newCredential("iv_");
        const codeHash = sha256(ivPlain);
        await withBetaInvitePhoneLock(input.phone, async (tx) => {
          const dup = rawRows(await tx.execute(sql`SELECT id FROM st_beta_invites WHERE phone = ${input.phone} AND kind = ${BETA_KINDS[1]} AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW() LIMIT 1`));
          if (dup.length > 0) throw new TRPCError({ code: "BAD_REQUEST", message: "该手机号已有未消费活码——请先吊销或待其过期" });
          await tx.execute(sql`INSERT INTO st_beta_invites (phone, codeHash, expires_at, kind, enterprise_name) VALUES (${input.phone}, ${codeHash}, DATE_ADD(NOW(), INTERVAL ${input.ttlHours} HOUR), ${BETA_KINDS[1]}, ${input.enterpriseName})`);
        });
        writeAdminAudit(actor.auditId, actor.username, "adminDaily.issue", input.enterpriseName, { phone: maskPhone(input.phone), codeHash8: codeHash.slice(0, 8), ttlHours: input.ttlHours });
        return { ok: true as const, code: ivPlain, phone: maskPhone(input.phone), enterpriseName: input.enterpriseName };
      });
    }),

  list: publicQuery
    .input(tokenInput.extend({ date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), limit: z.number().int().min(1).max(100).default(50) }))
    .query(async ({ input }) => {
      return guardInfra("adminDaily.list", async () => {
        await requireAdmin(input.token);
        const db = getDb();
        await ensureBetaInvites();
        const rows = rawRows(await db.execute(
          input.date
            ? sql`${INVITE_LIST_SELECT} WHERE kind = ${BETA_KINDS[1]} AND DATE(created_at) = ${input.date} ORDER BY id DESC LIMIT ${input.limit}`
            : sql`${INVITE_LIST_SELECT} WHERE kind = ${BETA_KINDS[1]} AND created_at >= CURDATE() ORDER BY id DESC LIMIT ${input.limit}`,
        )) as Array<Record<string, unknown>>;
        return {
          items: rows.map((r) => ({
            id: Number(r.id),
            phone: maskPhone(String(r.phone ?? "")),
            codeHash8: String(r.codeHash ?? "").slice(0, 8),
            enterpriseName: String(r.enterprise_name ?? "") || null,
            expiresAt: String(r.expires_at ?? ""),
            consumedAt: r.consumed_at ? String(r.consumed_at) : null,
            revokedAt: r.revoked_at ? String(r.revoked_at) : null,
            createdAt: String(r.created_at ?? ""),
            status: String(r.status ?? "已兑出"),
          })),
        };
      });
    }),

  revoke: publicQuery
    .input(tokenInput.extend({ id: z.number().int().positive(), ...reviewTokenInput.shape }))
    .mutation(async ({ input }) => {
      return guardInfra("adminDaily.revoke", async () => {
        const sign = await requireDualSign(input.token, input.reviewToken, "invite");
        const db = getDb();
        await ensureBetaInvites();
        const r = await db.execute(sql`UPDATE st_beta_invites SET revoked_at = NOW() WHERE id = ${input.id} AND kind = ${BETA_KINDS[1]} AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`);
        if (affectedRowsOf(r) !== 1) throw new TRPCError({ code: "BAD_REQUEST", message: "该码已开户/已吊销/已过期或不存在——仅活码可吊销" });
        writeAdminAudit(sign.operatorId, sign.operator, "adminDaily.revoke", String(input.id), { reviewer: sign.reviewer, reviewerId: sign.reviewerId });
        return { ok: true as const, id: input.id, status: "revoked" as const };
      });
    }),
});
