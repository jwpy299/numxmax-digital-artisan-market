/**
 * leaderboard —— 开发者生态榜单（收益榜 / 热力榜 / 口碑榜 / 周新星）。
 *
 * 数据基于 dev_listings + dev_accounts 聚合，均为公开只读查询。
 * 榜单口径：
 * - revenue：listed 按 revenueToken desc limit 10
 * - heat：listed 按 usageCount desc limit 10
 * - reputation：listed 且 ratingCount>=10，按平均评分 desc limit 10（保留 1 位小数）
 * - newcomers：listed 且 14 天内上架，按 usageCount desc limit 10
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { devAccounts, devListings, type DevListing } from "@db/schema";
import { cached } from "./perfCache";

interface BoardRow {
  rank: number;
  listingId: number;
  name: string;
  kind: DevListing["kind"];
  devName: string | null;
  usageCount: number;
  revenueToken: number;
  avgRating: number | null;
  ratingCount: number;
}

function toBoardRow(
  r: { listing: DevListing; devName: string | null },
  idx: number,
): BoardRow {
  return {
    rank: idx + 1,
    listingId: r.listing.id,
    name: r.listing.name,
    kind: r.listing.kind,
    devName: r.devName,
    usageCount: r.listing.usageCount,
    revenueToken: r.listing.revenueToken,
    avgRating:
      r.listing.ratingCount > 0
        ? Math.round((r.listing.ratingSum / r.listing.ratingCount) * 10) / 10
        : null,
    ratingCount: r.listing.ratingCount,
  };
}

export const leaderboardRouter = createRouter({
  /** boards（public，无输入）：四榜聚合返回 */
  boards: publicQuery.query(async () => {
    // iter85：四榜为公开只读聚合（4 条 join 查询），缓存 60s
    return cached("leaderboard:boards", 60_000, async () => {
    const db = getDb();
    const listed = eq(devListings.status, "listed");
    const baseSelect = { listing: devListings, devName: devAccounts.displayName };
    const joinDev = () =>
      db
        .select(baseSelect)
        .from(devListings)
        .leftJoin(devAccounts, eq(devListings.devId, devAccounts.id));

    const [revenueRows, heatRows, reputationRows, newcomerRows] =
      await Promise.all([
        joinDev().where(listed).orderBy(desc(devListings.revenueToken)).limit(10),
        joinDev().where(listed).orderBy(desc(devListings.usageCount)).limit(10),
        joinDev()
          .where(and(listed, gte(devListings.ratingCount, 10)))
          .orderBy(
            desc(sql`${devListings.ratingSum} / ${devListings.ratingCount}`),
          )
          .limit(10),
        joinDev()
          .where(
            and(
              listed,
              sql`${devListings.listedAt} >= DATE_SUB(NOW(), INTERVAL 14 DAY)`,
            ),
          )
          .orderBy(desc(devListings.usageCount))
          .limit(10),
      ]);

    return {
      revenue: revenueRows.map(toBoardRow),
      heat: heatRows.map(toBoardRow),
      reputation: reputationRows.map(toBoardRow),
      newcomers: newcomerRows.map(toBoardRow),
    };
    });
  }),

  /** rules（public）：激励机制静态文案 */
  rules: publicQuery.query(() => [
    "匠人徽章体系：按累计计量收益与口碑授予「金牌匠人 / 银牌匠人 / 铜牌匠人」徽章，徽章在榜单与作品页展示。",
    "收益榜 Top3 激励：次周平台技术服务费由 20% 降至 10%，按周结算自动生效。",
    "口碑榜 / 热力榜前列作品可获得首页曝光位推荐，按周轮换。",
    "周新星激励：14 天内新上架且表现突出的作品授予「新锐匠人」标签，并获得平台流量扶持。",
    "所有榜单按平台计量数据（调用量 / 计量收益 / 雇主评分）自动计算，人工不得干预排序。",
  ]),
});
