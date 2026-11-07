import { describe, expect, it } from 'vitest'
import { createAgentMarketSseLimiter, isSessionRevokedError } from './agentMarketLiveSse'
import { TRPCError } from '@trpc/server'

describe('Agent 市场 SSE 连接上限与释放', () => {
  it('达到上限拒绝，断线释放后可重新接入', () => {
    const limiter = createAgentMarketSseLimiter(2)
    const first = limiter.acquire()
    const second = limiter.acquire()
    expect(first).not.toBeNull(); expect(second).not.toBeNull()
    expect(limiter.acquire()).toBeNull()
    limiter.release(second!)
    expect(limiter.activeCount()).toBe(1)
    expect(limiter.acquire()).not.toBeNull()
    limiter.release(first!)
    limiter.release(second!)
  })
  it('同一用户最多四路连接，释放后可接入且不影响其他用户', () => {
    const limiter = createAgentMarketSseLimiter(10, 2)
    const first = limiter.acquire('user:a')
    const second = limiter.acquire('user:a')
    expect(first).not.toBeNull(); expect(second).not.toBeNull()
    expect(limiter.acquire('user:a')).toBeNull()
    expect(limiter.acquire('user:b')).not.toBeNull()
    limiter.release(first!)
    expect(limiter.acquire('user:a')).not.toBeNull()
  })
  it('仅鉴权撤销发 revoked，瞬时故障走 transient', () => {
    expect(isSessionRevokedError(new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid token' }))).toBe(true)
    expect(isSessionRevokedError(new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'db down' }))).toBe(false)
    expect(isSessionRevokedError(new Error('db down'))).toBe(false)
  })
})
