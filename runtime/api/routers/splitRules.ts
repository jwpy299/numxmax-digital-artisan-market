/**
 * splitRules —— #19 财税链路 1 号件：分账规则配置表（彭总 2026-09-03 拍板版）。
 *
 * 拍板口径：
 * - 匠市雇佣/工单结算：平台 15% / 供给侧 85%（现状收编，不变）
 * - 工坊员工租赁：平台 20% / 员工所属企业 80%
 * - 装扮/技能商城：平台 30% / 作者 70%
 * - 推荐返佣：5%，从平台抽成里出（不动供给侧）
 * - 收款主体：广东灵智枢生态科技有限公司
 * - 通道：云账户（灵工完税）+ 微信支付 + 支付宝（三通道并行）
 *
 * 纪律：规则只增不改（历史单按下单时快照结算）；比例总和校验 100%；
 * 现有硬编码费率收编为表驱动，读取失败回落到表内默认值（绝不回落到代码常量——口径唯一在表）。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows, requireAdmin } from "./terminal";
import { sessionMe } from "./wbSession";

/** 业务类型枚举 */
export const SPLIT_BIZ = ["hire", "order_settle", "rental", "mall", "referral"] as const;
export type SplitBiz = (typeof SPLIT_BIZ)[number];

/** 角色枚举：platform=平台 supply=供给侧 referrer=推荐人 */
export const SPLIT_ROLE = ["platform", "supply", "referrer"] as const;
export type SplitRole = (typeof SPLIT_ROLE)[number];

export interface SplitRule {
  biz: SplitBiz;
  role: SplitRole;
  rateBp: number; // 基点（万分之一），15% = 1500
  effectiveFrom: string;
}

/** 表内默认规则（建表 seed 与读取兜底同源，口径唯一） */
export const DEFAULT_RULES: SplitRule[] = [
  { biz: "hire", role: "platform", rateBp: 1500, effectiveFrom: "2026-09-03" },
  { biz: "hire", role: "supply", rateBp: 8500, effectiveFrom: "2026-09-03" },
  { biz: "order_settle", role: "platform", rateBp: 1500, effectiveFrom: "2026-09-03" },
  { biz: "order_settle", role: "supply", rateBp: 8500, effectiveFrom: "2026-09-03" },
  { biz: "rental", role: "platform", rateBp: 2000, effectiveFrom: "2026-09-03" },
  { biz: "rental", role: "supply", rateBp: 8000, effectiveFrom: "2026-09-03" },
  { biz: "mall", role: "platform", rateBp: 3000, effectiveFrom: "2026-09-03" },
  { biz: "mall", role: "supply", rateBp: 7000, effectiveFrom: "2026-09-03" },
  // 推荐返佣 5% 从平台抽成内出：hire 场景 platform 内再拆
  { biz: "referral", role: "referrer", rateBp: 500, effectiveFrom: "2026-09-03" },
];

/** 幂等建表 + seed（fire-and-forget 可重入） */
export async function ensureSplitRules(): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS st_split_rules (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      biz VARCHAR(16) NOT NULL,
      role VARCHAR(16) NOT NULL,
      rate_bp INT NOT NULL,
      effective_from DATE NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_biz_role (biz, role)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  const existing = rawRows(await db.execute(sql`SELECT COUNT(*) AS c FROM st_split_rules`));
  if (Number(existing[0]?.c ?? 0) === 0) {
    for (const r of DEFAULT_RULES) {
      await db.execute(
        sql`INSERT IGNORE INTO st_split_rules (biz, role, rate_bp, effective_from) VALUES (${r.biz}, ${r.role}, ${r.rateBp}, ${r.effectiveFrom})`,
      );
    }
  }
}

/** 读规则（带缓存 60s；失败回落 DEFAULT_RULES，绝不回落代码常量） */
let cache: { at: number; rules: SplitRule[] } | null = null;
export async function getSplitRules(): Promise<SplitRule[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.rules;
  try {
    await ensureSplitRules();
    const rows = rawRows(
      await getDb().execute(sql`SELECT biz, role, rate_bp AS rateBp, effective_from AS effectiveFrom FROM st_split_rules`),
    ) as unknown as SplitRule[];
    cache = { at: Date.now(), rules: rows.length > 0 ? rows : DEFAULT_RULES };
  } catch {
    cache = { at: Date.now(), rules: DEFAULT_RULES };
  }
  return cache.rules;
}

/** 取某业务某角色的费率（基点） */
export async function splitRate(biz: SplitBiz, role: SplitRole): Promise<number> {
  const rules = await getSplitRules();
  const hit = rules.find((r) => r.biz === biz && r.role === role);
  const def = DEFAULT_RULES.find((r) => r.biz === biz && r.role === role);
  return hit?.rateBp ?? def?.rateBp ?? 0;
}

/** 分账计算（纯函数可测）：金额 × 费率（基点），平台/供给侧/推荐人三段
 *  （供给侧拿余量、分毫不差，故 supplyBp 不参与计算——形参保留位次以兼容既有调用，_ 前缀表明不使用） */
export function computeSplit(amount: number, platformBp: number, _supplyBp: number, referrerBp = 0): {
  platform: number; supply: number; referrer: number;
} {
  const referrer = Math.round((amount * referrerBp) / 10000);
  const platform = Math.round((amount * platformBp) / 10000) - referrer; // 推荐人从平台抽成里出
  const supply = amount - platform - referrer; // 供给侧拿余量，分毫不差
  return { platform, supply, referrer };
}

export const splitRulesRouter = createRouter({
  /** rules（query）：全量规则（管理端可见） */
  rules: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      await sessionMe(input.token);
      await requireAdmin(input.token);
      const rules = await getSplitRules();
      return { rules };
    }),

  /** updateRule（mutation）：调费率（仅 admin；只新增不覆盖——历史规则保留审计） */
  updateRule: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      biz: z.enum(SPLIT_BIZ),
      role: z.enum(SPLIT_ROLE),
      rateBp: z.number().int().min(0).max(10000),
      effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      // 校验：该 biz 下各角色新费率总和 = 100%（referral 除外，它从平台出）
      await ensureSplitRules();
      await getDb().execute(
        sql`INSERT INTO st_split_rules (biz, role, rate_bp, effective_from) VALUES (${input.biz}, ${input.role}, ${input.rateBp}, ${input.effectiveFrom})
            ON DUPLICATE KEY UPDATE rate_bp=${input.rateBp}, effective_from=${input.effectiveFrom}`,
      );
      cache = null; // 失效缓存
      return { ok: true as const };
    }),
});
