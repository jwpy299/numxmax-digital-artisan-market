/**
 * wbProfile —— 迭代 34「个人AI资产档案」服务端路由（API-CONTRACT-v10 §1）。
 *
 * - myAssets()     当前 wb 用户个人资产全景：abilityProfile / income / creations / growth / badges
 * - profileCard()  精简名片（可分享视角：徽章 + 能力标签 + hasIncome 布尔，不含收入金额）
 *
 * 鉴权：wb token 在请求体（sessionMe → wb_users.authToken，参照 wbSession.ts）；
 * token 明文绝不落日志。
 *
 * 数据口径备注（与 wbDigest.ts / adminAnalytics.factoryHealth 一致）：
 * - tasks / agent_hire_records 的 enterpriseId 与 wb_factories.id 非同一域，
 *   按既有口径对齐 factoryId 统计（企业维度归属，tasks 无个人列，个人画像按
 *   所在企业口径聚合并在此标注）；
 * - income 复用 skillShop.staffIncome 的 wb 分支口径（st_creator_income
 *   owner_type='staff' AND owner_id=wb userId），金额单位 Token（调用计量），
 *   结算兑换通道未来开放；
 * - creations 取 st_skill_packs creator 维度（creator_type='staff' AND creator_id=wb userId）；
 * - growth 近 6 个月任务数 + 反馈均分（useful=5 / rework=3 / useless=1，规则映射）。
 *
 * st_ 表一律 raw SQL 访问（db/sync-ops.mts 幂等创建），缺失按空集降级，全新员工空态不报错。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";
import { sessionMe } from "./wbSession";

const tokenInput = z.object({ token: z.string().trim().min(1) });

/** 查询兜底：表缺失/异常按空集降级（seed/迁移窗口 + 全新员工空态） */
async function rows(statement: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  try {
    return rawRows(await getDb().execute(statement));
  } catch {
    return [];
  }
}

const toDate = (v: unknown) => (v ? new Date(String(v)) : null);

/** 近 6 个月月份序列（YYYY-MM，含当月，升序） */
function last6Months(): string[] {
  const out: string[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 5; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

interface BadgeDto {
  key: string;
  name: string;
  desc: string;
  earned: boolean;
  progress: number; // 0-1
  hint: string; // 未获得时的进度提示（已获得时为达成说明）
}

interface AssetsData {
  abilityProfile: {
    categories: Array<{ name: string; count: number }>;
    topAgents: Array<{ name: string; tasks: number }>;
    tasksDone: number;
    praiseRate: number | null; // 好评率 %，无反馈为 null
    hireCount: number;
  };
  income: {
    accruedTotal: number;
    settledTotal: number;
    note: string;
    items: Array<{
      id: number;
      packKey: string | null;
      title: string | null;
      amount: number;
      period: string;
      status: string;
      createdAt: Date | null;
    }>;
  };
  creations: Array<{
    packKey: string;
    title: string;
    status: string;
    salesCount: number;
    priceTokens: number;
    listedAt: Date | null;
  }>;
  growth: Array<{ month: string; tasks: number; score: number | null }>;
  badges: BadgeDto[];
}

/** 聚合当前用户资产数据（myAssets / profileCard 共用一次查询） */
async function loadAssets(userId: number, factoryId: number): Promise<AssetsData> {
  const months = last6Months();
  const since = `${months[0]}-01`;
  const [
    taskTotal,
    catRows,
    agentRows,
    hireRows,
    fbStat,
    fbMonthly,
    taskMonthly,
    activeDays,
    incomeTotals,
    incomeItems,
    creationRows,
    feedbackCount,
  ] = await Promise.all([
    rows(
      sql`SELECT COUNT(*) AS c FROM tasks
          WHERE enterpriseId = ${factoryId} AND status = 'completed'`,
    ),
    rows(
      sql`SELECT a.industryGroup AS name, COUNT(*) AS count
          FROM tasks t INNER JOIN agents a ON a.id = t.agentId
          WHERE t.enterpriseId = ${factoryId}
          GROUP BY a.industryGroup ORDER BY count DESC LIMIT 8`,
    ),
    rows(
      sql`SELECT a.name AS name, COUNT(*) AS tasks
          FROM tasks t INNER JOIN agents a ON a.id = t.agentId
          WHERE t.enterpriseId = ${factoryId}
          GROUP BY a.id, a.name ORDER BY tasks DESC LIMIT 3`,
    ),
    rows(
      sql`SELECT COUNT(*) AS c FROM agent_hire_records WHERE enterpriseId = ${factoryId}`,
    ),
    rows(
      sql`SELECT COUNT(*) AS total,
                 SUM(CASE WHEN \`signal\` = 'useful' THEN 1 ELSE 0 END) AS useful
          FROM st_skill_feedback WHERE factory_id = ${factoryId}`,
    ),
    rows(
      sql`SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
                 AVG(CASE \`signal\` WHEN 'useful' THEN 5 WHEN 'rework' THEN 3 ELSE 1 END) AS score
          FROM st_skill_feedback
          WHERE factory_id = ${factoryId} AND created_at >= ${since}
          GROUP BY month`,
    ),
    rows(
      sql`SELECT DATE_FORMAT(createdAt, '%Y-%m') AS month, COUNT(*) AS tasks
          FROM tasks WHERE enterpriseId = ${factoryId} AND createdAt >= ${since}
          GROUP BY month`,
    ),
    rows(
      sql`SELECT COUNT(DISTINCT DATE(createdAt)) AS days7
          FROM tasks
          WHERE enterpriseId = ${factoryId}
            AND createdAt >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)`,
    ),
    rows(
      sql`SELECT status, SUM(amount) AS amount FROM st_creator_income
          WHERE owner_type = 'staff' AND owner_id = ${userId} GROUP BY status`,
    ),
    rows(
      sql`SELECT i.id, i.amount, i.period, i.status, i.created_at,
                 p.pack_key, k.title
          FROM st_creator_income i
          LEFT JOIN st_pack_purchases p ON p.id = i.purchase_id
          LEFT JOIN st_skill_packs k ON k.pack_key = p.pack_key
          WHERE i.owner_type = 'staff' AND i.owner_id = ${userId}
          ORDER BY i.id DESC LIMIT 100`,
    ),
    rows(
      sql`SELECT pack_key, title, status, sales_count, price_tokens, listed_at
          FROM st_skill_packs
          WHERE creator_type = 'staff' AND creator_id = ${userId}
          ORDER BY id DESC LIMIT 100`,
    ),
    rows(
      sql`SELECT COUNT(*) AS c FROM st_skill_feedback WHERE factory_id = ${factoryId}`,
    ),
  ]);

  const tasksDone = Number(taskTotal[0]?.c ?? 0);
  const fbTotal = Number(fbStat[0]?.total ?? 0);
  const fbUseful = Number(fbStat[0]?.useful ?? 0);
  const praiseRate = fbTotal > 0 ? Math.round((fbUseful / fbTotal) * 100) : null;
  const hireCount = Number(hireRows[0]?.c ?? 0);

  const accruedTotal = Number(
    incomeTotals.find((t) => String(t.status) === "accrued")?.amount ?? 0,
  );
  const settledTotal = Number(
    incomeTotals.find((t) => String(t.status) === "settled")?.amount ?? 0,
  );

  const creations = creationRows.map((r) => ({
    packKey: String(r.pack_key),
    title: String(r.title ?? ""),
    status: String(r.status),
    salesCount: Number(r.sales_count ?? 0),
    priceTokens: Number(r.price_tokens ?? 0),
    listedAt: toDate(r.listed_at),
  }));

  const taskByMonth = new Map(taskMonthly.map((r) => [String(r.month), Number(r.tasks ?? 0)]));
  const scoreByMonth = new Map(
    fbMonthly.map((r) => [String(r.month), r.score == null ? null : Number(r.score)]),
  );
  const growth = months.map((month) => ({
    month,
    tasks: taskByMonth.get(month) ?? 0,
    score: scoreByMonth.has(month) ? scoreByMonth.get(month)! : null,
  }));

  const days7 = Number(activeDays[0]?.days7 ?? 0);
  const fbCount = Number(feedbackCount[0]?.c ?? 0);
  const listedCount = creations.filter((c) => c.status === "listed").length;
  const hasIncome = accruedTotal + settledTotal > 0;

  const badge = (
    key: string,
    name: string,
    desc: string,
    earned: boolean,
    current: number,
    target: number,
    hint: string,
  ): BadgeDto => ({
    key,
    name,
    desc,
    earned,
    progress: earned ? 1 : Math.min(1, target > 0 ? current / target : 0),
    hint: earned ? "已达成" : hint,
  });

  const badges: BadgeDto[] = [
    badge("first_task", "启程者", "首次完成任务", tasksDone >= 1, tasksDone, 1,
      `完成 1 个任务即可获得（当前 ${tasksDone}）`),
    badge("task_10", "任务能手", "累计完成 10 个任务", tasksDone >= 10, tasksDone, 10,
      `累计完成 10 个任务（当前 ${tasksDone}/10）`),
    badge("first_listing", "上架首秀", "首次上架技能包", listedCount >= 1, listedCount, 1,
      "在技能商店上架 1 个技能包即可获得"),
    badge("first_income", "首笔收益", "首次获得创作收益", hasIncome, hasIncome ? 1 : 0, 1,
      "技能包产生首笔创作收益即可获得"),
    badge("active_7d", "七日坚守", "连续活跃 7 天", days7 >= 7, days7, 7,
      `近 7 天每天都有任务记录（当前 ${days7}/7 天）`),
    badge("feedback_10", "热心反馈", "累计提交 10 次技能反馈", fbCount >= 10, fbCount, 10,
      `累计提交 10 次技能反馈（当前 ${fbCount}/10）`),
  ];

  return {
    abilityProfile: {
      categories: catRows.map((r) => ({ name: String(r.name ?? "未分类"), count: Number(r.count ?? 0) })),
      topAgents: agentRows.map((r) => ({ name: String(r.name ?? ""), tasks: Number(r.tasks ?? 0) })),
      tasksDone,
      praiseRate,
      hireCount,
    },
    income: {
      accruedTotal,
      settledTotal,
      note: "金额单位为 Token（调用计量）；Token 为平台内结算点数，结算兑换通道未来开放",
      items: incomeItems.map((r) => ({
        id: Number(r.id),
        packKey: r.pack_key == null ? null : String(r.pack_key),
        title: r.title == null ? null : String(r.title),
        amount: Number(r.amount ?? 0),
        period: String(r.period ?? ""),
        status: String(r.status ?? ""),
        createdAt: toDate(r.created_at),
      })),
    },
    creations,
    growth,
    badges,
  };
}

export const wbProfileRouter = createRouter({
  /** myAssets：个人资产全景（能力画像 + 收益 + 创作 + 成长 + 徽章；空态友好） */
  myAssets: publicQuery.input(tokenInput).query(async ({ input }) => {
    const { user, factory } = await sessionMe(input.token);
    const assets = await loadAssets(Number(user.id), Number(factory.id));
    return {
      displayName: String(user.displayName ?? user.username),
      enterpriseName: String(factory.enterpriseName ?? ""),
      role: String(user.role ?? "member"),
      ...assets,
      note: "口径说明：任务/反馈/雇佣按所在企业（factoryId）归属统计（tasks 无个人列，与 wbDigest/factoryHealth 口径一致）；收益与创作为个人维度（wb userId）。",
    };
  }),

  /** profileCard：精简名片（徽章 + 能力标签 + hasIncome 布尔，不含收入金额） */
  profileCard: publicQuery.input(tokenInput).query(async ({ input }) => {
    const { user, factory } = await sessionMe(input.token);
    const assets = await loadAssets(Number(user.id), Number(factory.id));
    const hasIncome = assets.income.accruedTotal + assets.income.settledTotal > 0;
    return {
      displayName: String(user.displayName ?? user.username),
      enterpriseName: String(factory.enterpriseName ?? ""),
      abilityTags: assets.abilityProfile.categories.slice(0, 5).map((c) => c.name),
      topAgents: assets.abilityProfile.topAgents,
      tasksDone: assets.abilityProfile.tasksDone,
      praiseRate: assets.abilityProfile.praiseRate,
      badges: assets.badges,
      hasIncome,
      note: "精简名片不含收入金额明细；Token 为平台内结算点数，结算兑换通道未来开放",
    };
  }),
});
