/**
 * MySQL UTC 时间戳单一事实源：Date 直返时刻，文本按 UTC 墙钟解析。
 * 支持秒、毫秒、微秒以及显式时区偏移，禁止 Node 按本地时区猜测。
 */
export function parseDbUtc(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  const text = String(value ?? '').trim()
  if (!text) return Number.NaN
  const withT = text.includes('T') ? text : text.replace(' ', 'T')
  const withZone = /Z$|[+-]\d{2}:?\d{2}$/.test(withT) ? withT : `${withT}Z`
  return new Date(withZone).getTime()
}

export function toIsoOrNull(value: unknown): string | null {
  const timestamp = parseDbUtc(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}
