/**
 * opsCenter —— 迭代 27「运营中心」服务端路由（契约 §2，全部 requireAdmin）。
 *
 * 数据源（db/sync-ops.mts 幂等创建，一律 raw SQL 访问）：
 * - ops_access_log     tRPC 访问日志（api/middleware.ts fire-and-forget 写入）
 * - ops_ip_blocklist   IP 封锁名单（middleware 60s 内存缓存，block/unblock 后同步缓存）
 * - ops_vulns          漏洞/异常发现（dedup_key 唯一去重）
 * - cs_config          智能客服配置（单行 id=1；assistant.ts 30s 内存缓存读取）
 *
 * LLM 全部走 modelGateway.callSlotChat（flash/brain/orggen 槽位）；
 * 失败静默降级为规则模板文本，错误原因绝不回传前端。
 */
import { z } from "zod";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery, noteIpBlocked, noteIpUnblocked } from "../middleware";
import { normalizeIpLiteral } from "../lib/clientIp";
import { getDb } from "../queries/connection";
import { rawRows, requireAdmin } from "./terminal";
import { callSlotChat, getSlotAssignments } from "./modelGateway";
import { getSkillToolStats } from "./agentTools";
import { writeAdminAudit, adminDisplayName } from "./adminAnalytics";
import { invalidateCsConfigCache } from "./assistant";

const tokenInput = z.object({ token: z.string().trim().min(1) });

/** 项目根（api/routers/opsCenter.ts → 上两级） */
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** 访问日志 401/403 视为鉴权失败，>=500 视为服务端错误 */
const AUTH_FAIL_COND = `status IN (401, 403)`;
const SERVER_ERR_COND = `status >= 500`;

/** 迭代 29：三端被监控服务器定义（采集脚本 SERVER_NAME 与此一致） */
const OPS_SERVERS = [
  { server: "portal", service: "nebula" },
  { server: "workbench", service: "lingshu-workbench" },
  { server: "admin", service: "nebula-admin" },
] as const;

// ─── overview / suspiciousIps 共用的统计查询 ────────────────────────────────
interface TodayStats {
  requests: number;
  errors: number;
  uniqueIps: number;
  signups: number;
  orders: number;
  paidOrders: number;
}

async function safeRows(statement: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  try {
    return rawRows(await getDb().execute(statement));
  } catch {
    return []; // 表缺失/库不可用：按零统计降级
  }
}

async function loadTodayStats(): Promise<TodayStats> {
  const [logRows, signupRows, orderRows] = await Promise.all([
    safeRows(
      sql`SELECT COUNT(*) AS requests,
                 COALESCE(SUM(${sql.raw(SERVER_ERR_COND)}), 0) AS errors,
                 COUNT(DISTINCT ip) AS unique_ips
          FROM ops_access_log WHERE ts >= CURDATE()`,
    ),
    safeRows(sql`SELECT COUNT(*) AS c FROM wb_users WHERE DATE(createdAt) = CURDATE()`),
    safeRows(
      sql`SELECT COUNT(*) AS orders,
                 COALESCE(SUM(status IN ('paid','configured')), 0) AS paid_orders
          FROM pkg_orders WHERE created_at >= CURDATE()`,
    ),
  ]);
  return {
    requests: Number(logRows[0]?.requests ?? 0),
    errors: Number(logRows[0]?.errors ?? 0),
    uniqueIps: Number(logRows[0]?.unique_ips ?? 0),
    signups: Number(signupRows[0]?.c ?? 0),
    orders: Number(orderRows[0]?.orders ?? 0),
    paidOrders: Number(orderRows[0]?.paid_orders ?? 0),
  };
}

interface SuspiciousIp {
  ip: string;
  reqCount1h: number;
  errCount1h: number;
  score: number;
  reasons: string[];
  blocked: boolean;
}

async function loadSuspiciousIps(): Promise<SuspiciousIp[]> {
  const db = getDb();
  let rows: Array<Record<string, unknown>> = [];
  let blockedSet = new Set<string>();
  try {
    rows = rawRows(
      await db.execute(
        sql`SELECT ip,
                   COUNT(*) AS req_count,
                   COALESCE(SUM(${sql.raw(AUTH_FAIL_COND)}), 0) AS auth_fails,
                   COALESCE(SUM(${sql.raw(SERVER_ERR_COND)}), 0) AS server_errs
            FROM ops_access_log
            WHERE ts >= DATE_SUB(NOW(), INTERVAL 1 HOUR) AND ip <> ''
            GROUP BY ip
            HAVING auth_fails > 0 OR server_errs > 0 OR req_count >= 120
            ORDER BY req_count DESC LIMIT 100`,
      ),
    );
  } catch {
    return [];
  }
  try {
    const blocked = rawRows(await db.execute(sql`SELECT ip FROM ops_ip_blocklist`));
    blockedSet = new Set(blocked.map((r) => normalizeIpLiteral(String(r.ip))).filter((ip) => ip.length > 0));
  } catch {
    // 名单表缺失：按未封锁处理
  }
  return rows
    .map((r) => {
      const reqCount1h = Number(r.req_count ?? 0);
      const authFails = Number(r.auth_fails ?? 0);
      const serverErrs = Number(r.server_errs ?? 0);
      const errCount1h = authFails + serverErrs;
      const reasons: string[] = [];
      let score = 0;
      if (authFails >= 20) {
        score += 40;
        reasons.push(`1小时内鉴权失败 ${authFails} 次`);
      } else if (authFails >= 5) {
        score += 20;
        reasons.push(`1小时内鉴权失败 ${authFails} 次`);
      }
      if (serverErrs >= 10) {
        score += 25;
        reasons.push(`1小时内触发服务端错误 ${serverErrs} 次`);
      }
      if (reqCount1h >= 600) {
        score += 30;
        reasons.push(`1小时内请求 ${reqCount1h} 次（疑似爬取/爆破）`);
      } else if (reqCount1h >= 120) {
        score += 15;
        reasons.push(`1小时内请求 ${reqCount1h} 次（频率偏高）`);
      }
      if (authFails > 0 && reqCount1h > 0 && authFails / reqCount1h > 0.5) {
        score += 15;
        reasons.push("错误率超过 50%");
      }
      return {
        ip: normalizeIpLiteral(String(r.ip)) || String(r.ip),
        reqCount1h,
        errCount1h,
        score: Math.min(100, score),
        reasons,
        blocked: blockedSet.has(normalizeIpLiteral(String(r.ip))),
      };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);
}

// ─── securityReport 10 分钟内存缓存（模块级）─────────────────────────────────
let reportCache: { at: number; report: string } = { at: 0, report: "" };
const REPORT_TTL_MS = 10 * 60 * 1000;

// ─── npm audit 解析 ─────────────────────────────────────────────────────────
interface AuditVuln {
  name: string;
  severity: string;
  title: string;
  detail: string;
}

function runNpmAudit(): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "npm",
      ["audit", "--json"],
      { cwd: PROJECT_ROOT, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (_err, stdout) => resolve(stdout || ""), // 有漏洞时 exit code 非零，仍解析 stdout
    );
  });
}

function parseAuditVulns(jsonText: string): AuditVuln[] {
  try {
    const data = JSON.parse(jsonText) as {
      vulnerabilities?: Record<
        string,
        { severity?: string; via?: Array<string | { title?: string; url?: string }>; fixAvailable?: unknown }
      >;
    };
    const out: AuditVuln[] = [];
    for (const [name, v] of Object.entries(data.vulnerabilities ?? {})) {
      const severity = String(v.severity ?? "").toLowerCase();
      if (severity !== "high" && severity !== "critical") continue;
      const viaTitles = (v.via ?? [])
        .map((x) => (typeof x === "string" ? x : x.title ?? ""))
        .filter(Boolean);
      out.push({
        name,
        severity,
        title: `依赖漏洞：${name}${viaTitles[0] ? `（${viaTitles[0]}）` : ""}`,
        detail: `npm audit 检出 ${severity} 级依赖漏洞，包名 ${name}。${
          viaTitles.length ? `关联公告：${viaTitles.join("；")}。` : ""
        }${v.fixAvailable ? "官方已提供修复版本，建议升级。" : "暂无官方修复版本，建议关注公告并评估缓解措施。"}`,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ─── 路由 ────────────────────────────────────────────────────────────────────
export const opsCenterRouter = createRouter({
  /** overview（query）：今日统计 + 7 日趋势 + LLM 槽位状态 */
  overview: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const [today, logTrend, signupTrend, orderTrend] = await Promise.all([
      loadTodayStats(),
      safeRows(
        sql`SELECT DATE(ts) AS d, COUNT(*) AS requests,
                   COALESCE(SUM(${sql.raw(SERVER_ERR_COND)}), 0) AS errors
            FROM ops_access_log WHERE ts >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
            GROUP BY DATE(ts)`,
      ),
      safeRows(
        sql`SELECT DATE(createdAt) AS d, COUNT(*) AS c FROM wb_users
            WHERE createdAt >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) GROUP BY DATE(createdAt)`,
      ),
      safeRows(
        sql`SELECT DATE(created_at) AS d, COUNT(*) AS c FROM pkg_orders
            WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) GROUP BY DATE(created_at)`,
      ),
    ]);
    const toMap = (rows: Array<Record<string, unknown>>, key: string) => {
      const m = new Map<string, number>();
      for (const r of rows) {
        const d = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10);
        m.set(d, Number(r[key] ?? 0));
      }
      return m;
    };
    const reqMap = toMap(logTrend, "requests");
    const errMap = toMap(logTrend, "errors");
    const signupMap = toMap(signupTrend, "c");
    const orderMap = toMap(orderTrend, "c");
    const trend7d: Array<{ date: string; requests: number; errors: number; signups: number; orders: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 3600 * 1000);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      trend7d.push({
        date: key,
        requests: reqMap.get(key) ?? 0,
        errors: errMap.get(key) ?? 0,
        signups: signupMap.get(key) ?? 0,
        orders: orderMap.get(key) ?? 0,
      });
    }
    // 北极星：周均产出物采纳率（B1 反馈环数据源；st_artifact_feedback 不存在时降级为零）
    const fb = await safeRows(
      sql`SELECT fb_signal AS fbSignal, COUNT(*) AS c FROM st_artifact_feedback
          WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY fb_signal`,
    );
    const weekAdopted = Number(fb.find((r) => String(r.fbSignal) === "adopted")?.c ?? 0);
    const weekRejected = Number(fb.find((r) => String(r.fbSignal) === "rejected")?.c ?? 0);
    const fbTotal = weekAdopted + weekRejected;
    return {
      today,
      trend7d,
      llm: getSlotAssignments().map((s) => ({ slot: s.slot, model: s.model, verified: s.verified })),
      skillTools: getSkillToolStats(),
      northStar: {
        weekAdopted,
        weekRejected,
        adoptRate: fbTotal === 0 ? null : Math.round((weekAdopted / fbTotal) * 1000) / 10,
      },
    };
  }),

  /** accessLog（query）：分页 50 条/页，倒序，支持 path/ip 过滤 */
  accessLog: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        page: z.number().int().min(1).default(1),
        path: z.string().trim().max(128).optional(),
        ip: z.string().trim().max(64).optional(),
      }),
    )
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const page = input.page ?? 1;
      const offset = (page - 1) * 50;
      const filterIp = input.ip ? normalizeIpLiteral(input.ip) : "";
      if (input.ip && !filterIp) throw new TRPCError({ code: "BAD_REQUEST", message: "IP 格式不正确" });
      const cond = sql`WHERE 1=1
        ${input.path ? sql`AND path LIKE ${`%${input.path}%`}` : sql``}
        ${filterIp ? sql`AND ip = ${filterIp}` : sql``}`;
      const [rows, totalRows] = await Promise.all([
        safeRows(
          sql`SELECT id, ts, ip, path, method, status, latency_ms, ua
              FROM ops_access_log ${cond} ORDER BY id DESC LIMIT 50 OFFSET ${offset}`,
        ),
        safeRows(sql`SELECT COUNT(*) AS c FROM ops_access_log ${cond}`),
      ]);
      return {
        rows: rows.map((r) => ({
          id: Number(r.id),
          ts: r.ts ? new Date(String(r.ts)) : null,
          ip: String(r.ip ?? ""),
          path: String(r.path ?? ""),
          method: String(r.method ?? ""),
          status: Number(r.status ?? 0),
          latencyMs: Number(r.latency_ms ?? 0),
          ua: String(r.ua ?? ""),
        })),
        total: Number(totalRows[0]?.c ?? 0),
      };
    }),

  /** suspiciousIps（query）：近 1 小时聚集分析 + 规则评分 */
  suspiciousIps: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    return loadSuspiciousIps();
  }),

  /** blockIp（mutation）：加入封锁名单并同步内存缓存 */
  blockIp: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        ip: z.string().trim().min(1).max(64),
        reason: z.string().trim().max(255).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const ip = normalizeIpLiteral(input.ip);
      if (!ip) throw new TRPCError({ code: "BAD_REQUEST", message: "IP 格式不正确" });
      const user = await requireAdmin(input.token);
      await getDb().execute(
        sql`INSERT INTO ops_ip_blocklist (ip, reason, created_by)
            VALUES (${ip}, ${input.reason ?? ""}, ${user.username})
            ON DUPLICATE KEY UPDATE reason = VALUES(reason), created_by = VALUES(created_by)`,
      );
      noteIpBlocked(ip);
      writeAdminAudit(Number(user.id), adminDisplayName(user), "opsCenter.blockIp", ip, {
        reason: input.reason ?? null,
      });
      return { ok: true as const };
    }),

  /** unblockIp（mutation）：移出封锁名单并同步内存缓存 */
  unblockIp: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        ip: z.string().trim().min(1).max(64),
      }),
    )
    .mutation(async ({ input }) => {
      const ip = normalizeIpLiteral(input.ip);
      if (!ip) throw new TRPCError({ code: "BAD_REQUEST", message: "IP 格式不正确" });
      await requireAdmin(input.token);
      const db = getDb();
      await db.transaction(async (tx) => {
        const legacyRows = rawRows(await tx.execute(sql`SELECT id, ip FROM ops_ip_blocklist FOR UPDATE`));
        const ids = legacyRows.filter((r) => normalizeIpLiteral(String(r.ip)) === ip).map((r) => Number(r.id)).filter((id) => Number.isSafeInteger(id) && id > 0);
        if (ids.length > 0) await tx.execute(sql`DELETE FROM ops_ip_blocklist WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
      });
      noteIpUnblocked(ip);
      return { ok: true as const };
    }),

  /** assessIp（mutation）：flash 槽（kimi-k3）研判，失败降级规则文本 */
  assessIp: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        ip: z.string().trim().min(1).max(64),
      }),
    )
    .mutation(async ({ input }) => {
      const ip = normalizeIpLiteral(input.ip);
      if (!ip) throw new TRPCError({ code: "BAD_REQUEST", message: "IP 格式不正确" });
      await requireAdmin(input.token);
      const stats = await safeRows(
        sql`SELECT COUNT(*) AS req24,
                   COALESCE(SUM(${sql.raw(AUTH_FAIL_COND)}), 0) AS auth24,
                   COALESCE(SUM(${sql.raw(SERVER_ERR_COND)}), 0) AS err24,
                   COUNT(DISTINCT path) AS paths24
            FROM ops_access_log WHERE ip = ${ip} AND ts >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
      );
      const topPaths = await safeRows(
        sql`SELECT path, COUNT(*) AS c FROM ops_access_log
            WHERE ip = ${ip} AND ts >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            GROUP BY path ORDER BY c DESC LIMIT 5`,
      );
      const s = stats[0] ?? {};
      const summary = [
        `近24小时请求 ${Number(s.req24 ?? 0)} 次`,
        `鉴权失败 ${Number(s.auth24 ?? 0)} 次`,
        `服务端错误 ${Number(s.err24 ?? 0)} 次`,
        `涉及路径 ${Number(s.paths24 ?? 0)} 个`,
        `高频路径：${topPaths.map((p) => `${String(p.path)}(${Number(p.c)})`).join("、") || "无"}`,
      ].join("；");
      const fallback =
        `规则研判：IP ${ip} ${summary}` +
        (Number(s.auth24 ?? 0) >= 20
          ? "鉴权失败聚集，疑似凭证爆破，建议立即封锁并核查账号安全。"
          : Number(s.err24 ?? 0) >= 10
            ? "服务端错误聚集，疑似恶意探测或异常客户端，建议持续观察。"
            : Number(s.req24 ?? 0) >= 600
              ? "请求频率显著偏高，疑似自动化脚本，建议限流或封锁。"
              : "行为未见明显异常，建议保持观察。");
      try {
        const res = await callSlotChat("flash", {
          messages: [
            {
              role: "system",
              content:
                "你是平台安全运营专家。根据给定的 IP 访问摘要，用中文输出 3-5 句研判结论：行为画像、风险等级（低/中/高）、处置建议。务实简洁，不编造数据。",
            },
            { role: "user", content: `IP：${input.ip}\n访问摘要：${summary}` },
          ],
          maxTokens: 500,
          timeoutMs: 30_000,
        });
        if (res.ok && res.content) {
          return { ip: input.ip, assessment: res.content };
        }
      } catch {
        // 静默降级
      }
      return { ip: input.ip, assessment: fallback };
    }),

  /** securityReport（mutation）：brain 槽（kimi-k3）生成中文安全态势报告，10 分钟内存缓存 */
  securityReport: publicQuery.input(tokenInput).mutation(async ({ input }) => {
    await requireAdmin(input.token);
    if (reportCache.report && Date.now() - reportCache.at < REPORT_TTL_MS) {
      return { report: reportCache.report, cachedAt: new Date(reportCache.at) };
    }
    const [today, suspicious] = await Promise.all([loadTodayStats(), loadSuspiciousIps()]);
    const suspiciousDigest =
      suspicious.length > 0
        ? suspicious
            .slice(0, 10)
            .map((r) => `${r.ip}（评分${r.score}，${r.blocked ? "已封锁" : "未封锁"}：${r.reasons.join("；")}）`)
            .join("\n")
        : "无可疑 IP";
    const statsDigest = `今日请求 ${today.requests}，错误 ${today.errors}，独立 IP ${today.uniqueIps}，注册 ${today.signups}，套餐订单 ${today.orders}（已支付/已配置 ${today.paidOrders}）`;
    let report = "";
    try {
      const res = await callSlotChat("brain", {
        messages: [
          {
            role: "system",
            content:
              "你是 NumX Max 平台的安全运营官。根据今日访问统计与可疑 IP 摘要，生成中文安全态势报告：①总体态势一句话；②主要风险点（分点）；③处置建议（分点，可执行）。务实、不编造、不超过 500 字。",
          },
          { role: "user", content: `今日统计：${statsDigest}\n可疑 IP：\n${suspiciousDigest}` },
        ],
        maxTokens: 1200,
        timeoutMs: 45_000,
      });
      if (res.ok && res.content) report = res.content;
    } catch {
      // 静默降级
    }
    if (!report) {
      report = [
        `【安全态势报告（规则生成）】`,
        `总体态势：${statsDigest}。`,
        `可疑 IP：当前识别 ${suspicious.length} 个，其中已封锁 ${suspicious.filter((r) => r.blocked).length} 个。`,
        suspicious.length > 0
          ? `重点关注：${suspicious
              .slice(0, 3)
              .map((r) => `${r.ip}（评分${r.score}）`)
              .join("、")}。`
          : "暂无高评分可疑 IP。",
        `处置建议：对评分 ≥40 且未封锁的 IP 执行封锁；持续关注鉴权失败聚集路径；每日复核本报告。`,
      ].join("\n");
    }
    reportCache = { at: Date.now(), report };
    return { report, cachedAt: new Date(reportCache.at) };
  }),

  /** vulnScan（mutation）：npm audit --json + 访问日志规则扫描，写入 ops_vulns 去重 */
  vulnScan: publicQuery.input(tokenInput).mutation(async ({ input }) => {
    await requireAdmin(input.token);
    const db = getDb();
    const findings: Array<{ source: string; severity: string; title: string; detail: string; dedupKey: string }> = [];

    // ① npm audit（high/critical）
    const auditOut = await runNpmAudit();
    for (const v of parseAuditVulns(auditOut)) {
      findings.push({
        source: "npm_audit",
        severity: v.severity,
        title: v.title,
        detail: v.detail,
        dedupKey: `npm:${v.name}`,
      });
    }

    // ② 规则扫描：最近 24h 401/403/500 聚集的 path
    const authPaths = await safeRows(
      sql`SELECT path, COUNT(*) AS c FROM ops_access_log
          WHERE ts >= DATE_SUB(NOW(), INTERVAL 24 HOUR) AND ${sql.raw(AUTH_FAIL_COND)} AND path <> ''
          GROUP BY path HAVING c >= 20 ORDER BY c DESC LIMIT 20`,
    );
    for (const r of authPaths) {
      findings.push({
        source: "log_rule",
        severity: "low",
        title: `鉴权失败聚集路径：${String(r.path)}`,
        detail: `最近 24 小时该路径产生 ${Number(r.c)} 次 401/403 响应，疑似越权探测或异常客户端，建议核查调用方并考虑限流。`,
        dedupKey: `log:auth:${String(r.path)}`,
      });
    }
    const errPaths = await safeRows(
      sql`SELECT path, COUNT(*) AS c FROM ops_access_log
          WHERE ts >= DATE_SUB(NOW(), INTERVAL 24 HOUR) AND ${sql.raw(SERVER_ERR_COND)} AND path <> ''
          GROUP BY path HAVING c >= 10 ORDER BY c DESC LIMIT 20`,
    );
    for (const r of errPaths) {
      findings.push({
        source: "log_rule",
        severity: "medium",
        title: `服务端错误聚集路径：${String(r.path)}`,
        detail: `最近 24 小时该路径产生 ${Number(r.c)} 次 5xx 响应，可能存在可利用的未处理异常或稳定性缺陷，建议优先排查服务端日志。`,
        dedupKey: `log:err:${String(r.path)}`,
      });
    }

    // 去重写入（dedup_key 唯一，已存在不新增）
    let added = 0;
    for (const f of findings) {
      const exists = await safeRows(
        sql`SELECT id FROM ops_vulns WHERE dedup_key = ${f.dedupKey} LIMIT 1`,
      );
      if (exists.length > 0) continue;
      try {
        await db.execute(
          sql`INSERT INTO ops_vulns (source, severity, title, detail, status, dedup_key)
              VALUES (${f.source}, ${f.severity}, ${f.title}, ${f.detail}, 'open', ${f.dedupKey})`,
        );
        added += 1;
      } catch {
        // 唯一键竞争等异常：跳过
      }
    }
    const totalRows = await safeRows(sql`SELECT COUNT(*) AS c FROM ops_vulns`);
    const total = Number(totalRows[0]?.c ?? 0);
    const summary = `扫描完成：npm audit 检出 ${findings.filter((f) => f.source === "npm_audit").length} 项 high/critical 依赖漏洞，规则扫描检出 ${
      findings.filter((f) => f.source === "log_rule").length
    } 项日志异常；本次新增 ${added} 项，库内累计 ${total} 项。`;
    return { scanned: true as const, added, total, summary };
  }),

  /** vulnList（query）：漏洞/异常列表，可按状态过滤 */
  vulnList: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        status: z.enum(["open", "fixing", "fixed", "ignored"]).optional(),
      }),
    )
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const rows = await safeRows(
        sql`SELECT id, source, severity, title, detail, status, plan, created_at
            FROM ops_vulns
            ${input.status ? sql`WHERE status = ${input.status}` : sql``}
            ORDER BY id DESC LIMIT 200`,
      );
      return rows.map((r) => ({
        id: Number(r.id),
        source: String(r.source),
        severity: String(r.severity),
        title: String(r.title),
        detail: String(r.detail ?? ""),
        status: String(r.status),
        plan: r.plan === null || r.plan === undefined ? null : String(r.plan),
        createdAt: r.created_at ? new Date(String(r.created_at)) : null,
      }));
    }),

  /** vulnPlan（mutation）：orggen 槽（deepseek-v4-pro）出结构化修复方案并保存 */
  vulnPlan: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        vulnId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      const rows = await safeRows(
        sql`SELECT id, source, severity, title, detail FROM ops_vulns WHERE id = ${input.vulnId} LIMIT 1`,
      );
      const vuln = rows[0];
      if (!vuln) {
        throw new TRPCError({ code: "NOT_FOUND", message: "漏洞记录不存在" });
      }
      let plan = "";
      try {
        const res = await callSlotChat("orggen", {
          messages: [
            {
              role: "system",
              content:
                "你是资深安全工程师。针对给定漏洞/异常，输出中文结构化修复方案，严格按以下小节：一、风险分析；二、修复步骤（编号列表，含具体命令或代码改动）；三、验证方式；四、临时缓解措施。务实可执行。",
            },
            {
              role: "user",
              content: `来源：${String(vuln.source)}\n级别：${String(vuln.severity)}\n标题：${String(vuln.title)}\n详情：${String(vuln.detail ?? "")}`,
            },
          ],
          maxTokens: 1500,
          timeoutMs: 60_000,
        });
        if (res.ok && res.content) plan = res.content;
      } catch {
        // 静默降级
      }
      if (!plan) {
        plan = [
          `【修复方案（规则模板）】`,
          `一、风险分析：${String(vuln.title)}（${String(vuln.severity)} 级，来源 ${String(vuln.source)}）。`,
          `二、修复步骤：1. 定位受影响组件/路径；2. 依赖类漏洞执行 npm audit fix 或手动升级至安全版本并回归测试；日志类异常排查对应接口的服务端错误与鉴权逻辑；3. 复扫确认。`,
          `三、验证方式：重新执行漏洞扫描（opsCenter.vulnScan），确认该项不再新增且现有项可置为 fixed。`,
          `四、临时缓解措施：对异常路径实施限流/封锁可疑 IP，必要时临时下线受影响功能。`,
        ].join("\n");
      }
      await db.execute(
        sql`UPDATE ops_vulns SET plan = ${plan} WHERE id = ${input.vulnId}`,
      );
      return { vulnId: input.vulnId, plan };
    }),

  /** vulnSetStatus（mutation）：更新漏洞状态 */
  vulnSetStatus: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        vulnId: z.number().int().positive(),
        status: z.enum(["open", "fixing", "fixed", "ignored"]),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      await getDb().execute(
        sql`UPDATE ops_vulns SET status = ${input.status} WHERE id = ${input.vulnId}`,
      );
      writeAdminAudit(Number(admin.id), adminDisplayName(admin), "opsCenter.vulnSetStatus", String(input.vulnId), {
        status: input.status,
      });
      return { ok: true as const };
    }),

  /** getCsConfig（query）：智能客服配置（无配置返回空串默认） */
  getCsConfig: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const rows = await safeRows(
      sql`SELECT welcome, persona_prompt, handoff_hint FROM cs_config WHERE id = 1 LIMIT 1`,
    );
    const row = rows[0];
    return {
      welcome: row?.welcome ? String(row.welcome) : "",
      personaPrompt: row?.persona_prompt ? String(row.persona_prompt) : "",
      handoffHint: row?.handoff_hint ? String(row.handoff_hint) : "",
    };
  }),

  /** saveCsConfig（mutation）：upsert id=1，并使 assistant 的 30s 缓存立即失效 */
  saveCsConfig: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        welcome: z.string().trim().max(2000),
        personaPrompt: z.string().trim().max(4000),
        handoffHint: z.string().trim().max(1000),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      await getDb().execute(
        sql`INSERT INTO cs_config (id, welcome, persona_prompt, handoff_hint)
            VALUES (1, ${input.welcome}, ${input.personaPrompt}, ${input.handoffHint})
            ON DUPLICATE KEY UPDATE
              welcome = VALUES(welcome), persona_prompt = VALUES(persona_prompt),
              handoff_hint = VALUES(handoff_hint)`,
      );
      invalidateCsConfigCache();
      return { ok: true as const };
    }),

  /** healthLatest（query，迭代 29）：三端服务器各指标最新一行 + 总体状态 */
  healthLatest: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const rows = await safeRows(
      sql`SELECT h.server, h.metric, h.value, h.status, h.ts
          FROM ops_health_checks h
          JOIN (
            SELECT server, metric, MAX(ts) AS max_ts
            FROM ops_health_checks GROUP BY server, metric
          ) m ON m.server = h.server AND m.metric = h.metric AND m.max_ts = h.ts`,
    );
    const byKey = new Map<string, Record<string, unknown>>();
    for (const r of rows) byKey.set(`${String(r.server)}:${String(r.metric)}`, r);
    const servers = OPS_SERVERS.map((def) => {
      const get = (metric: string) => byKey.get(`${def.server}:${metric}`);
      const httpRow = get("http");
      const svcRow = get("service");
      const memRow = get("mem");
      const loadRow = get("load");
      const diskRow = get("disk");
      const tsOf = (r: Record<string, unknown> | undefined) => (r?.ts ? new Date(String(r.ts)) : null);
      const httpParts = String(httpRow?.value ?? "").split("|"); // 采集格式：code|latencyMs
      const http = {
        code: httpRow ? Number(httpParts[0] ?? 0) : 0,
        latencyMs: httpRow ? Number(httpParts[1] ?? 0) : 0,
        ts: tsOf(httpRow),
      };
      const mem = { pct: memRow ? Number(String(memRow.value)) : 0, ts: tsOf(memRow) };
      const load = { avg: loadRow ? Number(String(loadRow.value)) : 0, ts: tsOf(loadRow) };
      const disk = { pct: diskRow ? Number(String(diskRow.value)) : 0, ts: tsOf(diskRow) };
      // 5 分钟无任何数据 → down；任一指标非 ok 或 HTTP 非 200 → warn
      const latestTs = [http.ts, mem.ts, load.ts, disk.ts, tsOf(svcRow)]
        .filter((t): t is Date => t instanceof Date)
        .reduce<number>((max, t) => Math.max(max, t.getTime()), 0);
      let overall: "ok" | "warn" | "down" = "ok";
      if (!latestTs || Date.now() - latestTs > 5 * 60 * 1000) {
        overall = "down";
      } else if (
        [httpRow, svcRow, memRow, loadRow, diskRow].some((r) => r && String(r.status) !== "ok") ||
        (httpRow && http.code !== 200)
      ) {
        overall = "warn";
      }
      return {
        server: def.server,
        service: def.service,
        http,
        mem,
        load,
        disk,
        overall,
        latestTs: latestTs ? new Date(latestTs).toISOString() : null,
      };
    });
    return { servers };
  }),

  /** alerts（query，迭代 29）：预警列表，状态筛选，100 条倒序 */
  alerts: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        status: z.enum(["open", "ack", "resolved", "all"]).optional().default("open"),
      }),
    )
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const cond = input.status && input.status !== "all" ? sql`WHERE status = ${input.status}` : sql``;
      const [rows, totalRows] = await Promise.all([
        safeRows(
          sql`SELECT id, server, severity, title, detail, status, created_at
              FROM ops_alerts ${cond} ORDER BY id DESC LIMIT 100`,
        ),
        safeRows(sql`SELECT COUNT(*) AS c FROM ops_alerts ${cond}`),
      ]);
      return {
        rows: rows.map((r) => ({
          id: Number(r.id),
          server: String(r.server ?? ""),
          severity: String(r.severity ?? ""),
          title: String(r.title ?? ""),
          detail: r.detail == null ? "" : String(r.detail),
          status: String(r.status ?? "open"),
          createdAt: r.created_at ? new Date(String(r.created_at)) : null,
        })),
        total: Number(totalRows[0]?.c ?? 0),
      };
    }),

  /** alertSetStatus（mutation，迭代 29）：ack 写 ack_at，resolved 写 resolved_at */
  alertSetStatus: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        alertId: z.number().int().positive(),
        status: z.enum(["ack", "resolved"]),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      if (input.status === "ack") {
        await getDb().execute(
          sql`UPDATE ops_alerts SET status = 'ack', ack_at = NOW() WHERE id = ${input.alertId}`,
        );
      } else {
        await getDb().execute(
          sql`UPDATE ops_alerts SET status = 'resolved', resolved_at = NOW() WHERE id = ${input.alertId}`,
        );
      }
      writeAdminAudit(Number(admin.id), adminDisplayName(admin), "opsCenter.alertSetStatus", String(input.alertId), {
        status: input.status,
      });
      return { ok: true as const };
    }),

  /** csSessions（query，迭代 28）：客服访客会话列表，50/页，last_at 倒序 */
  csSessions: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        page: z.number().int().min(1).optional().default(1),
      }),
    )
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const page = input.page ?? 1;
      const offset = (page - 1) * 50;
      const totalRows = await safeRows(sql`SELECT COUNT(*) AS c FROM cs_sessions`);
      const rows = await safeRows(
        sql`SELECT s.session_key, s.ip, s.ua, s.first_at, s.last_at, s.msg_count,
              (SELECT m.content FROM cs_messages m WHERE m.session_key = s.session_key
                ORDER BY m.id DESC LIMIT 1) AS last_message
            FROM cs_sessions s ORDER BY s.last_at DESC LIMIT 50 OFFSET ${offset}`,
      );
      return {
        rows: rows.map((r) => ({
          sessionKey: String(r.session_key),
          ip: String(r.ip ?? ""),
          ua: String(r.ua ?? ""),
          firstAt: r.first_at,
          lastAt: r.last_at,
          msgCount: Number(r.msg_count ?? 0),
          lastMessage: r.last_message == null ? "" : String(r.last_message).slice(0, 120),
        })),
        total: Number(totalRows[0]?.c ?? 0),
      };
    }),

  /** csSessionDetail（query，迭代 28）：单会话对话时间线（ts 升序，最多 200 条） */
  csSessionDetail: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        sessionKey: z.string().trim().min(1).max(64),
      }),
    )
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const rows = await safeRows(
        sql`SELECT role, content, intent, ts FROM cs_messages
            WHERE session_key = ${input.sessionKey} ORDER BY ts ASC, id ASC LIMIT 200`,
      );
      return {
        sessionKey: input.sessionKey,
        messages: rows.map((r) => ({
          role: String(r.role),
          content: r.content == null ? "" : String(r.content),
          intent: r.intent == null ? null : String(r.intent),
          ts: r.ts,
        })),
      };
    }),
});
