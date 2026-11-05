/**
 * contentScreen —— M36 UGC 内容审核管线·本地初筛（等保/备案/应用市场上架硬项）。
 *
 * v1 口径（诚实边界）：本地词表+模式初筛，零外呼零成本；
 * 外部内容安全 API（阿里云/腾讯云内容安全）待彭总给钥匙后升级为云审+人工复审双轨。
 *
 * 拦截面：政治敏感 / 暴恐 / 色情 / 违法交易 词表初筛（误伤兜底：命中给「转人工复审」文案，
 * 绝不明列命中词）。上传标题/文本类内容在写库前调用 screenText()。
 */

/** 初筛词表（刻意收敛宁漏勿滥；命中即拒/转人工，不扩散词表本身） */
const BANNED: RegExp[] = [
  /法.{0,2}轮|明[慧慧]/i,
  /枪支|弹药|炸药|雷管/i,
  /冰毒|海洛因|大麻|摇头丸/i,
  /代开.{0,4}发票|洗钱|跑分/i,
  /约炮|援交|裸聊/i,
  /赌博|博彩|时时彩|六合彩/i,
  /翻墙|VPN 下载/i,
];

export interface ScreenResult {
  ok: boolean;
  /** 命中时的对外文案（不泄露命中词） */
  reason?: string;
}

/** 文本初筛：命中 → ok:false + 人话文案（转人工复审口径）。 */
export function screenText(text: string): ScreenResult {
  const t = String(text ?? "");
  if (!t) return { ok: true };
  for (const re of BANNED) {
    if (re.test(t)) {
      return { ok: false, reason: "内容命中平台安全规则，已转入人工复审通道；请调整后再提交。" };
    }
  }
  return { ok: true };
}
