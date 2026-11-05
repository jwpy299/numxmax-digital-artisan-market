import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { sessionMe } from './wbSession'
import { TRPCError } from '@trpc/server'
import { readAgentMarketLiveFeed } from './agentMarketLive'

export function createAgentMarketSseLimiter(maxConnections: number) {
  const active = new Set<number>()
  let nextId = 1
  return {
    acquire(): number | null {
      if (active.size >= maxConnections) return null
      const id = nextId++
      active.add(id)
      return id
    },
    release(id: number): void { active.delete(id) },
    activeCount(): number { return active.size },
  }
}
const sseLimiter = createAgentMarketSseLimiter(Math.min(Math.max(Number(process.env.AGENT_MARKET_SSE_MAX_CONNECTIONS) || 32, 1), 128))

export function isSessionRevokedError(error: unknown): boolean {
  return error instanceof TRPCError && error.code === 'UNAUTHORIZED'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.() })
}

/** canonical 快照流：每轮重新验证会话与公开范围；撤销时发 revoked 并关闭，不继续伪装实时。 */
export async function handleAgentMarketLiveSse(c: Context) {
  const token = (c.req.query('token') ?? '').trim()
  if (!token) return c.json({ error: '需要有效会话' }, 401)
  try { await sessionMe(token) } catch { return c.json({ error: '需要有效会话' }, 401) }
  const slot = sseLimiter.acquire()
  if (slot === null) return c.json({ error: '实时连接数已达上限，请稍后重试' }, 429)
  c.header('Cache-Control', 'no-store')
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    let previousVersion = ''
    let heartbeat = 0
    try {
      while (!stream.aborted) {
        await sessionMe(token)
        const feed = await readAgentMarketLiveFeed()
        if (feed.feedVersion !== previousVersion) {
          previousVersion = feed.feedVersion
          await stream.writeSSE({ event: 'feed', data: JSON.stringify(feed) })
        }
        heartbeat += 1
        if (heartbeat >= 8) {
          heartbeat = 0
          await stream.writeSSE({ event: 'heartbeat', data: JSON.stringify({ serverTime: new Date().toISOString(), feedVersion: previousVersion }) })
        }
        await sleep(2_000)
      }
    } catch (error) {
      if (isSessionRevokedError(error)) {
        if (!stream.aborted) await stream.writeSSE({ event: 'revoked', data: JSON.stringify({ message: '会话或公开授权已变化，请重新连接' }) })
      } else {
        console.warn('[agent-market-live] transient snapshot failure')
        if (!stream.aborted) await stream.writeSSE({ event: 'degraded', data: JSON.stringify({ message: '快照暂时不可用，继续重连' }) })
        await sleep(2_000)
      }
    } finally {
      sseLimiter.release(slot)
    }
  })
}
