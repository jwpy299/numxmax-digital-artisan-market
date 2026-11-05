import { ErrorMessages } from "@contracts/constants";
import { initTRPC, TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { normalizeIpLiteral } from "./lib/clientIp";
import { getDb } from "./queries/connection";
import { recordHarnessRun } from "./harness/ledger";
import { rawRows, logQueryErrorThrottled } from "./queries/rawRows"; // 战区④批A-lite：私有副本退役→canonical 叶单源

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const createRouter = t.router;

// ─── 迭代 27 运营安全中间件（应用到全部 public procedure）────────────────────
// 约定：一切以「绝不影响业务」为最高原则——除命中 IP 封锁名单显式 FORBIDDEN 外，
// 任何存储/缓存异常一律静默 catch。

/** raw SQL 结果集行提取（drizzle mysql2 execute 返回 [rows, fields]） */

/** 从 boot 注入的 socket peer 证据取 IP；转发头不再被首跳伪造用于封锁名单/审计。 */
function clientIpOf(ctx: TrpcContext): string {
  return ctx.clientIp ?? "";
}

function headerOf(ctx: TrpcContext, name: string): string {
  try {
    return (ctx as { req?: { headers?: Headers } }).req?.headers?.get?.(name) ?? "";
  } catch {
    return "";
  }
}

// ── ① IP 封锁检查（ops_ip_blocklist，60s 内存缓存）───────────────────────────
let blockedCache: { at: number; ips: Set<string> } = { at: 0, ips: new Set() };

async function blockedIps(): Promise<Set<string>> {
  if (Date.now() - blockedCache.at < 60_000) return blockedCache.ips;
  try {
    const rows = rawRows(await getDb().execute(sql`SELECT ip FROM ops_ip_blocklist`));
    const normalized = rows.map((r) => normalizeIpLiteral(String(r.ip)));
    const invalidCount = normalized.filter((ip) => !ip).length;
    if (invalidCount > 0) logQueryErrorThrottled("[middleware] 封锁名单含无法归一化的历史行", new Error(`invalid_blocklist_rows:${invalidCount}`));
    blockedCache = { at: Date.now(), ips: new Set(normalized.filter((ip) => ip.length > 0)) };
  } catch {
    // 表缺失/库不可用：沿用旧缓存并刷新时间戳，绝不阻断业务
    blockedCache = { at: Date.now(), ips: blockedCache.ips };
  }
  return blockedCache.ips;
}

/** blockIp/unblockIp 后同步内存缓存（opsCenter 调用，避免等待 60s TTL） */
export function noteIpBlocked(ip: string): void {
  const normalized = normalizeIpLiteral(ip);
  if (normalized) blockedCache.ips.add(normalized);
}
export function noteIpUnblocked(ip: string): void {
  const normalized = normalizeIpLiteral(ip);
  if (normalized) blockedCache.ips.delete(normalized);
}

const ipBlockGuard = t.middleware(async (opts) => {
  const ip = clientIpOf(opts.ctx);
  const blocked = await blockedIps();
  if (!ip && blocked.size > 0) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "请求来源不可识别——无法核验访问限制" });
  }
  if (ip && blocked.has(ip)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "访问受限" });
  }
  return opts.next();
});

// ── ② 异步访问日志（ops_access_log，fire-and-forget，出错静默）──────────────
function writeAccessLog(entry: {
  ip: string;
  path: string;
  method: string;
  status: number;
  latencyMs: number;
  ua: string;
}): void {
  void (async () => {
    try {
      await getDb().execute(
        sql`INSERT INTO ops_access_log (ip, path, method, status, latency_ms, ua)
            VALUES (${entry.ip}, ${entry.path}, ${entry.method}, ${entry.status}, ${entry.latencyMs}, ${entry.ua})`,
      );
    } catch {
      // 表缺失/写入失败：静默
    }
  })();
}

const accessLogger = t.middleware(async (opts) => {
  const started = Date.now();
  let status = 200;
  try {
    const result = await opts.next();
    if (!result.ok) status = 500;
    return result;
  } catch (err) {
    status = 500;
    throw err;
  } finally {
    const method = (opts.ctx.req?.method ?? "POST").toUpperCase();
    writeAccessLog({
      ip: clientIpOf(opts.ctx),
      path: String(opts.path ?? "").slice(0, 128),
      method: String(method).slice(0, 16),
      status,
      latencyMs: Date.now() - started,
      ua: headerOf(opts.ctx, "user-agent").slice(0, 200),
    });
    // v150 全链登记制：每个 API 请求同时落 Harness 台账（edge 轨；fire-and-forget 不挡路）
    recordHarnessRun({
      tier: "edge",
      lane: `api:${String(opts.path ?? "")}`,
      ok: status === 200,
      durationMs: Date.now() - started,
    });
  }
});

export const publicQuery = t.procedure.use(ipBlockGuard).use(accessLogger);

const requireAuth = t.middleware(async (opts) => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: ErrorMessages.unauthenticated,
    });
  }

  return next({ ctx: { ...ctx, user: ctx.user } });
});

function requireRole(role: string) {
  return t.middleware(async (opts) => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== role) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: ErrorMessages.insufficientRole,
      });
    }

    return next({ ctx: { ...ctx, user: ctx.user } });
  });
}

export const authedQuery = t.procedure.use(requireAuth);
export const adminQuery = authedQuery.use(requireRole("admin"));
