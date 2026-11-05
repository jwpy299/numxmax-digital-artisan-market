import { describe, expect, it } from 'vitest'
import { nextSseReconnectDelay, SSE_RECONNECT_MAX_RETRIES } from './sseReconnect'

describe('共享 SSE 退避策略', () => {
  it('1/2/4/8/16 秒指数序列，0.5 抖动中值确定', () => {
    expect([0, 1, 2, 3, 4].map((retry) => nextSseReconnectDelay(retry, 0.5))).toEqual([1000, 2000, 4000, 8000, 16000])
  })
  it('达到上限、负数和非法轮次都停止；长退避封顶 30 秒', () => {
    expect(nextSseReconnectDelay(SSE_RECONNECT_MAX_RETRIES, 0.5)).toBeNull()
    expect(nextSseReconnectDelay(-1, 0.5)).toBeNull()
    expect(nextSseReconnectDelay(Number.NaN, 0.5)).toBeNull()
    expect(nextSseReconnectDelay(4, 1.5)).toBe(19200)
    expect(nextSseReconnectDelay(10, 0.5)).toBeNull()
  })
  it('抖动边界 0.8–1.2，非法随机数走中值', () => {
    expect(nextSseReconnectDelay(0, 0)).toBe(800)
    expect(nextSseReconnectDelay(0, 1)).toBe(1200)
    expect(nextSseReconnectDelay(0, Number.NaN)).toBe(1000)
  })
})
