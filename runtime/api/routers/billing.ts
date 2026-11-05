/**
 * billing —— iter92 计费套餐（训练场成本闸 + 欠费降权）。
 *
 * 档位（plan-iter92 焊死）：basic=3 熊猫/200 LLM 日；pro=8/1000；flagship=20/5000。
 *
 * 契约：
 * - billing.plan {token} → {planCode, seatLimit, llmDailyLimit, llmUsedToday, expireAt, status}
 *   （读取时 expire_at<NOW() 动态视为 past_due 返回，不写库）
 *
 * 共享 helper（claw.wbDispatch / sandbox.dispatch / agentic.authRegisterEnterprise 复用）：
 * - getFactoryPlan / planEffectiveStatus / assertFactoryPlanActive（403「套餐到期或未开通，请联系平台续费」）
 * - factoryLlmUsedToday / recordFactoryLlmCall（+1 并触发 80%/100% 阈值告警，每厂每日每档一次）
 * - initFactoryPlan（注册默认 basic + 30 天，INSERT IGNORE 幂等）
 *
 * 表：st_factory_plan / st_llm_usage_factory_daily（db/sync-iter92.mts，原生 SQL，不改 drizzle schema）。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { stQuery } from "./terminal";
import { parseDbUtc } from "./dbTime";
import { sessionMe } from "./wbSession";
import { alertOnceDaily } from "./alertUtil";
import { emitSignal } from "./autoEngine";

/** 套餐档位映射（seat_limit / llm_daily_limit） */
export const PLAN_TIERS = {
  basic: { seatLimit: 3, llmDailyLimit: 200 },
  pro: { seatLimit: 8, llmDailyLimit: 1000 },
  flagship: { seatLimit: 20, llmDailyLimit: 5000 },
} as const;
export type PlanCode = keyof typeof PLAN_TIERS;

export interface FactoryPlan {
  factoryId: number;
  planCode: PlanCode;
  seatLimit: number;
  llmDailyLimit: number;
  status: string;
  expireAt: string | null;
}

/** DATETIME 值 → ms 时间戳（兼容 string/Date；空为 null） */
function dtMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const t = parseDbUtc(v);
  return Number.isFinite(t) ? t : null;
}

/** 本厂套餐（无行返回 null） */
export async function getFactoryPlan(factoryId: number): Promise<FactoryPlan | null> {
  const rows = await stQuery(
    sql`SELECT factory_id AS factoryId, plan_code AS planCode, seat_limit AS seatLimit,
               llm_daily_limit AS llmDailyLimit, status, expire_at AS expireAt
        FROM st_factory_plan WHERE factory_id = ${factoryId} LIMIT 1`,
  );
  const r = rows[0];
  if (!r) return null;
  const code = String(r.planCode);
  return {
    factoryId: Number(r.factoryId),
    planCode: (code in PLAN_TIERS ? code : "basic") as PlanCode,
    seatLimit: Number(r.seatLimit),
    llmDailyLimit: Number(r.llmDailyLimit),
    status: String(r.status),
    expireAt: r.expireAt === null || r.expireAt === undefined ? null : String(r.expireAt),
  };
}

/** 动态有效状态：expire_at<NOW() 视为 past_due（只读判定，不写库） */
export function planEffectiveStatus(plan: FactoryPlan): string {
  if (plan.status !== "active") return plan.status;
  const exp = dtMs(plan.expireAt);
  if (exp !== null && exp < Date.now()) return "past_due";
  return "active";
}

/** 套餐闸：无行 / status≠active / 已过期 → 403「套餐到期或未开通，请联系平台续费」 */
export async function assertFactoryPlanActive(factoryId: number): Promise<FactoryPlan> {
  const plan = await getFactoryPlan(factoryId);
  if (!plan || planEffectiveStatus(plan) !== "active") {
    throw new TRPCError({ code: "FORBIDDEN", message: "套餐到期或未开通，请联系平台续费" });
  }
  return plan;
}

/** 本厂今日 LLM 用量（无行=0） */
export async function factoryLlmUsedToday(factoryId: number): Promise<number> {
  const rows = await stQuery(
    sql`SELECT calls FROM st_llm_usage_factory_daily
        WHERE factory_id = ${factoryId} AND day = CURDATE() LIMIT 1`,
  );
  return rows[0] ? Number(rows[0].calls) : 0;
}

/**
 * 本厂 LLM 用量 +1（UPSERT 幂等键 factory_id+day），返回新值；
 * 达 80%/100% 档位触发告警（每厂每日每档只发一次，alertOnceDaily 查重）。
 */
export async function recordFactoryLlmCall(factoryId: number, llmDailyLimit: number): Promise<number> {
  await stQuery(
    sql`INSERT INTO st_llm_usage_factory_daily (factory_id, day, calls)
        VALUES (${factoryId}, CURDATE(), 1)
        ON DUPLICATE KEY UPDATE calls = calls + 1`,
  );
  const used = await factoryLlmUsedToday(factoryId);
  if (llmDailyLimit > 0) {
    if (used >= llmDailyLimit) {
      await alertOnceDaily("error", "llm_usage_100", { used, limit: llmDailyLimit }, factoryId);
    } else if (used >= Math.floor(llmDailyLimit * 0.8)) {
      await alertOnceDaily("warn", "llm_usage_80", { used, limit: llmDailyLimit }, factoryId);
      // iter96 信号接入点：套餐用量触达 80%（仅跨越阈值当次发一条）→ C 级建议升级套餐
      if (used === Math.floor(llmDailyLimit * 0.8)) {
        await emitSignal(
          factoryId,
          "plan",
          "C",
          "套餐用量达 80%，建议升级套餐",
          `本厂 LLM 日用量 ${used}/${llmDailyLimit}（≥80%）。建议升级套餐以提升限额，需企业负责人确认。`,
        );
      }
    }
  }
  return used;
}

/** 新注册企业默认套餐：basic（3 熊猫 / 200 LLM 日 / 30 天），INSERT IGNORE 幂等 */
export async function initFactoryPlan(factoryId: number): Promise<void> {
  await stQuery(
    sql`INSERT IGNORE INTO st_factory_plan (factory_id, plan_code, seat_limit, llm_daily_limit, status, expire_at)
        VALUES (${factoryId}, 'basic', ${PLAN_TIERS.basic.seatLimit}, ${PLAN_TIERS.basic.llmDailyLimit},
                'active', DATE_ADD(NOW(), INTERVAL 30 DAY))`,
  );
}

export const billingRouter = createRouter({
  /** billing.plan（query, wb）：本厂套餐 + 今日用量；expire_at 过期动态视为 past_due（不写库） */
  plan: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const plan = await getFactoryPlan(factory.id);
      const llmUsedToday = await factoryLlmUsedToday(factory.id);
      if (!plan) {
        return {
          planCode: null,
          seatLimit: null,
          llmDailyLimit: null,
          llmUsedToday,
          expireAt: null,
          status: "none",
        };
      }
      const effStatus = planEffectiveStatus(plan);
      // iter96 信号接入点：读到 past_due → C 级建议续费信号（允许重复，emitSignal 永不 throw）
      if (effStatus === "past_due") {
        await emitSignal(
          factory.id,
          "plan",
          "C",
          "套餐已欠费（past_due），建议续费",
          `本厂套餐 ${plan.planCode} 已过期（expire_at=${plan.expireAt ?? "null"}），当前按 past_due 降权。建议尽快续费，需企业负责人确认。`,
        );
      }
      return {
        planCode: plan.planCode,
        seatLimit: plan.seatLimit,
        llmDailyLimit: plan.llmDailyLimit,
        llmUsedToday,
        expireAt: plan.expireAt,
        status: effStatus,
      };
    }),
});
