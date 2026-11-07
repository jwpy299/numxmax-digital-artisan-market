import { afterEach, describe, expect, it, vi } from 'vitest'
import { callModelChat, callSlotChat, callSlotChatFast, callSlotChatStream } from './modelGateway'
import { SCNET_BASE_URL, SCNET_MODEL } from '../lib/scnetRuntime'

function configureStrict() {
  vi.stubEnv('SCNET_REQUIRED', '1')
  vi.stubEnv('SCNET_API_KEY', 'test-only-scnet-placeholder')
  vi.stubEnv('SCNET_BASE_URL', SCNET_BASE_URL)
  vi.stubEnv('SCNET_MODEL', SCNET_MODEL)
  vi.stubEnv('KIMI_API_KEY', 'test-only-other-provider-placeholder')
  vi.stubEnv('IDOICTOS_API_KEY', 'test-only-ido-provider-placeholder')
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('modelGateway SCNET_REQUIRED 严格模式', () => {
  it('SCNet 失败时不降级到其他厂商', async () => {
    configureStrict()
    const fetcher = vi.fn(async () => new Response('provider secret', { status: 401 }))
    vi.stubGlobal('fetch', fetcher)
    const result = await callModelChat({ messages: [{ role: 'user', content: 'ping' }] })
    expect(result).toMatchObject({ ok: false, provider: 'scnet', reason: 'http_401' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain('provider secret')
  })
  it('成功结果带 SCNet 证据哈希；显式指定其他 provider 也拒绝', async () => {
    configureStrict()
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'scnet-req', model: SCNET_MODEL, choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 8 } }), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const result = await callModelChat({ messages: [{ role: 'user', content: 'ping' }] })
    expect(result).toMatchObject({ ok: true, provider: 'scnet', model: SCNET_MODEL, providerRequestId: 'scnet-req', usageTokens: 8 })
    expect(result.requestSha256).toHaveLength(64)
    expect(result.responseSha256).toHaveLength(64)
    const before = fetcher.mock.calls.length
    const other = await callModelChat({ provider: 'kimi', messages: [{ role: 'user', content: 'ping' }] })
    expect(other).toMatchObject({ ok: false, reason: 'not_configured' })
    expect(fetcher.mock.calls.length).toBe(before)
  })

  it('严格模式下顺序、竞速、流式槽位均不触达其他厂商', async () => {
    configureStrict()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const opts = { messages: [{ role: 'user' as const, content: 'strict-slot-ping' }] }
    await expect(callSlotChat('flash', opts)).resolves.toMatchObject({ ok: false, reason: 'not_configured' })
    await expect(callSlotChatFast('flash', opts)).rejects.toThrow('not_configured')
    await expect(callSlotChatStream('flash', opts, () => undefined)).resolves.toMatchObject({ ok: false, reason: 'not_configured' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('非严格模式不抢占既有 provider，显式选择仍允许 SCNet', async () => {
    vi.stubEnv('SCNET_API_KEY', 'test-only-scnet-placeholder')
    vi.stubEnv('KIMI_API_KEY', 'test-only-kimi-placeholder')
    const fetcher = vi.fn(async (_input: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: 'kimi-ok' } }], usage: { total_tokens: 3 } }), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const result = await callModelChat({ messages: [{ role: 'user', content: 'ping' }] })
    expect(result).toMatchObject({ ok: true, provider: 'kimi', model: 'moonshot-v1-8k', content: 'kimi-ok' })
    expect(String(fetcher.mock.calls[0][0])).toBe('https://api.moonshot.cn/v1/chat/completions')
    vi.stubEnv('MODEL_ASSISTANT_PROVIDER', 'scnet')
    const scnetFetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'scnet-explicit', model: SCNET_MODEL, choices: [{ message: { content: 'scnet-ok' } }], usage: { total_tokens: 4 } }), { status: 200 }))
    vi.stubGlobal('fetch', scnetFetcher)
    const explicit = await callModelChat({ messages: [{ role: 'user', content: 'ping' }] })
    expect(explicit).toMatchObject({ ok: true, provider: 'scnet', model: SCNET_MODEL, providerRequestId: 'scnet-explicit' })
  })
})
