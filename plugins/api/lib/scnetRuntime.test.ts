import { afterEach, describe, expect, it, vi } from 'vitest'
import { callScnetInference, SCNET_BASE_URL, SCNET_MODEL } from './scnetRuntime'

function configured() {
  vi.stubEnv('SCNET_API_KEY', 'test-only-placeholder-key-not-a-real-secret')
  vi.stubEnv('SCNET_BASE_URL', SCNET_BASE_URL)
  vi.stubEnv('SCNET_MODEL', SCNET_MODEL)
}
afterEach(() => vi.unstubAllEnvs())

describe('SCNet 严格推理契约（mock 仅测代码，不作为真实推理证据）', () => {
  it('成功时保留模型、request id、usage 与请求/响应哈希且不暴露密钥', async () => {
    configured()
    const fetchImpl = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(JSON.stringify({ id: 'req-scnet-1', model: SCNET_MODEL, choices: [{ message: { content: '真实返回结构' } }], usage: { total_tokens: 12 } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const result = await callScnetInference({ messages: [{ role: 'user', content: 'ping' }], fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.provider).toBe('scnet')
      expect(result.model).toBe(SCNET_MODEL)
      expect(result.requestId).toBe('req-scnet-1')
      expect(result.usageTokens).toBe(12)
      expect(result.requestSha256).toHaveLength(64)
      expect(result.responseSha256).toHaveLength(64)
    }
    expect(JSON.stringify(result)).not.toContain('test-only-placeholder')
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit
    expect(String(init.body)).toContain(SCNET_MODEL)
  })
  it('模型替换、HTTP 错误、空响应全部 fail-closed 且不返回响应正文', async () => {
    configured()
    const mismatch = await callScnetInference({ messages: [], fetchImpl: async () => new Response(JSON.stringify({ model: 'other-model', choices: [{ message: { content: 'x' } }] }), { status: 200 }) })
    expect(mismatch).toMatchObject({ ok: false, reason: 'model_mismatch' })
    const denied = await callScnetInference({ messages: [], fetchImpl: async () => new Response('secret provider error', { status: 401 }) })
    expect(denied).toMatchObject({ ok: false, reason: 'http_error', httpStatus: 401 })
    expect(JSON.stringify(denied)).not.toContain('secret provider error')
    const empty = await callScnetInference({ messages: [], fetchImpl: async () => new Response(JSON.stringify({ model: SCNET_MODEL, choices: [] }), { status: 200 }) })
    expect(empty).toMatchObject({ ok: false, reason: 'empty_content' })
  })
  it('非有限 maxTokens/temperature/timeoutMs 使用安全默认值，不发送 null 或立即超时', async () => {
    configured()
    const fetchImpl = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(JSON.stringify({ id: 'req-finite', model: SCNET_MODEL, choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 1 } }), { status: 200 }))
    const result = await callScnetInference({ messages: [{ role: 'user', content: 'ping' }], maxTokens: Number.NaN, temperature: Number.POSITIVE_INFINITY, timeoutMs: Number.NaN, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result.ok).toBe(true)
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit
    const body = JSON.parse(String(init.body)) as { max_tokens: number; temperature: number }
    expect(body.max_tokens).toBe(512)
    expect(body.temperature).toBe(0.3)
  })
  it('未配置或自定义到未授权模型时拒绝，不走其他 provider', async () => {
    vi.stubEnv('SCNET_API_KEY', '')
    const missing = await callScnetInference({ messages: [] })
    expect(missing).toMatchObject({ ok: false, reason: 'not_configured' })
    configured()
    vi.stubEnv('SCNET_MODEL', 'unapproved-model')
    const changed = await callScnetInference({ messages: [] })
    expect(changed).toMatchObject({ ok: false, reason: 'not_configured' })
  })
})
