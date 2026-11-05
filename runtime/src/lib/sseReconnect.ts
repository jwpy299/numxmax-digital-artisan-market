export const SSE_RECONNECT_MAX_RETRIES = 5

/** retry 从 0 开始；达到上限返回 null。抖动只影响等待，不改变退避上限。 */
export function nextSseReconnectDelay(retry: number, random = Math.random()): number | null {
  if (!Number.isSafeInteger(retry) || retry < 0 || retry >= SSE_RECONNECT_MAX_RETRIES) return null
  const base = Math.min(30_000, 1_000 * (2 ** retry))
  const ratio = Number.isFinite(random) ? Math.min(Math.max(random, 0), 1) : 0.5
  return Math.floor(base * (0.8 + ratio * 0.4))
}
