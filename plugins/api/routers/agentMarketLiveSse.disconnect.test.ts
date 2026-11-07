import { describe, expect, it, vi } from 'vitest'

const sessionMe = vi.hoisted(() => vi.fn())
const readFeed = vi.hoisted(() => vi.fn())
const streamCallback = vi.hoisted(() => ({ current: null as ((stream: unknown) => Promise<void>) | null }))

describe('Agent 市场 SSE 客户端断连', () => {
  it('feed 写失败时正常收束，不产生未处理拒绝', async () => {
    vi.resetModules()
    sessionMe.mockReset().mockResolvedValue({ user: { id: 1 }, factory: { id: 1 } })
    readFeed.mockReset().mockResolvedValue({ items: [], feedVersion: 'v1', serverTime: new Date().toISOString(), source: 'mysql' })
    streamCallback.current = null
    vi.doMock('./wbSession', () => ({ sessionMe }))
    vi.doMock('./agentMarketLive', () => ({ readAgentMarketLiveFeed: readFeed }))
    vi.doMock('hono/streaming', () => ({
      streamSSE: (_context: unknown, callback: (stream: unknown) => Promise<void>) => {
        streamCallback.current = callback
        return new Response('stream')
      },
    }))
    const { handleAgentMarketLiveSse } = await import('./agentMarketLiveSse')
    const context = { req: { query: () => 'test-token' }, header: vi.fn(), json: vi.fn() }
    const response = await handleAgentMarketLiveSse(context as never)
    expect(response.status).toBe(200)
    expect(streamCallback.current).not.toBeNull()
    const writeSSE = vi.fn(async () => { throw new Error('client disconnected') })
    await expect(streamCallback.current!({ aborted: false, writeSSE })).resolves.toBeUndefined()
    expect(writeSSE).toHaveBeenCalledTimes(1)
    expect(sessionMe).toHaveBeenCalledTimes(2)
  })
})
