import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { sessionMe } from './wbSession'
import { TRPCError } from '@trpc/server'
import { readAgentMarketLiveFeed } from './agentMarketLive'
import { logQueryErrorThrottled } from '../queries/rawRows'

export function createAgentMarketSseLimiter(maxConnections: number, maxPerOwner = 4) {
  const active = new Map<number, string>()
  let nextId = 1
  return {
    acquire(ownerKey = ''): number | null {
      if (active.size >= maxConnections) return null
      if (ownerKey && [...active.values()].filter((owner) => owner === ownerKey).length >= maxPerOwner) return null
      const id = nextId++
      active.set(id, ownerKey)
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

/** canonical 快照流：按用户限流、周期重鉴权；撤销时发 revoked 并关闭，不继续伪装实时。 */
export async function handleAgentMarketLiveSse(c: Context) {
  const token = (c.req.query('token') ?? '').trim()
  if (!token) return c.json({ error: '需要有效会话' }, 401)
  let ownerKey: string
  try {
    const session = await sessionMe(token)
    ownerKey = `user:${Number(session.user.id)}`
  } catch { return c.json({ error: '需要有效会话' }, 401) }
  const slot = sseLimiter.acquire(ownerKey)
  if (slot === null) return c.json({ error: '实时连接数已达上限，请稍后重试' }, 429)
  c.header('Cache-Control', 'no-store')
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    let previousVersion = ''
    let heartbeat = 0
    let lastAuthAt = 0
    let degraded = false
    const write = async (event: Parameters<typeof stream.writeSSE>[0]): Promise<boolean> => {
      if (stream.aborted) return false
      try { await stream.writeSSE(event); return true } catch { return false }
    }
    try {
      while (!stream.aborted) {
        try {
          if (Date.now() - lastAuthAt >= 15_000) {
            lastAuthAt = Date.now()
            await sessionMe(token)
          }
          const feed = await readAgentMarketLiveFeed()
          degraded = false
          if (feed.feedVersion !== previousVersion) {
            previousVersion = feed.feedVersion
            if (!await write({ event: 'feed', data: JSON.stringify(feed) })) return
          }
        } catch (error) {
          if (isSessionRevokedError(error)) {
            await write({ event: 'revoked', data: JSON.stringify({ message: '会话或公开授权已变化，请重新连接' }) })
            return
          }
          if (!degraded) {
            degraded = true
            logQueryErrorThrottled('agent-market-live-sse', error)
            if (!await write({ event: 'degraded', data: JSON.stringify({ message: '快照暂时不可用，继续重连' }) })) return
          }
        }
        heartbeat += 1
        if (heartbeat >= 8) {
          heartbeat = 0
          if (!await write({ event: 'heartbeat', data: JSON.stringify({ serverTime: new Date().toISOString(), feedVersion: previousVersion, degraded }) })) return
        }
        await sleep(2_000)
      }
    } finally {
      sseLimiter.release(slot)
    }
  })
}
