/**
 * adminAnalytics —— 迭代 35 批次A「管理后台数据分析 + 运营工单 + 审计」（API-CONTRACT-v6）。
 *
 * 7 个 query procedure（全部 requireAdmin，token 仅请求体，tRPC query=GET）：
 * - funnel        六层转化漏斗（registered→factories→entitled→firstTask→active7d→repurchase），
 *                 每层注明口径；表/列不存在时该层 count=null + note，绝不抛错
 * - revenueTrend  按日聚合 st_pack_purchases（shopGmv/platformShare）+ token_transactions（tokenFlow）
 * - supplySide    供给侧：agents 雇佣率 + packs 动销率 + TOP 榜
 * - factoryHealth 企业健康度（确定性分数公式，见 factoryHealth 注释）
 * - evoBoard      进化看板（st_evo_proposals / st_agent_skills / st_skill_feedback）
 * - todoQueue     今日待办工单聚合（待审/沉默企业/预警/48h 未确权）
 * - auditList     st_admin_audit 倒序
 *
 * 审计：writeAdminAudit 导出供其他 admin mutation fire-and-forget 调用（失败静默，绝不阻塞业务）。
 *
 * 表/列口径备注：
 * - wb_users 无 lastLoginAt 类字段：active7d 用 st_skill_feedback.created_at +
 *   tasks.createdAt（近 7 天有反馈或任务的企业）近似，note 写明；
 * - tasks / agent_hire_records / token_transactions 的 enterpriseId 指向 enterprises 表，
 *   与 wb_factories.id 非同一域，相关层在 note 中标注按 enterpriseId 口径统计。
 */
import { z } from "zod";
import mysql from "mysql2/promise";
import { logQueryErrorThrottled } from "../queries/rawRows";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows } from "../queries/rawRows"; // canonical 直引（A 堆对齐①——不经 ./terminal 中转[portal#31 循环断链教训面]）
import { requireAdmin } from "./terminal"; // requireAdmin 暂留 terminal 面（委派回退差异——adminGate 对齐挂账 P-ADMIN-GATE-ALIGN）

const tokenInput = z.object({ token: z.string().trim().min(1) });

const toDate = (v: unknown) => (v ? new Date(String(v)) : null);

/** 容错查询：表/列缺失或任意 SQL 错误时返回 null（调用方降级 count=null + note，绝不抛错） */
async function tryRows(statement: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>> | null> {
  try {
    return rawRows(await getDb().execute(statement));
  } catch {
    return null;
  }
}

/** 单层计数：失败 → { count: null, note } */
async function tryCount(statement: ReturnType<typeof sql>, note: string): Promise<{ count: number | null; note: string }> {
  const rows = await tryRows(statement);
  if (!rows || !rows[0]) return { count: null, note: `${note}（查询失败/表不存在，按 null 降级）` };
  return { count: Number(rows[0].c ?? 0), note };
}

// ─── 审计写入 ────────────────────────────────────────────────────────────────

interface AuditConnection {
  query(sql: string, params?: unknown[]): Promise<unknown>
  end(): Promise<void>
  destroy(): void
}

/** 清理和 KILL 都有界；迟到的 reject 已挂 catch，不会形成未处理 rejection。 */
async function settleAudit(promise: Promise<unknown>, budgetMs = 250): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      promise.catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs); timer.unref?.() }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}

class AdminAuditOperation {
  private connection?: AuditConnection
  private killer?: AuditConnection
  private threadId = 0
  private closed = false

  private readonly url: string
  private readonly values: [number, string, string, string, string | null]

  constructor(url: string, values: [number, string, string, string, string | null]) {
    this.url = url
    this.values = values
  }

  private async open(slot: 'connection' | 'killer'): Promise<AuditConnection | null> {
    const connection = await mysql.createConnection(this.url) as unknown as AuditConnection
    if (this.closed) {
      await settleAudit(connection.end())
      connection.destroy()
      return null
    }
    this[slot] = connection
    return connection
  }

  async run(): Promise<void> {
    const connection = await this.open('connection')
    if (!connection) return
    if (!await this.open('killer')) return
    const [threadRows] = await connection.query('SELECT CONNECTION_ID() AS id') as [{ id: number }[]]
    if (this.closed) return
    this.threadId = Number(threadRows[0]?.id ?? 0)
    if (!Number.isSafeInteger(this.threadId) || this.threadId <= 0) throw new Error('ADMIN_AUDIT_THREAD_ID_INVALID')
    await connection.query(
      'INSERT INTO st_admin_audit (admin_user_id, admin_name, `action`, target, detail_json) VALUES (?, ?, ?, ?, ?)',
      this.values,
    )
  }

  async cancel(): Promise<void> {
    this.closed = true
    if (this.killer && this.threadId > 0) await settleAudit(this.killer.query(`KILL QUERY ${this.threadId}`))
    this.connection?.destroy()
    this.killer?.destroy()
  }

  async close(): Promise<void> {
    this.closed = true
    for (const connection of [this.connection, this.killer]) {
      if (!connection) continue
      await settleAudit(connection.end())
      connection.destroy()
    }
  }
}

function auditError(error: unknown): void {
  logQueryErrorThrottled('adminAudit', error)
}

/** 需要明确结果时使用：timeout 表示结果未知，已尽力 KILL，并不等同于写入失败。 */
export async function writeAdminAuditResult(
  adminUserId: number,
  adminName: string,
  action: string,
  target: string,
  detail?: unknown,
): Promise<'written' | 'failed' | 'timeout'> {
  let detailJson: string | null = null
  try { detailJson = detail == null ? null : JSON.stringify(detail).slice(0, 4000) }
  catch { detailJson = JSON.stringify({ error: 'unserializable_detail' }) }
  const url = process.env.DATABASE_URL
  if (!url) { auditError(new Error('ADMIN_AUDIT_DATABASE_URL_MISSING')); return 'failed' }
  const configured = process.env.ADMIN_AUDIT_TIMEOUT_MS
  const parsed = configured?.trim() ? Number(configured) : 5_000
  const timeoutMs = Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647 ? parsed : 5_000
  const operation = new AdminAuditOperation(url, [adminUserId, adminName.slice(0, 64), action.slice(0, 64), target.slice(0, 191), detailJson])
  let timer: ReturnType<typeof setTimeout> | null = null
  let timedOut = false
  const work = operation.run()
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { timedOut = true; reject(new Error('ADMIN_AUDIT_TIMEOUT')) }, timeoutMs)
        timer.unref?.()
      }),
    ])
    return 'written'
  } catch (error) {
    if (timedOut) await operation.cancel()
    await settleAudit(work)
    auditError(error)
    return timedOut ? 'timeout' : 'failed'
  } finally {
    if (timer) clearTimeout(timer)
    await operation.close()
  }
}

/** 兼容旧调用：返回 void；调用方需要 written/failed/timeout 时改用 writeAdminAuditResult。 */
export function writeAdminAudit(
  adminUserId: number,
  adminName: string,
  action: string,
  target: string,
  detail?: unknown,
): void {
  void writeAdminAuditResult(adminUserId, adminName, action, target, detail).catch(auditError)
}

/** admin 用户显示名（displayName 优先，回退 username） */
export function adminDisplayName(admin: { displayName?: string | null; username?: string | null }): string {
  return String(admin.displayName ?? admin.username ?? "admin");
}

// ─── 漏斗层定义 ──────────────────────────────────────────────────────────────

interface FunnelStage {
  key: string;
  label: string;
  count: number | null;
  note: string;
}

async function buildFunnelStages(): Promise<FunnelStage[]> {
  const [registered, factories, entitled, firstTask, active7d, repurchase] = await Promise.all([
    tryCount(sql`SELECT COUNT(*) AS c FROM wb_users`, "wb_users 全部工作台注册账号"),
    tryCount(sql`SELECT COUNT(*) AS c FROM wb_factories`, "wb_factories 全部企业档案"),
    tryCount(
      sql`SELECT COUNT(DISTINCT factory_id) AS c FROM pkg_entitlements
          WHERE expires_at IS NULL OR expires_at > NOW()`,
      "pkg_entitlements 有效权益（未过期）去重 factory_id",
    ),
    tryCount(
      sql`SELECT COUNT(*) AS c FROM (
            SELECT DISTINCT enterpriseId FROM agent_hire_records
            UNION
            SELECT DISTINCT enterpriseId FROM tasks
          ) t`,
      "有雇佣记录或任务的企业（agent_hire_records/tasks.enterpriseId 口径，指向 enterprises 域）",
    ),
    tryCount(
      sql`SELECT COUNT(*) AS c FROM (
            SELECT DISTINCT factory_id AS fid FROM st_skill_feedback
              WHERE factory_id IS NOT NULL AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
            UNION
            SELECT DISTINCT enterpriseId AS fid FROM tasks
              WHERE createdAt >= DATE_SUB(NOW(), INTERVAL 7 DAY)
          ) t`,
      "近7天活跃：wb_users 无登录时间字段，以 st_skill_feedback.created_at（factory_id）+ tasks.createdAt（enterpriseId）近似",
    ),
    tryCount(
      sql`SELECT COUNT(*) AS c FROM (
            SELECT buyer_factory_id FROM st_pack_purchases
            GROUP BY buyer_factory_id HAVING COUNT(*) >= 2
          ) t`,
      "st_pack_purchases 同一 buyer_factory_id ≥2 笔购买（复购/续费）",
    ),
  ]);
  return [
    { key: "registered", label: "注册账号", ...registered },
    { key: "factories", label: "企业建档", ...factories },
    { key: "entitled", label: "套餐生效", ...entitled },
    { key: "firstTask", label: "首次任务", ...firstTask },
    { key: "active7d", label: "近7天活跃", ...active7d },
    { key: "repurchase", label: "复购企业", ...repurchase },
  ];
}

// ─── 企业健康度（确定性分数公式）─────────────────────────────────────────────

export interface HealthItem {
  factoryId: number;
  name: string;
  score: number;
  activeDays30: number;
  tasks: number;
  feedbacks: number;
  pkgExpiresAt: Date | null;
  silentLevel: "ok" | "warn" | "critical";
  lastActiveAt: Date | null;
  /** 口径说明（批次B：近30天有购买/申请的企业 activeDays30 保守加权至少计 3 时标注） */
  note: string;
}

/**
 * score 0-100 确定性公式（纯聚合值映射，无随机）：
 * - 活跃 40 分：min(activeDays30, 10) / 10 * 40（近30天有反馈或任务的天数，10 天封顶）
 * - 任务 30 分：min(tasks, 20) / 20 * 30（累计任务数，20 单封顶）
 * - 反馈 20 分：min(feedbacks, 10) / 10 * 20（累计技能反馈数，10 条封顶）
 * - 套餐有效性 10 分：pkgExpiresAt 为未来 → 10；否则 0
 * 沉默分级：lastActiveAt 缺失或距今 >14 天 → critical；>7 天 → warn；否则 ok。
 * lastActiveAt = max(st_skill_feedback.created_at[factory_id], tasks.createdAt[enterpriseId])，
 * wb_users 无登录时间字段，故不含登录口径。
 */
export async function buildFactoryHealth(): Promise<HealthItem[]> {
  const factories = await tryRows(sql`SELECT id, enterpriseName FROM wb_factories ORDER BY id LIMIT 500`);
  if (!factories) return [];
  const [actRows, taskRows, fbRows, pkgRows, bizRows] = await Promise.all([
    tryRows(
      sql`SELECT fid, COUNT(DISTINCT d) AS activeDays, MAX(ts) AS lastTs FROM (
            SELECT factory_id AS fid, DATE(created_at) AS d, created_at AS ts
              FROM st_skill_feedback
              WHERE factory_id IS NOT NULL AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            UNION ALL
            SELECT enterpriseId AS fid, DATE(createdAt) AS d, createdAt AS ts
              FROM tasks
              WHERE createdAt >= DATE_SUB(NOW(), INTERVAL 30 DAY)
          ) t GROUP BY fid`,
    ),
    tryRows(sql`SELECT enterpriseId AS fid, COUNT(*) AS c, MAX(createdAt) AS lastTs FROM tasks GROUP BY enterpriseId`),
    tryRows(
      sql`SELECT factory_id AS fid, COUNT(*) AS c, MAX(created_at) AS lastTs
          FROM st_skill_feedback WHERE factory_id IS NOT NULL GROUP BY factory_id`,
    ),
    tryRows(sql`SELECT factory_id AS fid, MAX(expires_at) AS exp FROM pkg_entitlements GROUP BY factory_id`),
    // 批次B口径修正：近30天有购买（st_pack_purchases）或申请（st_pack_applications）记录的企业
    tryRows(
      sql`SELECT fid, MAX(ts) AS lastTs FROM (
            SELECT buyer_factory_id AS fid, created_at AS ts FROM st_pack_purchases
              WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            UNION ALL
            SELECT factory_id AS fid, created_at AS ts FROM st_pack_applications
              WHERE factory_id IS NOT NULL AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
          ) t GROUP BY fid`,
    ),
  ]);
  const toMap = (rows: Array<Record<string, unknown>> | null) => {
    const m = new Map<number, Record<string, unknown>>();
    for (const r of rows ?? []) {
      if (r.fid != null) m.set(Number(r.fid), r);
    }
    return m;
  };
  const actMap = toMap(actRows);
  const taskMap = toMap(taskRows);
  const fbMap = toMap(fbRows);
  const pkgMap = toMap(pkgRows);
  const bizMap = toMap(bizRows);
  const now = Date.now();
  const DAY = 24 * 3600 * 1000;
  return factories.map((f) => {
    const fid = Number(f.id);
    // 批次B口径修正：近30天有购买或申请记录的企业 activeDays 至少计 3（保守加权），note 标注口径
    const hasBiz30 = bizMap.has(fid);
    const rawActiveDays = Number(actMap.get(fid)?.activeDays ?? 0);
    const activeDays30 = hasBiz30 ? Math.max(rawActiveDays, 3) : rawActiveDays;
    const note = hasBiz30
      ? "近30天有购买(st_pack_purchases)或申请(st_pack_applications)记录，activeDays30 保守加权至少计 3"
      : "";
    const tasks = Number(taskMap.get(fid)?.c ?? 0);
    const feedbacks = Number(fbMap.get(fid)?.c ?? 0);
    const expRaw = pkgMap.get(fid)?.exp;
    const pkgExpiresAt = expRaw ? new Date(String(expRaw)) : null;
    // lastActiveAt = 反馈/任务/购买申请最近时间的最大值（wb_users 无登录字段）
    const candidates = [actMap.get(fid)?.lastTs, taskMap.get(fid)?.lastTs, fbMap.get(fid)?.lastTs, bizMap.get(fid)?.lastTs]
      .filter((v) => v != null)
      .map((v) => new Date(String(v)).getTime());
    const lastActiveAt = candidates.length > 0 ? new Date(Math.max(...candidates)) : null;
    const score = Math.round(
      (Math.min(activeDays30, 10) / 10) * 40 +
        (Math.min(tasks, 20) / 20) * 30 +
        (Math.min(feedbacks, 10) / 10) * 20 +
        (pkgExpiresAt && pkgExpiresAt.getTime() > now ? 10 : 0),
    );
    const silentDays = lastActiveAt ? (now - lastActiveAt.getTime()) / DAY : Infinity;
    const silentLevel: HealthItem["silentLevel"] =
      silentDays > 14 ? "critical" : silentDays > 7 ? "warn" : "ok";
    return {
      factoryId: fid,
      name: String(f.enterpriseName ?? `工厂#${fid}`),
      score,
      activeDays30,
      tasks,
      feedbacks,
      pkgExpiresAt,
      silentLevel,
      lastActiveAt,
      note,
    };
  });
}

// ─── 路由 ────────────────────────────────────────────────────────────────────

export const adminAnalyticsRouter = createRouter({
  /** funnel：六层转化漏斗；任一层失败该层 count=null + note，绝不抛错 */
  funnel: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    return { stages: await buildFunnelStages(), generatedAt: new Date() };
  }),

  /** revenueTrend：按日聚合 shopGmv（st_pack_purchases.price_tokens）+ tokenFlow（token_transactions.amount） */
  revenueTrend: publicQuery
    .input(tokenInput.extend({ days: z.union([z.literal(7), z.literal(30)]).optional().default(7) }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const days: number = input.days;
      const [shopRows, flowRows] = await Promise.all([
        tryRows(
          sql`SELECT DATE(created_at) AS d, SUM(price_tokens) AS gmv, SUM(share_platform) AS share
              FROM st_pack_purchases
              WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ${days - 1} DAY)
              GROUP BY DATE(created_at)`,
        ),
        tryRows(
          sql`SELECT DATE(createdAt) AS d, SUM(amount) AS flow
              FROM token_transactions
              WHERE createdAt >= DATE_SUB(CURDATE(), INTERVAL ${days - 1} DAY)
              GROUP BY DATE(createdAt)`,
        ),
      ]);
      const shopMap = new Map<string, { gmv: number; share: number }>();
      for (const r of shopRows ?? []) {
        shopMap.set(String(r.d).slice(0, 10), { gmv: Number(r.gmv ?? 0), share: Number(r.share ?? 0) });
      }
      const flowMap = new Map<string, number>();
      for (const r of flowRows ?? []) {
        flowMap.set(String(r.d).slice(0, 10), Number(r.flow ?? 0));
      }
      // 补齐无数据日期为 0，保证序列连续
      const series: Array<{ date: string; tokenFlow: number; shopGmv: number; platformShare: number }> = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 24 * 3600 * 1000);
        const key = d.toISOString().slice(0, 10);
        const shop = shopMap.get(key);
        series.push({
          date: key,
          tokenFlow: flowMap.get(key) ?? 0,
          shopGmv: shop?.gmv ?? 0,
          platformShare: shop?.share ?? 0,
        });
      }
      const totals = series.reduce(
        (acc, s) => ({
          tokenFlow: acc.tokenFlow + s.tokenFlow,
          shopGmv: acc.shopGmv + s.shopGmv,
          platformShare: acc.platformShare + s.platformShare,
        }),
        { tokenFlow: 0, shopGmv: 0, platformShare: 0 },
      );
      return {
        series,
        totals,
        notes: {
          shopGmv: "st_pack_purchases.price_tokens 按日求和（Token 调用计量）",
          platformShare: "st_pack_purchases.share_platform 按日求和",
          tokenFlow:
            flowRows == null
              ? "token_transactions 查询失败，tokenFlow 按 0 降级"
              : "token_transactions.amount 按日求和（既有 token 流水表）",
        },
      };
    }),

  /** supplySide：agents 雇佣率 + packs 动销率 + TOP 榜 */
  supplySide: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const [agentTotal, agentHired, packAgg, topPacks] = await Promise.all([
      tryRows(sql`SELECT COUNT(*) AS c FROM agents`),
      tryRows(sql`SELECT COUNT(DISTINCT agentId) AS c FROM agent_hire_records WHERE status IN ('trial','active')`),
      tryRows(
        sql`SELECT COUNT(*) AS total, SUM(CASE WHEN sales_count > 0 THEN 1 ELSE 0 END) AS withSales
            FROM st_skill_packs WHERE status = 'listed'`,
      ),
      tryRows(
        sql`SELECT pack_key, title, sales_count FROM st_skill_packs
            WHERE status = 'listed' ORDER BY sales_count DESC, id DESC LIMIT 10`,
      ),
    ]);
    const aTotal = Number(agentTotal?.[0]?.c ?? 0);
    const aHired = Number(agentHired?.[0]?.c ?? 0);
    const pTotal = Number(packAgg?.[0]?.total ?? 0);
    const pSales = Number(packAgg?.[0]?.withSales ?? 0);
    return {
      agents: {
        total: agentTotal == null ? null : aTotal,
        hired: agentHired == null ? null : aHired,
        hireRate: agentTotal == null || agentHired == null || aTotal === 0 ? null : Math.round((aHired / aTotal) * 1000) / 10,
        note: "hired=agent_hire_records 状态 trial/active 去重 agentId",
      },
      packs: {
        total: packAgg == null ? null : pTotal,
        withSales: packAgg == null ? null : pSales,
        sellThroughRate: packAgg == null || pTotal === 0 ? null : Math.round((pSales / pTotal) * 1000) / 10,
        note: "st_skill_packs status='listed'；withSales=sales_count>0",
      },
      topPacks: (topPacks ?? []).map((r) => ({
        packKey: String(r.pack_key),
        title: String(r.title ?? r.pack_key),
        sales: Number(r.sales_count ?? 0),
      })),
    };
  }),

  /** factoryHealth：确定性健康分（公式见 buildFactoryHealth 注释） */
  factoryHealth: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const items = await buildFactoryHealth();
    const summary = { ok: 0, warn: 0, critical: 0 };
    for (const it of items) summary[it.silentLevel] += 1;
    return {
      items,
      summary,
      formula:
        "score=活跃40(min(activeDays30,10)/10*40)+任务30(min(tasks,20)/20*30)+反馈20(min(feedbacks,10)/10*20)+套餐有效性10(未过期10否则0)；沉默分级 lastActiveAt>14天 critical / >7天 warn；批次B口径：近30天有购买/申请记录的企业 activeDays30 至少计 3（见 item.note）",
    };
  }),

  /** evoBoard：进化看板四组指标（迭代69：llm 因子接入 st_llm_events 近14天聚合） */
  evoBoard: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const [propAgg, profAgg, profWeek, fbAgg, llmAgg] = await Promise.all([
      tryRows(
        sql`SELECT COUNT(*) AS total,
                   SUM(CASE WHEN status IN ('approved','applied') THEN 1 ELSE 0 END) AS applied
            FROM st_evo_proposals`,
      ),
      tryRows(sql`SELECT AVG(proficiency) AS avg FROM st_agent_skills WHERE enabled = 1`),
      tryRows(
        sql`SELECT AVG(proficiency) AS avg FROM st_agent_skills
            WHERE enabled = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
      ),
      tryRows(
        sql`SELECT COUNT(*) AS total,
                   SUM(CASE WHEN \`signal\` = 'useful' THEN 1 ELSE 0 END) AS useful
            FROM st_skill_feedback`,
      ),
      tryRows(
        sql`SELECT COUNT(*) AS total, COALESCE(SUM(fallback), 0) AS fb
            FROM st_llm_events
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)`,
      ),
    ]);
    const pTotal = Number(propAgg?.[0]?.total ?? 0);
    const pApplied = Number(propAgg?.[0]?.applied ?? 0);
    const avg = profAgg?.[0]?.avg == null ? null : Math.round(Number(profAgg[0].avg) * 10) / 10;
    const weekAvg = profWeek?.[0]?.avg == null ? null : Number(profWeek[0].avg);
    const fTotal = Number(fbAgg?.[0]?.total ?? 0);
    const fUseful = Number(fbAgg?.[0]?.useful ?? 0);
    return {
      proposals: {
        total: propAgg == null ? null : pTotal,
        applied: propAgg == null ? null : pApplied,
        passRate: propAgg == null || pTotal === 0 ? null : Math.round((pApplied / pTotal) * 1000) / 10,
        note: "applied=status approved/applied（decide 审批通过口径）",
      },
      proficiency: {
        avg,
        deltaWeek:
          avg == null || weekAvg == null
            ? null
            : Math.round((weekAvg - avg) * 10) / 10,
        note: "deltaWeek=近7天新增挂载的平均熟练度−全量平均熟练度（st_agent_skills 无 updated_at 列，按 created_at 近似）",
      },
      feedback: {
        total: fbAgg == null ? null : fTotal,
        adoptRate: fbAgg == null || fTotal === 0 ? null : Math.round((fUseful / fTotal) * 1000) / 10,
        note: "adoptRate=signal='useful' 占比",
      },
      llm: (() => {
        const lTotal = llmAgg == null ? null : Number(llmAgg?.[0]?.total ?? 0);
        const lFb = llmAgg == null ? 0 : Number(llmAgg?.[0]?.fb ?? 0);
        return {
          total: lTotal,
          fallbackRate: lTotal == null || lTotal === 0 ? null : Math.round((lFb / lTotal) * 1000) / 10,
          note: "近14天 st_llm_events（进化链 brain/flash 调用）fallback 占比；无调用时 fallbackRate=null 不计入北极星",
        };
      })(),
    };
  }),

  /**
   * llmLatencyBoard：M61 模型时延看板（st_llm_events 窗口聚合，内存分位数）。
   * - 窗口 hours∈[1,720]，默认 24；行限 10000（日均调用量小，内存聚合完全够；
   *   超限时 sampled=true 注明按最近 1 万行近似）；
   * - 三维聚合：bySlot（槽位）/ byContext（调用场景）/ hourly（逐小时趋势）+ summary；
   * - firstTokenMs 仅流式调用有值（M60 起），非流式为 null 不参与均值；
   * - 表不存在/查询失败 → 全 null 降级（同 evoBoard 哲学，绝不抛错）。
   */
  llmLatencyBoard: publicQuery
    .input(z.object({ token: z.string().trim().min(1), hours: z.number().int().min(1).max(720).default(24) }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const hours = input.hours;
      const rows = await tryRows(
        sql`SELECT slot, context, ok, fallback, latency_ms AS latencyMs, first_token_ms AS firstTokenMs, created_at AS createdAt
            FROM st_llm_events
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${hours} HOUR)
            ORDER BY created_at DESC
            LIMIT 10000`,
      );
      if (rows == null) {
        return {
          windowHours: hours,
          available: false,
          note: "st_llm_events 查询失败/表不存在，按不可用降级",
          summary: null,
          bySlot: [],
          byContext: [],
          hourly: [],
        };
      }
      type Row = { slot: string; context: string; ok: number; fallback: number; latencyMs: number | null; firstTokenMs: number | null; createdAt: unknown };
      const list = (rows as unknown as Row[]).map((r) => ({
        slot: String(r.slot ?? "unknown"),
        context: String(r.context ?? "unknown"),
        ok: Number(r.ok ?? 0),
        fallback: Number(r.fallback ?? 0),
        latencyMs: r.latencyMs == null ? null : Number(r.latencyMs),
        firstTokenMs: r.firstTokenMs == null ? null : Number(r.firstTokenMs),
        createdAt: toDate(r.createdAt),
      }));
      const pct = (sorted: number[], p: number): number | null => {
        if (sorted.length === 0) return null;
        const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
        return sorted[idx];
      };
      const agg = (items: typeof list) => {
        const total = items.length;
        const okN = items.filter((r) => r.ok === 1).length;
        const fbN = items.filter((r) => r.fallback === 1).length;
        const lat = items.map((r) => r.latencyMs).filter((v): v is number => v != null).sort((a, b) => a - b);
        const ft = items.map((r) => r.firstTokenMs).filter((v): v is number => v != null).sort((a, b) => a - b);
        return {
          calls: total,
          okRate: total === 0 ? null : Math.round((okN / total) * 1000) / 10,
          fallbackRate: total === 0 ? null : Math.round((fbN / total) * 1000) / 10,
          avgLatencyMs: lat.length === 0 ? null : Math.round(lat.reduce((a, b) => a + b, 0) / lat.length),
          p95LatencyMs: pct(lat, 0.95),
          avgFirstTokenMs: ft.length === 0 ? null : Math.round(ft.reduce((a, b) => a + b, 0) / ft.length),
          streamCalls: ft.length,
        };
      };
      const byKey = (keyFn: (r: (typeof list)[number]) => string) => {
        const m = new Map<string, typeof list>();
        for (const r of list) {
          const k = keyFn(r);
          const arr = m.get(k) ?? [];
          arr.push(r);
          m.set(k, arr);
        }
        return [...m.entries()]
          .map(([name, items]) => ({ name, ...agg(items) }))
          .sort((a, b) => b.calls - a.calls);
      };
      // 逐小时桶（按调用方时区不可知，统一 UTC+8 标签，与运营口径一致）
      const hourlyMap = new Map<string, typeof list>();
      for (const r of list) {
        if (!r.createdAt) continue;
        const t = new Date(r.createdAt.getTime() + 8 * 3600_000);
        const bucket = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")} ${String(t.getUTCHours()).padStart(2, "0")}:00`;
        const arr = hourlyMap.get(bucket) ?? [];
        arr.push(r);
        hourlyMap.set(bucket, arr);
      }
      const hourly = [...hourlyMap.entries()]
        .map(([bucket, items]) => ({ bucket, ...agg(items) }))
        .sort((a, b) => a.bucket.localeCompare(b.bucket));
      return {
        windowHours: hours,
        available: true,
        sampled: list.length >= 10000,
        note: "近窗口 st_llm_events 聚合；firstTokenMs 仅 M60 起流式调用有值；时区 UTC+8；p95 为内存精确分位",
        summary: agg(list),
        bySlot: byKey((r) => r.slot),
        byContext: byKey((r) => r.context).slice(0, 12),
        hourly,
      };
    }),

  /** todoQueue：待审技能包 / 沉默企业 / 运维预警 / 超48h未确权申请 四类聚合 */
  todoQueue: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const [reviewRows, healthItems, alertRows, timeoutRows] = await Promise.all([
      tryRows(
        sql`SELECT pack_key, title, created_at FROM st_skill_packs
            WHERE status = 'pending_review' ORDER BY id DESC LIMIT 50`,
      ),
      buildFactoryHealth(),
      tryRows(
        sql`SELECT id, severity, title, created_at FROM ops_alerts
            WHERE status IN ('open','ack') ORDER BY id DESC LIMIT 50`,
      ),
      tryRows(
        sql`SELECT id, pack_key, created_at FROM st_pack_applications
            WHERE confirm_status = 'pending' AND created_at < DATE_SUB(NOW(), INTERVAL 48 HOUR)
            ORDER BY id DESC LIMIT 50`,
      ),
    ]);
    interface TodoItem {
      kind: "review" | "silent" | "alert" | "confirmTimeout";
      title: string;
      ref: string;
      severity: "info" | "warn" | "critical";
      createdAt: Date | null;
    }
    const items: TodoItem[] = [];
    for (const r of reviewRows ?? []) {
      items.push({
        kind: "review",
        title: `技能包待审核：${String(r.title ?? r.pack_key)}`,
        ref: String(r.pack_key),
        severity: "info",
        createdAt: toDate(r.created_at),
      });
    }
    for (const h of healthItems) {
      if (h.silentLevel === "ok") continue;
      items.push({
        kind: "silent",
        title: `沉默企业（${h.silentLevel === "critical" ? "严重" : "预警"}）：${h.name}`,
        ref: String(h.factoryId),
        severity: h.silentLevel,
        createdAt: h.lastActiveAt,
      });
    }
    for (const r of alertRows ?? []) {
      const sev = String(r.severity ?? "");
      items.push({
        kind: "alert",
        title: `运维预警：${String(r.title ?? "")}`,
        ref: String(r.id),
        severity: sev === "critical" ? "critical" : sev === "warn" ? "warn" : "info",
        createdAt: toDate(r.created_at),
      });
    }
    for (const r of timeoutRows ?? []) {
      items.push({
        kind: "confirmTimeout",
        title: `上架申请超48h未确权：${String(r.pack_key)}`,
        ref: String(r.id),
        severity: "warn",
        createdAt: toDate(r.created_at),
      });
    }
    const counts = { review: 0, silent: 0, alert: 0, confirmTimeout: 0 };
    for (const it of items) counts[it.kind] += 1;
    return { items, counts };
  }),

  /** auditList：st_admin_audit 倒序（表不存在时返回空数组降级） */
  auditList: publicQuery
    .input(tokenInput.extend({ limit: z.number().int().min(1).max(200).optional().default(50) }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const rows = await tryRows(
        sql`SELECT id, admin_user_id, admin_name, \`action\`, target, detail_json, created_at
            FROM st_admin_audit ORDER BY id DESC LIMIT ${input.limit}`,
      );
      return {
        items: (rows ?? []).map((r) => ({
          id: Number(r.id),
          adminUserId: Number(r.admin_user_id),
          adminName: String(r.admin_name ?? ""),
          action: String(r.action ?? ""),
          target: String(r.target ?? ""),
          detailJson: r.detail_json == null ? null : String(r.detail_json),
          createdAt: toDate(r.created_at),
        })),
        degraded: rows == null,
      };
    }),

  /**
   * digestStats（迭代 32，API-CONTRACT-v8 §2）：企业成长快报运营统计（仅展示）。
   * factoriesWithDigest=已生成快报的企业数；thisWeekGenerated=本周（周一为起点）生成数；
   * 表不存在时返回 null + note 降级，绝不抛错。
   * 消费面注记（门禁 PR#28 R9 票⑤）：驾驶舱统计卡随波 1 拍板台化摘除——本端点为 v8 §2 正式契约不摘，
   * 经营分析页（/admin/analytics）接入前属「契约保留·暂无读者」态，非死代码。
   */
  digestStats: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const [aggRows, weekRows, recentRows] = await Promise.all([
      tryRows(
        sql`SELECT COUNT(DISTINCT factory_id) AS factories, COUNT(*) AS total FROM st_weekly_digest`,
      ),
      tryRows(
        sql`SELECT COUNT(*) AS c FROM st_weekly_digest
            WHERE week_start = DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)`,
      ),
      tryRows(
        sql`SELECT factory_id, week_start, created_at FROM st_weekly_digest
            ORDER BY id DESC LIMIT 10`,
      ),
    ]);
    return {
      factoriesWithDigest: aggRows == null ? null : Number(aggRows[0]?.factories ?? 0),
      totalDigests: aggRows == null ? null : Number(aggRows[0]?.total ?? 0),
      thisWeekGenerated: weekRows == null ? null : Number(weekRows[0]?.c ?? 0),
      recent: (recentRows ?? []).map((r) => ({
        factoryId: Number(r.factory_id),
        weekStart: r.week_start == null ? null : String(r.week_start).slice(0, 10),
        createdAt: toDate(r.created_at),
      })),
      note:
        aggRows == null
          ? "st_weekly_digest 表不存在/查询失败，按 null 降级"
          : "st_weekly_digest 聚合（本周起点=周一，WEEKDAY(CURDATE()) 口径）",
    };
  }),

  /**
   * proposalStats（迭代 33，API-CONTRACT-v9 §3）：全平台进化提案运营统计——
   * 消费面注记（门禁 PR#28 R14 票①）：API-CONTRACT-v9 §3 正式契约不摘——暂无读者（经营分析页接入位），非死代码。
   * 提案总数/各状态数/批准率(approved+applied / 已审批)/应用率(applied / 批准数)/
   * 覆盖企业数（接进化看板页）。表不存在时按 null + note 降级，绝不抛错。
   */
  proposalStats: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const [statusRows, facRows] = await Promise.all([
      tryRows(sql`SELECT status, COUNT(*) AS c FROM st_evo_proposals GROUP BY status`),
      tryRows(
        sql`SELECT COUNT(DISTINCT factory_id) AS c FROM st_evo_proposals WHERE factory_id IS NOT NULL`,
      ),
    ]);
    const byStatus = new Map((statusRows ?? []).map((r) => [String(r.status), Number(r.c ?? 0)]));
    const pending = byStatus.get("pending") ?? 0;
    const approved = byStatus.get("approved") ?? 0;
    const rejected = byStatus.get("rejected") ?? 0;
    const applied = byStatus.get("applied") ?? 0;
    const total = pending + approved + rejected + applied;
    const decided = approved + rejected + applied;
    const approvedTotal = approved + applied;
    return {
      total: statusRows == null ? null : total,
      pending: statusRows == null ? null : pending,
      approved: statusRows == null ? null : approved,
      rejected: statusRows == null ? null : rejected,
      applied: statusRows == null ? null : applied,
      approvalRate: statusRows == null ? null : decided > 0 ? Math.round((approvedTotal / decided) * 100) : null,
      appliedRate: statusRows == null ? null : approvedTotal > 0 ? Math.round((applied / approvedTotal) * 100) : null,
      factoriesWithProposals: facRows == null ? null : Number(facRows[0]?.c ?? 0),
      note:
        statusRows == null
          ? "st_evo_proposals 表不存在/查询失败，按 null 降级"
          : "st_evo_proposals 全平台聚合；批准率=(approved+applied)/已审批，应用率=applied/(approved+applied)，百分比整数",
    };
  }),

  /**
   * godView（批次B §3）：只读上帝视角，返回企业全景（members 脱敏）；
   * 任何调用自动 writeAdminAudit(action='godView', target=factoryId)；无任何写库操作。
   */
  godView: publicQuery
    .input(tokenInput.extend({ factoryId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      // 留痕：godView 调用即审计（fire-and-forget，失败静默）
      writeAdminAudit(Number(admin.id), adminDisplayName(admin), "godView", String(input.factoryId));
      const fid = input.factoryId;
      const [factoryRows, memberRows, agentRows, packRows, purchaseRows, taskRows, feedbackRows, health] =
        await Promise.all([
          tryRows(
            sql`SELECT id, enterpriseName, industry, industryText, industryGroup, headcount,
                       creditCode, departments, painPoints, createdAt
                FROM wb_factories WHERE id = ${fid} LIMIT 1`,
          ),
          tryRows(
            sql`SELECT id, username, displayName, role, phone, kind, createdAt
                FROM wb_users WHERE factoryId = ${fid} ORDER BY id LIMIT 200`,
          ),
          tryRows(
            sql`SELECT a.id, a.code, a.name, a.industry, a.status, a.monthlyPrice, a.hires,
                       h.status AS hireStatus, h.startedAt, h.endsAt
                FROM agent_hire_records h
                INNER JOIN agents a ON a.id = h.agentId
                WHERE h.enterpriseId = ${fid}
                ORDER BY h.id DESC LIMIT 100`,
          ),
          tryRows(
            sql`SELECT pack_key, title, layer, track, creator_type, price_tokens, sales_count,
                       status, created_at
                FROM st_skill_packs WHERE factory_id = ${fid} ORDER BY id DESC LIMIT 100`,
          ),
          tryRows(
            sql`SELECT p.id, p.pack_key, p.price_tokens, p.status, p.created_at, k.title
                FROM st_pack_purchases p
                LEFT JOIN st_skill_packs k ON k.pack_key = p.pack_key
                WHERE p.buyer_factory_id = ${fid} ORDER BY p.id DESC LIMIT 100`,
          ),
          tryRows(
            sql`SELECT id, agentId, intentSummary, status, tokenCost, durationMs, createdAt
                FROM tasks WHERE enterpriseId = ${fid} ORDER BY id DESC LIMIT 20`,
          ),
          tryRows(
            sql`SELECT id, agent_id, skill_key, \`signal\`, note, created_at
                FROM st_skill_feedback WHERE factory_id = ${fid} ORDER BY id DESC LIMIT 100`,
          ),
          buildFactoryHealth(),
        ]);
      const f = factoryRows?.[0];
      if (!f) throw new TRPCError({ code: "NOT_FOUND", message: "企业不存在" });
      // members 脱敏：不返回 authToken/passwordHash/idCard*；phone 掩码
      const maskPhone = (p: unknown) => {
        const s = p == null ? "" : String(p);
        return s.length >= 7 ? `${s.slice(0, 3)}****${s.slice(-4)}` : s ? "***" : null;
      };
      return {
        factory: {
          factoryId: Number(f.id),
          enterpriseName: String(f.enterpriseName ?? ""),
          industry: f.industry == null ? null : String(f.industry),
          industryText: f.industryText == null ? null : String(f.industryText),
          industryGroup: f.industryGroup == null ? null : String(f.industryGroup),
          headcount: f.headcount == null ? null : String(f.headcount),
          creditCode: f.creditCode == null ? null : String(f.creditCode),
          departments: f.departments == null ? null : String(f.departments),
          painPoints: f.painPoints == null ? null : String(f.painPoints),
          createdAt: toDate(f.createdAt),
        },
        members: (memberRows ?? []).map((m) => ({
          userId: Number(m.id),
          username: String(m.username ?? ""),
          displayName: String(m.displayName ?? ""),
          role: String(m.role ?? ""),
          kind: m.kind == null ? null : String(m.kind),
          phoneMasked: maskPhone(m.phone),
          createdAt: toDate(m.createdAt),
        })),
        agents: (agentRows ?? []).map((a) => ({
          agentId: Number(a.id),
          code: String(a.code ?? ""),
          name: String(a.name ?? ""),
          industry: a.industry == null ? null : String(a.industry),
          status: String(a.status ?? ""),
          monthlyPrice: a.monthlyPrice == null ? null : Number(a.monthlyPrice),
          hires: a.hires == null ? null : Number(a.hires),
          hireStatus: a.hireStatus == null ? null : String(a.hireStatus),
          startedAt: toDate(a.startedAt),
          endsAt: toDate(a.endsAt),
        })),
        packs: (packRows ?? []).map((p) => ({
          packKey: String(p.pack_key),
          title: String(p.title ?? p.pack_key),
          layer: String(p.layer ?? ""),
          track: String(p.track ?? ""),
          creatorType: String(p.creator_type ?? ""),
          priceTokens: Number(p.price_tokens ?? 0),
          salesCount: Number(p.sales_count ?? 0),
          status: String(p.status ?? ""),
          createdAt: toDate(p.created_at),
        })),
        purchases: (purchaseRows ?? []).map((p) => ({
          purchaseId: Number(p.id),
          packKey: String(p.pack_key),
          title: p.title == null ? String(p.pack_key) : String(p.title),
          priceTokens: Number(p.price_tokens ?? 0),
          status: String(p.status ?? ""),
          createdAt: toDate(p.created_at),
        })),
        tasks: (taskRows ?? []).map((t) => ({
          taskId: Number(t.id),
          agentId: t.agentId == null ? null : Number(t.agentId),
          intentSummary: t.intentSummary == null ? null : String(t.intentSummary),
          status: String(t.status ?? ""),
          tokenCost: t.tokenCost == null ? null : Number(t.tokenCost),
          durationMs: t.durationMs == null ? null : Number(t.durationMs),
          createdAt: toDate(t.createdAt),
        })),
        feedbacks: (feedbackRows ?? []).map((fb) => ({
          feedbackId: Number(fb.id),
          agentId: fb.agent_id == null ? null : Number(fb.agent_id),
          skillKey: fb.skill_key == null ? null : String(fb.skill_key),
          signal: String(fb.signal ?? ""),
          note: fb.note == null ? null : String(fb.note),
          createdAt: toDate(fb.created_at),
        })),
        health: health.find((h) => h.factoryId === fid) ?? null,
        notes:
          "agent_hire_records/tasks 的 enterpriseId 指向 enterprises 域，与 wb_factories.id 非同一域，按既有口径对齐 factoryId 统计；members 已脱敏（不含 authToken/passwordHash/idCard，phone 掩码）",
        readOnly: true as const,
        banner: "只读视图 · 访问已留痕",
      };
    }),

  /**
   * wallStats（批次B §4）：实时数据大屏聚合。
   * 所有数字来自既有表，无口径/查询失败 → null + note，不伪造。
   */
  wallStats: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const [newUsersRows, newTasksRows, gmvRows, ticketsRows, auditRows, rev7Rows, stages, health] =
      await Promise.all([
        tryRows(sql`SELECT COUNT(*) AS c FROM wb_users WHERE createdAt >= CURDATE()`),
        tryRows(sql`SELECT COUNT(*) AS c FROM tasks WHERE createdAt >= CURDATE()`),
        tryRows(
          sql`SELECT COALESCE(SUM(price_tokens), 0) AS gmv, COUNT(*) AS orders
              FROM st_pack_purchases WHERE created_at >= CURDATE()`,
        ),
        tryRows(sql`SELECT COUNT(*) AS c FROM st_ops_tickets WHERE status = 'open'`),
        tryRows(
          sql`SELECT id, admin_name, \`action\`, target, created_at
              FROM st_admin_audit ORDER BY id DESC LIMIT 8`,
        ),
        tryRows(
          sql`SELECT DATE(created_at) AS d, SUM(price_tokens) AS gmv
              FROM st_pack_purchases
              WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
              GROUP BY DATE(created_at)`,
        ),
        buildFunnelStages(),
        buildFactoryHealth(),
      ]);
    const revMap = new Map<string, number>();
    for (const r of rev7Rows ?? []) revMap.set(String(r.d).slice(0, 10), Number(r.gmv ?? 0));
    const revenue7d: Array<{ date: string; gmv: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const key = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
      revenue7d.push({ date: key, gmv: revMap.get(key) ?? 0 });
    }
    const topFactories = [...health]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((h) => ({ factoryId: h.factoryId, name: h.name, score: h.score, silentLevel: h.silentLevel }));
    return {
      generatedAt: new Date(),
      today: {
        newUsers: newUsersRows?.[0]?.c == null ? null : Number(newUsersRows[0].c),
        newTasks: newTasksRows?.[0]?.c == null ? null : Number(newTasksRows[0].c),
        gmv: gmvRows?.[0]?.gmv == null ? null : Number(gmvRows[0].gmv),
        ticketsOpen: ticketsRows == null ? null : Number(ticketsRows[0]?.c ?? 0),
      },
      todayNotes: {
        newUsers: newUsersRows == null ? "wb_users 查询失败，按 null 降级" : "wb_users.createdAt 今日新增",
        newTasks: newTasksRows == null ? "tasks 查询失败，按 null 降级" : "tasks.createdAt 今日新增",
        gmv: gmvRows == null ? "st_pack_purchases 查询失败，按 null 降级" : "st_pack_purchases.price_tokens 今日求和（Token 调用计量）",
        ticketsOpen: ticketsRows == null ? "st_ops_tickets 表不存在/查询失败，按 null 降级" : "st_ops_tickets status='open'",
      },
      funnel: stages,
      topFactories,
      recentAudit: (auditRows ?? []).map((r) => ({
        auditId: Number(r.id),
        adminName: String(r.admin_name ?? ""),
        action: String(r.action ?? ""),
        target: String(r.target ?? ""),
        createdAt: toDate(r.created_at),
      })),
      recentAuditNote: auditRows == null ? "st_admin_audit 查询失败，按空列表降级" : "st_admin_audit 近8条",
      revenue7d,
      revenue7dNote:
        rev7Rows == null ? "st_pack_purchases 查询失败，7 日序列按 0 降级" : "st_pack_purchases.price_tokens 近7日按日求和",
    };
  }),
});
