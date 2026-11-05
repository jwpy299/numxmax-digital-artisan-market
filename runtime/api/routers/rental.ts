/**
 * rental —— #19 财税链路 3 号件：工坊员工租赁（企业→企业）+ 20/80 分账（彭总拍板）。
 *
 * 链路：供给侧企业上架工坊员工（wb_listings type=agent status=listed）
 *   → 租户企业下单（本路由 rent）→ 原子扣租户企业钱包
 *   → 分账：平台 20%（差额沉淀）/ 供给侧所属企业 80%（入 enterprises.tokenBalance）
 *   → 台账 st_rental_orders + 双侧钱包流水 + 推荐返佣（租户首单，复用 referral）
 * 纪律：失败回补租户钱包（绝不钱货两空）；rental 费率表驱动（st_split_rules）；
 *       自家员工自家不能租；一切写操作留 wallet flows 审计。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";
import { sessionMe } from "./wbSession";
import { splitRate } from "./splitRules";
import { settleReferralBonus } from "./referral";
import { debitForPurchase } from "./tokenLedger";

/** 幂等建表 */
async function ensureRentalTables(): Promise<void> {
  await getDb().execute(sql`
    CREATE TABLE IF NOT EXISTS st_rental_orders (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      order_no VARCHAR(40) NOT NULL,
      listing_id BIGINT UNSIGNED NOT NULL,
      tenant_factory_id BIGINT UNSIGNED NOT NULL,
      owner_factory_id BIGINT UNSIGNED NOT NULL,
      months INT NOT NULL,
      amount INT NOT NULL,
      platform_fee INT NOT NULL,
      owner_share INT NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ends_at DATETIME NULL,
      UNIQUE KEY uk_order_no (order_no),
      KEY idx_tenant (tenant_factory_id),
      KEY idx_owner (owner_factory_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

function rentalOrderNo(id: number): string {
  return `RT-${String(id).padStart(6, "0")}`;
}

export const rentalRouter = createRouter({
  /** rentalList（query）：可租的工坊员工市场（别家上架的） */
  rentalList: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const db = getDb();
      const rows = rawRows(
        await db.execute(
          sql`SELECT l.id, l.title, l.description, l.price, l.factoryId AS ownerFactoryId,
                     f.enterpriseName AS ownerName, l.createdAt AS listedAt
              FROM wb_listings l
              JOIN wb_factories f ON f.id = l.factoryId
              WHERE l.type='agent' AND l.status='listed' AND l.factoryId != ${factory.id}
              ORDER BY l.createdAt DESC LIMIT 50`,
        ),
      );
      return { listings: rows };
    }),

  /** rent（mutation）：租赁下单 + 20/80 分账 */
  rent: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      listingId: z.number().int().positive(),
      months: z.number().int().min(1).max(12).default(1),
    }))
    .mutation(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const db = getDb();
      await ensureRentalTables();

      const rows = rawRows(
        await db.execute(
          sql`SELECT id, title, price, factoryId AS ownerFactoryId, status FROM wb_listings
              WHERE id=${input.listingId} AND type='agent' LIMIT 1`,
        ),
      ) as unknown as { id: number; title: string; price: number; ownerFactoryId: number; status: string }[];
      const listing = rows[0];
      if (!listing || listing.status !== "listed") {
        throw new TRPCError({ code: "NOT_FOUND", message: "该数字员工不在架或已下架" });
      }
      if (Number(listing.ownerFactoryId) === factory.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "不能租赁自家工坊的员工" });
      }

      const amount = Number(listing.price) * input.months;
      const platformBp = await splitRate("rental", "platform");
      const platformFee = Math.round((amount * platformBp) / 10000);
      const ownerShare = amount - platformFee;

      // 1. 原子扣租户企业钱包
      const { balanceAfter } = await debitForPurchase({
        factoryId: factory.id,
        amount,
        packKey: `rental:${listing.id}`,
      });

      // 2. 建单（失败回补租户钱包，绝不钱货两空）
      let orderId: number;
      try {
        const ins = await db.execute(
          sql`INSERT INTO st_rental_orders (order_no, listing_id, tenant_factory_id, owner_factory_id, months, amount, platform_fee, owner_share, status, ends_at)
              VALUES ('', ${listing.id}, ${factory.id}, ${Number(listing.ownerFactoryId)}, ${input.months}, ${amount}, ${platformFee}, ${ownerShare}, 'active', DATE_ADD(NOW(), INTERVAL ${input.months} MONTH))`,
        );
        const first = Array.isArray(ins) ? (ins as unknown[])[0] : ins;
        orderId = Number((first as { insertId?: number })?.insertId ?? 0);
        await db.execute(
          sql`UPDATE st_rental_orders SET order_no=${rentalOrderNo(orderId)} WHERE id=${orderId}`,
        );
      } catch (e) {
        await db.execute(
          sql`UPDATE enterprises SET tokenBalance = tokenBalance + ${amount} WHERE id = ${factory.id}`,
        );
        throw e;
      }

      // 3. 供给侧企业入账 80%
      await db.execute(
        sql`UPDATE enterprises SET tokenBalance = tokenBalance + ${ownerShare} WHERE id = ${Number(listing.ownerFactoryId)}`,
      );
      await db.execute(
        sql`INSERT INTO st_wallet_flows (owner_type, owner_id, direction, amount, balance_after, biz_type, ref_id, note)
            SELECT 'enterprise', ${Number(listing.ownerFactoryId)}, 'in', ${ownerShare}, tokenBalance, 'rental_credit', ${`RT-${orderId}`}, CONCAT('工坊员工出租收入（平台已扣 ', ${platformFee}, '）')
            FROM enterprises WHERE id=${Number(listing.ownerFactoryId)}`,
      );

      // 4. 推荐返佣（租户企业首单，fire-and-forget）
      void settleReferralBonus({
        factoryId: factory.id,
        orderRef: `rental:${orderId}`,
        amount,
      }).catch(() => {});

      return { ok: true as const, orderId, orderNo: rentalOrderNo(orderId), amount, ownerShare, balanceAfter };
    }),

  /** myRentals（query）：我租的 + 我租出的 */
  myRentals: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const db = getDb();
      const renting = rawRows(
        await db.execute(
          sql`SELECT order_no AS orderNo, listing_id AS listingId, months, amount, status, created_at AS createdAt, ends_at AS endsAt
              FROM st_rental_orders WHERE tenant_factory_id=${factory.id} ORDER BY id DESC LIMIT 50`,
        ),
      );
      const rentedOut = rawRows(
        await db.execute(
          sql`SELECT order_no AS orderNo, listing_id AS listingId, months, owner_share AS income, status, created_at AS createdAt
              FROM st_rental_orders WHERE owner_factory_id=${factory.id} ORDER BY id DESC LIMIT 50`,
        ),
      );
      return { renting, rentedOut };
    }),
});
