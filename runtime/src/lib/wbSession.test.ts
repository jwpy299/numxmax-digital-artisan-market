/**
 * wb 封装层 token 收口测试（token 只走 body 红线）：
 * - wbClient 的 httpBatchLink 配置 methodOverride:'POST'，query 不再走 GET，
 *   含 token 的 input 绝不拼进 URL（防落 nginx/CDN 访问日志）；
 * - wbStreamUrl 是既定豁免（EventSource 只能 GET，token 走 query），本文件断言豁免面不扩大。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callWb, wbQuery, wbStreamUrl } from './wbSession'

const SECRET = 'nt_secret_token_value_48hex_padding_0000000000000000'

function okResponse(data: unknown) {
  return new Response(JSON.stringify([{ result: { data: { json: data } } }]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('wbClient 全 POST（query 不再 GET 带 token）', () => {
  it('wbQuery：fetch method=POST，token 值不出现在 URL，body 内含 token', async () => {
    const spy = vi.fn().mockResolvedValue(okResponse({ ok: true }))
    vi.stubGlobal('fetch', spy)
    const session = { token: SECRET }
    await callWb('query', 'agentic.authMe', session)
    expect(spy).toHaveBeenCalledTimes(1)
    const [url, init] = spy.mock.calls[0] as [unknown, RequestInit]
    expect(init.method).toBe('POST')
    expect(String(url)).not.toContain(SECRET)
    expect(String(url)).not.toContain('input=') // GET 形态才会把 input 拼进 query string
    expect(String(init.body)).toContain(SECRET) // token 只在 body
  })

  it('wbQuery 直连（无 token 入参）同样 POST', async () => {
    const spy = vi.fn().mockResolvedValue(okResponse({ valid: true }))
    vi.stubGlobal('fetch', spy)
    await wbQuery('wbInvites.peek', { code: `iv_${'a1'.repeat(24)}` })
    const [, init] = spy.mock.calls[0] as [unknown, RequestInit]
    expect(init.method).toBe('POST')
  })
})

describe('SSE 既定豁免（不扩大豁免面）', () => {
  it('wbStreamUrl 仅限 /api/stream/duty-chat 与 /api/stream/events 两端点，token 走 query', () => {
    const url = wbStreamUrl('/api/stream/events', { token: SECRET })
    expect(url).toContain('/api/stream/events?')
    expect(url).toContain(`token=${SECRET}`)
    expect(wbStreamUrl('/api/stream/duty-chat', { token: SECRET }, { message: 'hi' })).toContain(
      `token=${SECRET}`,
    )
    // 无会话不拼 URL（调用方回落 tRPC/手动刷新）
    expect(wbStreamUrl('/api/stream/events', null)).toBeNull()
  })
})
