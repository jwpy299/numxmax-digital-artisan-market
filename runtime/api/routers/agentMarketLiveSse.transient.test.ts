import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { TRPCError } from '@trpc/server'

const sessionMe = vi.hoisted(() => vi.fn())
const readFeed = vi.hoisted(() => vi.fn())
vi.mock('./wbSession', () => ({ sessionMe }))
vi.mock('./agentMarketLive', () => ({ readAgentMarketLiveFeed: readFeed }))

import { handleAgentMarketLiveSse } from './agentMarketLiveSse'

const authenticated = { user: { id: 1 }, factory: { id: 1 } }
const feed = { items: [], feedVersion: 'v1', serverTime: new Date().toISOString(), source: 'mysql' }

function app() {
  return new Hono().get('/stream', handleAgentMarketLiveSse)
}

describe('Agent 市场 SSE 瞬时故障恢复', () => {
  beforeEach(() => {
    sessionMe.mockReset()
    readFeed.mockReset()
    readFeed.mockResolvedValue(feed)
  })

  it('流内单次瞬时错误发 degraded 后继续后续快照，不终止流', async () => {
    sessionMe
      .mockResolvedValueOnce(authenticated)
      .mockRejectedValueOnce(new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'db hiccup' }))
      .mockResolvedValue(authenticated)

    const response = await app().request('/stream?token=test-token')
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    try {
      while (!text.includes('event: degraded') || !text.includes('event: feed')) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }

    expect(text).toContain('event: degraded')
    expect(text).toContain('event: feed')
    expect(text).not.toContain('event: revoked')
    expect(sessionMe).toHaveBeenCalledTimes(2)
  }, 10_000)

  it('流内鉴权撤销发 revoked 后关闭，不误报为瞬时降级', async () => {
    sessionMe
      .mockResolvedValueOnce(authenticated)
      .mockRejectedValueOnce(new TRPCError({ code: 'UNAUTHORIZED', message: 'revoked' }))

    const response = await app().request('/stream?token=test-token')
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('event: revoked')
    expect(text).not.toContain('event: degraded')
    expect(text).not.toContain('event: feed')
    expect(sessionMe).toHaveBeenCalledTimes(2)
  })
})
