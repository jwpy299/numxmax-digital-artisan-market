/**
 * tokenEconomy —— Token 计量与结算说明（静态文案）。
 *
 * 去金融化口径：Token 为平台内部工业计量单位，用于技能调用计量与
 * 开发者/老师傅分成结算；购买交易服务标注「未来开放」。
 */
import { createRouter, publicQuery } from "../middleware";

export const tokenEconomyRouter = createRouter({
  /** overview（public）：Token 机制总览 */
  overview: publicQuery.query(() => ({
    purchaseStatus: "future" as const,
    purchaseNote: "Token 购买交易服务未来开放",
    settlementNote:
      "Token 可按平台规则兑换数字人民币结算（结算通道未来开放）",
    points: [
      "如何获得：企业可按平台公示的计量标准预存 Token；开发者与老师傅通过作品调用计量、雇佣分成获得 Token 收益。",
      "如何使用：Token 用于支付数字员工月薪、技能单次调用计量费与平台公示的其他技术服务计量项。",
      "计量透明：每一笔 Token 流水均记录来源与用途，可在收益台账中对账。",
      "结算规则：Token 可按平台规则兑换数字人民币结算，结算通道未来开放，开放前以平台公告为准。",
      "合规说明：Token 为平台内部工业计量单位，不构成任何金融产品，不可在平台外流通或转让。",
    ],
  })),
});
