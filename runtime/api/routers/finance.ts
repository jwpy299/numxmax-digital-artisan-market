/**
 * finance —— 财务中心（只读）：充值收入、Token 流通、钱包存量、北极星、技能工具健康一屏总览。
 * 原则：本路由不产生任何写操作；数字全部来自既有台账表现查。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { createRouter, publicQuery } from "../middleware";
import { requireAdmin, stQuery } from "./terminal";
import { getSkillToolStats, saveArtifact } from "./agentTools";

/** 月份入参：YYYY-MM，严格校验防注入 */
const yearMonthInput = z.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "月份格式须为 YYYY-MM");

/** 月份闭开区间 [monthStart, nextMonthStart)，参数化绑定不拼 SQL */
function monthRange(yearMonth: string): { start: string; end: string } {
  const [y, m] = yearMonth.split("-").map(Number);
  const start = `${yearMonth}-01`;
  const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { start, end };
}

export const financeRouter = createRouter({
  overview: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const topupRows = await stQuery(
        sql`SELECT
              SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmedCount,
              COALESCE(SUM(CASE WHEN status = 'confirmed' THEN amount END), 0) AS confirmedAmount,
              COALESCE(SUM(CASE WHEN status = 'confirmed' THEN price_cny END), 0) AS confirmedCny,
              SUM(CASE WHEN status = 'confirmed' AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS d30Count,
              COALESCE(SUM(CASE WHEN status = 'confirmed' AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN price_cny END), 0) AS d30Cny,
              COALESCE(SUM(CASE WHEN status = 'confirmed' AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN price_cny END), 0) AS d7Cny,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pendingCount
            FROM st_token_topups`,
      );
      const flowRows = await stQuery(
        sql`SELECT COUNT(*) AS flowCount,
              COALESCE(SUM(amount), 0) AS flowTotal,
              COALESCE(SUM(platformFee), 0) AS feeTotal,
              COALESCE(SUM(masterShare), 0) AS shareTotal,
              COALESCE(SUM(CASE WHEN createdAt >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN amount END), 0) AS d30Total,
              COALESCE(SUM(CASE WHEN createdAt >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN platformFee END), 0) AS d30Fee
            FROM token_transactions`,
      );
      const walletRows = await stQuery(
        sql`SELECT COALESCE(SUM(tokenBalance), 0) AS walletTotal,
              SUM(CASE WHEN tokenBalance > 0 THEN 1 ELSE 0 END) AS walletHolders
            FROM enterprises`,
      );
      const northRows = await stQuery(
        sql`SELECT fb_signal AS fbSignal, COUNT(*) AS c FROM st_artifact_feedback
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY fb_signal`,
      );
      const adopted = Number(northRows.find((r) => String(r.fbSignal) === "adopted")?.c ?? 0);
      const rejected = Number(northRows.find((r) => String(r.fbSignal) === "rejected")?.c ?? 0);
      const t = topupRows[0] ?? {};
      const f = flowRows[0] ?? {};
      const w = walletRows[0] ?? {};
      return {
        topups: {
          confirmedCount: Number(t.confirmedCount ?? 0),
          confirmedAmount: Number(t.confirmedAmount ?? 0),
          confirmedCny: Number(t.confirmedCny ?? 0),
          d30Count: Number(t.d30Count ?? 0),
          d30Cny: Number(t.d30Cny ?? 0),
          d7Cny: Number(t.d7Cny ?? 0),
          pendingCount: Number(t.pendingCount ?? 0),
        },
        flows: {
          flowCount: Number(f.flowCount ?? 0),
          flowTotal: Number(f.flowTotal ?? 0),
          feeTotal: Number(f.feeTotal ?? 0),
          shareTotal: Number(f.shareTotal ?? 0),
          d30Total: Number(f.d30Total ?? 0),
          d30Fee: Number(f.d30Fee ?? 0),
        },
        wallets: {
          walletTotal: Number(w.walletTotal ?? 0),
          walletHolders: Number(w.walletHolders ?? 0),
        },
        northStar: {
          weekAdopted: adopted,
          weekRejected: rejected,
          adoptRate: adopted + rejected > 0 ? Math.round((adopted / (adopted + rejected)) * 100) : null,
        },
        skillTools: getSkillToolStats(),
      };
    }),

  /** 迭代56：按企业拆账（双轨口径，无跨系统FK，如实分列）
   *  - 匠市账：enterprises 钱包余额 + token_transactions 流通（enterpriseId 对齐）
   *  - 充值账：st_token_topups 按 wb_factories 聚合（工作台企业空间） */
  byEnterprise: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const marketRows = await stQuery(
        sql`SELECT e.id, e.name, e.tokenBalance,
              COUNT(t.id) AS flowCount,
              COALESCE(SUM(t.amount), 0) AS flowTotal,
              COALESCE(SUM(t.platformFee), 0) AS feeTotal,
              COALESCE(SUM(t.masterShare), 0) AS shareTotal
            FROM enterprises e
            LEFT JOIN token_transactions t ON t.enterpriseId = e.id
            GROUP BY e.id, e.name, e.tokenBalance
            ORDER BY e.tokenBalance DESC`,
      );
      const topupRows = await stQuery(
        sql`SELECT f.id, f.enterpriseName,
              SUM(CASE WHEN p.status = 'confirmed' THEN 1 ELSE 0 END) AS confirmedCount,
              COALESCE(SUM(CASE WHEN p.status = 'confirmed' THEN p.amount END), 0) AS confirmedAmount,
              COALESCE(SUM(CASE WHEN p.status = 'confirmed' THEN p.price_cny END), 0) AS confirmedCny,
              SUM(CASE WHEN p.status = 'pending' THEN 1 ELSE 0 END) AS pendingCount
            FROM st_token_topups p
            JOIN wb_factories f ON f.id = p.factory_id
            GROUP BY f.id, f.enterpriseName
            ORDER BY confirmedCny DESC`,
      );
      return {
        market: marketRows.map((r) => ({
          id: Number(r.id),
          name: String(r.name),
          tokenBalance: Number(r.tokenBalance ?? 0),
          flowCount: Number(r.flowCount ?? 0),
          flowTotal: Number(r.flowTotal ?? 0),
          feeTotal: Number(r.feeTotal ?? 0),
          shareTotal: Number(r.shareTotal ?? 0),
        })),
        topups: topupRows.map((r) => ({
          id: Number(r.id),
          name: String(r.enterpriseName),
          confirmedCount: Number(r.confirmedCount ?? 0),
          confirmedAmount: Number(r.confirmedAmount ?? 0),
          confirmedCny: Number(r.confirmedCny ?? 0),
          pendingCount: Number(r.pendingCount ?? 0),
        })),
      };
    }),

  /** 迭代56：月度对账导出 —— 真 .xlsx（多sheet）走产出物管线，可经 artifactDownload 下载 */
  exportLedger: publicQuery
    .input(z.object({ token: z.string().trim().min(1), yearMonth: yearMonthInput }))
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const { start, end } = monthRange(input.yearMonth);

      // 1) 月度汇总
      const sumRows = await stQuery(
        sql`SELECT
              (SELECT COUNT(*) FROM st_token_topups WHERE status='confirmed' AND created_at >= ${start} AND created_at < ${end}) AS topupCount,
              (SELECT COALESCE(SUM(amount),0) FROM st_token_topups WHERE status='confirmed' AND created_at >= ${start} AND created_at < ${end}) AS topupAmount,
              (SELECT COALESCE(SUM(price_cny),0) FROM st_token_topups WHERE status='confirmed' AND created_at >= ${start} AND created_at < ${end}) AS topupCny,
              (SELECT COUNT(*) FROM token_transactions WHERE createdAt >= ${start} AND createdAt < ${end}) AS flowCount,
              (SELECT COALESCE(SUM(amount),0) FROM token_transactions WHERE createdAt >= ${start} AND createdAt < ${end}) AS flowTotal,
              (SELECT COALESCE(SUM(platformFee),0) FROM token_transactions WHERE createdAt >= ${start} AND createdAt < ${end}) AS feeTotal,
              (SELECT COALESCE(SUM(masterShare),0) FROM token_transactions WHERE createdAt >= ${start} AND createdAt < ${end}) AS shareTotal,
              (SELECT COALESCE(SUM(tokenBalance),0) FROM enterprises) AS walletTotal`,
      );
      const s = sumRows[0] ?? {};

      // 2) 按企业（匠市，当月流通 + 当前钱包）
      const entRows = await stQuery(
        sql`SELECT e.name, e.tokenBalance,
              COUNT(t.id) AS flowCount,
              COALESCE(SUM(t.amount), 0) AS flowTotal,
              COALESCE(SUM(t.platformFee), 0) AS feeTotal,
              COALESCE(SUM(t.masterShare), 0) AS shareTotal
            FROM enterprises e
            LEFT JOIN token_transactions t ON t.enterpriseId = e.id
              AND t.createdAt >= ${start} AND t.createdAt < ${end}
            GROUP BY e.id, e.name, e.tokenBalance ORDER BY flowTotal DESC`,
      );

      // 3) 按企业（充值，当月）
      const facRows = await stQuery(
        sql`SELECT f.enterpriseName,
              COUNT(*) AS cnt, COALESCE(SUM(p.amount),0) AS amount, COALESCE(SUM(p.price_cny),0) AS cny
            FROM st_token_topups p JOIN wb_factories f ON f.id = p.factory_id
            WHERE p.status='confirmed' AND p.created_at >= ${start} AND p.created_at < ${end}
            GROUP BY f.id, f.enterpriseName ORDER BY cny DESC`,
      );

      // 4) 充值明细（当月全部）
      const topupDetail = await stQuery(
        sql`SELECT p.id, f.enterpriseName, p.amount, p.price_cny, p.status,
              DATE_FORMAT(p.created_at, '%Y-%m-%d %H:%i') AS createdAt, p.confirmed_by
            FROM st_token_topups p JOIN wb_factories f ON f.id = p.factory_id
            WHERE p.created_at >= ${start} AND p.created_at < ${end}
            ORDER BY p.created_at DESC LIMIT 5000`,
      );

      // 5) 流通明细（当月全部，封顶5000行）
      const flowDetail = await stQuery(
        sql`SELECT t.id, t.type, e.name AS enterpriseName, t.amount, t.platformFee, t.masterShare,
              DATE_FORMAT(t.createdAt, '%Y-%m-%d %H:%i') AS createdAt, t.note
            FROM token_transactions t LEFT JOIN enterprises e ON e.id = t.enterpriseId
            WHERE t.createdAt >= ${start} AND t.createdAt < ${end}
            ORDER BY t.createdAt DESC LIMIT 5000`,
      );

      const wb = XLSX.utils.book_new();
      const addSheet = (name: string, aoa: (string | number)[][]) => {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
      };
      addSheet("月度汇总", [
        [`NumX Max 月度对账单（${input.yearMonth}）`],
        [],
        ["口径", "数值"],
        ["充值确认笔数", Number(s.topupCount ?? 0)],
        ["充值Token", Number(s.topupAmount ?? 0)],
        ["充值金额（元）", Number(s.topupCny ?? 0)],
        ["流通笔数", Number(s.flowCount ?? 0)],
        ["流通Token", Number(s.flowTotal ?? 0)],
        ["平台费", Number(s.feeTotal ?? 0)],
        ["大师分成", Number(s.shareTotal ?? 0)],
        ["企业钱包存量（当前）", Number(s.walletTotal ?? 0)],
        [],
        ["说明", "充值账=工作台企业空间（wb_factories）；流通/钱包=匠市企业空间（enterprises）；两空间无跨系统外键，如实分列。"],
      ]);
      addSheet("按企业-匠市流通", [
        ["企业", "钱包余额（当前）", "当月流通笔数", "当月流通Token", "当月平台费", "当月大师分成"],
        ...entRows.map((r) => [String(r.name), Number(r.tokenBalance ?? 0), Number(r.flowCount ?? 0), Number(r.flowTotal ?? 0), Number(r.feeTotal ?? 0), Number(r.shareTotal ?? 0)]),
      ]);
      addSheet("按企业-充值", [
        ["企业", "当月确认笔数", "当月充值Token", "当月充值金额（元）"],
        ...facRows.map((r) => [String(r.enterpriseName), Number(r.cnt ?? 0), Number(r.amount ?? 0), Number(r.cny ?? 0)]),
      ]);
      addSheet("充值明细", [
        ["单号", "企业", "Token", "金额（元）", "状态", "时间", "确认人"],
        ...topupDetail.map((r) => [Number(r.id), String(r.enterpriseName), Number(r.amount ?? 0), Number(r.price_cny ?? 0), String(r.status), String(r.createdAt ?? ""), String(r.confirmed_by ?? "")]),
      ]);
      addSheet("流通明细", [
        ["流水号", "类型", "企业", "Token", "平台费", "大师分成", "时间", "备注"],
        ...flowDetail.map((r) => [Number(r.id), String(r.type), String(r.enterpriseName ?? ""), Number(r.amount ?? 0), Number(r.platformFee ?? 0), Number(r.masterShare ?? 0), String(r.createdAt ?? ""), String(r.note ?? "")]),
      ]);

      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
      const artifact = await saveArtifact(
        { agentCode: "finance", threadId: null, actor: admin.username, channel: "admin" },
        "finance_ledger_export",
        "xlsx",
        `月度对账-${input.yearMonth}`,
        "xlsx",
        buf,
        { yearMonth: input.yearMonth, sheets: 5 },
      );
      return { artifact };
    }),
});
