/**
 * skillStats —— Harness H1「技能真实化审计」第一波：执行器登记 + 真实成功率。
 *
 * 口径：
 * - 执行器登记数据源 = skillExecutor.SKILL_EXECUTOR_MAP（专用 6 + 通用 14，共 20 个真执行器）；
 *   专用工具类（docx/xlsx/pptx/data/research/claw）统一登记为 'tool'，通用类登记为各自 llm_* 类别。
 * - badgeOf：有真实执行器（tool/llm_doc/llm_analysis/llm_kb_qa/llm_ppt/llm_sheet）→ 'real'（⚡ 真执行器）；
 *   无执行器或仅 'generic' 兜底 → 'generative'（✨ 生成式）。
 * - skillSuccessRate：近 90 天 st_skill_calls（db/sync-m20.mts 建表，voiceSkills.recordSkillCall 记账）
 *   成功率 = ok / 总调用 × 100（保留 1 位小数）；样本不足 5 次返回 null（前端展示「样本不足」，
 *   不再回退种子 successRate=98）。
 * - 所有 DB 访问失败静默降级（表缺失/未迁移窗口不阻断列表与详情）。
 */
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";
import { SKILL_EXECUTOR_MAP, isGenericExecutorKind } from "./skillExecutor";

// ─── 执行器登记 ──────────────────────────────────────────────────────────────

/** DB 登记口径的执行器类型（st_skills.executor_kind / skills.executorKind 列值） */
export type RegisteredExecutorKind =
  | "tool"
  | "llm_doc"
  | "llm_analysis"
  | "llm_kb_qa"
  | "llm_ppt"
  | "llm_sheet"
  | "generic";

/** 真实执行器类别集合（'generic' 为无执行器兜底，不算真执行器） */
const REAL_EXECUTOR_KINDS: ReadonlySet<string> = new Set([
  "tool",
  "llm_doc",
  "llm_analysis",
  "llm_kb_qa",
  "llm_ppt",
  "llm_sheet",
]);

/** skillKey → 登记执行器类型：命中 SKILL_EXECUTOR_MAP 的 20 个真执行器；未命中返回 null */
export function executorKindOf(skillKey: string): RegisteredExecutorKind | null {
  const mapped = SKILL_EXECUTOR_MAP[skillKey];
  if (!mapped) return null;
  // 专用 6 工具（docx/xlsx/pptx/data/research/claw）统一登记为 'tool'
  return isGenericExecutorKind(mapped) ? mapped : "tool";
}

/** 全量登记表（迁移脚本 sync-h1.mts 回填数据源）：skillKey → executorKind */
export function executorRegistry(): Record<string, RegisteredExecutorKind> {
  const out: Record<string, RegisteredExecutorKind> = {};
  for (const key of Object.keys(SKILL_EXECUTOR_MAP)) {
    const kind = executorKindOf(key);
    if (kind) out[key] = kind;
  }
  return out;
}

// ─── 徽标 ────────────────────────────────────────────────────────────────────

export type SkillBadge = "real" | "generative";

/** executorKind → 徽标：真实执行器 → 'real'；null/'generic'/未知 → 'generative' */
export function badgeOfKind(kind: string | null | undefined): SkillBadge {
  return kind != null && REAL_EXECUTOR_KINDS.has(kind) ? "real" : "generative";
}

/** skillKey → 徽标（st_skills 口径，数据源为 SKILL_EXECUTOR_MAP 登记） */
export function badgeOf(skillKey: string): SkillBadge {
  return badgeOfKind(executorKindOf(skillKey));
}

// ─── 真实成功率（近 90 天 st_skill_calls）────────────────────────────────────

/** 成功率口径：ok/total 所需最小样本量；不足返回 null（样本不足，不展示种子 98） */
export const MIN_RATE_SAMPLES = 5;
/** 统计窗口：近 90 天调用记录 */
const RATE_WINDOW_DAYS = 90;

interface RateAgg {
  total: number;
  ok: number;
}

function rateFromAgg(agg: RateAgg | undefined): number | null {
  if (!agg || agg.total < MIN_RATE_SAMPLES) return null; // 样本不足
  return Math.round((agg.ok / agg.total) * 1000) / 10;
}

/** 单技能真实成功率（%）；样本 <5 或查询失败返回 null（失败静默不阻断） */
export async function skillSuccessRate(skillKey: string): Promise<number | null> {
  const rates = await skillSuccessRates([skillKey]);
  return rates.get(skillKey) ?? null;
}

/** 批量真实成功率：一次 GROUP BY 查询，返回 skillKey → rate（样本不足/无记录的技能不出现在 map 中） */
export async function skillSuccessRates(skillKeys: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const keys = [...new Set(skillKeys.map((k) => k.trim()).filter(Boolean))].slice(0, 500);
  if (keys.length === 0) return out;
  try {
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT skill_key AS skillKey, COUNT(*) AS total,
                   SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok
            FROM st_skill_calls
            WHERE skill_key IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})
              AND created_at >= DATE_SUB(NOW(), INTERVAL ${RATE_WINDOW_DAYS} DAY)
            GROUP BY skill_key`,
      ),
    );
    for (const r of rows) {
      const rate = rateFromAgg({ total: Number(r.total ?? 0), ok: Number(r.ok ?? 0) });
      if (rate !== null) out.set(String(r.skillKey), rate);
    }
  } catch {
    // st_skill_calls 表缺失/查询失败：静默降级，全部视为样本不足
  }
  return out;
}

// ─── 展示元信息（匠市接线用，失败静默）───────────────────────────────────────

export interface SkillMarketMeta {
  executorKind: RegisteredExecutorKind | null;
  badge: SkillBadge;
  /** null = 样本不足（前端展示「样本不足」，不回退种子 98） */
  realSuccessRate: number | null;
}

/**
 * 批量装配展示元信息。resolveKey 给出行对应的 st_skill_calls.skill_key 与登记的 executorKind：
 * - st_skills 系（技能商店 pack）：kind 由 executorKindOf(source_skill_key) 得；
 * - 匠市 V/U 技能（drizzle skills）：kind 取 skills.executorKind 列（sync-h1 回填，无映射为 'generic'）。
 * 成功率查询整体失败时静默降级为全 null（徽标仍可展示）。
 */
export async function buildSkillMetas(
  entries: Array<{ rateKey: string | null; executorKind: string | null }>,
): Promise<SkillMarketMeta[]> {
  const rateKeys = entries.map((e) => e.rateKey).filter((k): k is string => !!k);
  const rates = await skillSuccessRates(rateKeys);
  return entries.map((e) => {
    // 未登记的 kind 按 'generic' 归一（徽标口径：无真执行器即生成式）
    const kind = (e.executorKind ?? null) as RegisteredExecutorKind | null;
    return {
      executorKind: kind,
      badge: badgeOfKind(kind),
      realSuccessRate: e.rateKey ? (rates.get(e.rateKey) ?? null) : null,
    };
  });
}
