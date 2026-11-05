/**
 * referral —— #19 财税链路 2 号件：推荐返佣管线（彭总拍板：5% 从平台抽成里出，绝不动供给侧）。
 *
 * 规则：
 * - 触发点：雇佣成交（hire.create 结算后 fire-and-forget 调用）
 * - 推荐人认定：雇主企业的「创建 admin 用户」的 wb_users.invitedBy（邀请渠道审计列，M16 已有）
 * - 计提：订单额 × 5%（referral 规则表），进推荐人个人词元钱包 + st_referral_ledger 台账
 * - 防刷：同一企业只对其「首笔」雇佣单计提（推荐奖励的是拉新，不是复购）；
 *   推荐人与雇主同人为自己时跳过；无邀请关系静默跳过（零打扰主链）
 */
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";
import { splitRate } from "./splitRules";
import { creditUser } from "./tokenLedger";

/** 幂等建表 */
export async function ensureReferralLedger(): Promise<void> {
  await getDb().execute(sql`
    CREATE TABLE IF NOT EXISTS st_referral_ledger (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      factory_id BIGINT UNSIGNED NOT NULL,
      referrer_user_id BIGINT UNSIGNED NOT NULL,
      order_ref VARCHAR(64) NOT NULL,
      order_amount INT NOT NULL,
      bonus INT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_factory_order (factory_id, order_ref),
      KEY idx_referrer (referrer_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

/**
 * 计提推荐返佣（fire-and-forget；任何失败静默，绝不阻塞雇佣主链）。
 * @returns true=已计提 false=无推荐关系/已计提过/自推荐
 */
export async function settleReferralBonus(opts: {
  factoryId: number;
  orderRef: string;   // 如 hire:<hireId>
  amount: number;
}): Promise<boolean> {
  try {
    await ensureReferralLedger();
    const db = getDb();
    // 该企业的首笔返佣是否已计提（一企一次）
    const dup = rawRows(
      await db.execute(sql`SELECT id FROM st_referral_ledger WHERE factory_id=${opts.factoryId} LIMIT 1`),
    );
    if (dup.length > 0) return false;
    // 找企业创建 admin（最早创建的 admin/owner 用户）
    const adminRows = rawRows(
      await db.execute(
        sql`SELECT id, invitedBy FROM wb_users
            WHERE factoryId=${opts.factoryId} AND role IN ('admin','owner')
            ORDER BY id ASC LIMIT 1`,
      ),
    ) as unknown as { id: number; invitedBy: number | null }[];
    const inviterId = adminRows[0]?.invitedBy ? Number(adminRows[0].invitedBy) : null;
    if (!inviterId) return false;
    if (inviterId === adminRows[0]?.id) return false; // 自推荐
    // 计提
    const bp = await splitRate("referral", "referrer");
    if (bp <= 0) return false;
    const bonus = Math.round((opts.amount * bp) / 10000);
    if (bonus <= 0) return false;
    await db.execute(
      sql`INSERT INTO st_referral_ledger (factory_id, referrer_user_id, order_ref, order_amount, bonus)
          VALUES (${opts.factoryId}, ${inviterId}, ${opts.orderRef}, ${opts.amount}, ${bonus})`,
    );
    await creditUser({
      userId: inviterId,
      amount: bonus,
      bizType: "referral_bonus",
      refId: opts.orderRef,
      note: `推荐返佣（新企业首单 ${opts.orderRef}）`,
    });
    return true;
  } catch {
    return false; // 静默
  }
}
