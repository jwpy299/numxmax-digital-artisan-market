/**
 * dbTime —— 库时间戳统一解析（时区三变身后的单一事实源）。
 *
 * 口径：MySQL 全局 UTC + 连接 timezone=Z 后，读侧值有两种形态——
 * ① 驱动直返 Date（正确 UTC 时刻）：直通 getTime()；
 * ② 文本（"YYYY-MM-DD HH:mm:ss" UTC 墙钟）：补 T/Z 按 UTC 解析，
 *    绝不让 Node 按本地时区（CST）解释（偏 8 小时的坑由此绝根）。
 */
export function parseDbUtc(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  const s = String(v ?? "").trim();
  if (!s) return NaN;
  const t = s.includes("T") ? s : s.replace(" ", "T");
  const withZ = /Z$|[+-]\d{2}:?\d{2}$/.test(t) ? t : `${t}Z`;
  return new Date(withZ).getTime();
}

/** 时间字段出参 ISO 化（OCR R91-1/4）：String(Date) 本地话文本会让前端严口径 fmtTime 降级 ——
 *  统一走 parseDbUtc（UTC 单口径，不被本地时区偏 8h）；零日期/非法值落 null 不炸整列查询 */
export function toIsoOrNull(v: unknown): string | null {
  const t = parseDbUtc(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
