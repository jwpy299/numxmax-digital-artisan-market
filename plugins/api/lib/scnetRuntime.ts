import { createHash } from 'node:crypto'

export const SCNET_BASE_URL = 'https://api.scnet.cn/api/llm/v1'
export const SCNET_MODEL = 'DeepSeek-V4.1-Flash-1017'
const MAX_RESPONSE_BYTES = 1024 * 1024

export interface ScnetMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ScnetInferenceResult {
  ok: true
  provider: 'scnet'
  model: string
  content: string
  requestId: string | null
  requestSha256: string
  responseSha256: string
  usageTokens: number
  latencyMs: number
}
export interface ScnetInferenceFailure {
  ok: false
  provider: 'scnet'
  reason: 'not_configured' | 'http_error' | 'timeout' | 'network_error' | 'empty_content' | 'model_mismatch' | 'response_too_large' | 'invalid_response'
  httpStatus?: number
  latencyMs: number
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }
function config() {
  const key = process.env.SCNET_API_KEY?.trim() ?? ''
  const baseUrl = (process.env.SCNET_BASE_URL ?? SCNET_BASE_URL).replace(/\/+$/, '')
  const model = process.env.SCNET_MODEL?.trim() || SCNET_MODEL
  if (!key || key.length < 16) return null
  if (baseUrl !== SCNET_BASE_URL || model !== SCNET_MODEL) return null
  return { key, baseUrl, model }
}

async function readLimited(response: Response): Promise<string> {
  if (!response.body) throw new Error('invalid_response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('response_too_large')
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(merged)
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

/** SCNet 严格推理：不降级到其他厂商，不记录 prompt 原文或密钥。 */
export async function callScnetInference(args: {
  messages: ScnetMessage[]
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<ScnetInferenceResult | ScnetInferenceFailure> {
  const cfg = config()
  if (!cfg) return { ok: false, provider: 'scnet', reason: 'not_configured', latencyMs: 0 }
  const fetcher = args.fetchImpl ?? fetch
  const body = JSON.stringify({
    model: cfg.model,
    messages: args.messages,
    max_tokens: Math.floor(finiteNumber(args.maxTokens, 512, 1, 4096)),
    temperature: finiteNumber(args.temperature, 0.3, 0, 2),
    stream: false,
  })
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), finiteNumber(args.timeoutMs, 30_000, 1, 120_000))
  try {
    const response = await fetcher(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body,
      signal: controller.signal,
    })
    const latencyMs = Date.now() - started
    if (!response.ok) return { ok: false, provider: 'scnet', reason: 'http_error', httpStatus: response.status, latencyMs }
    const raw = await readLimited(response)
    const data = JSON.parse(raw) as { id?: string; model?: string; choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } }
    if (data.model !== cfg.model) return { ok: false, provider: 'scnet', reason: 'model_mismatch', latencyMs }
    const content = data.choices?.[0]?.message?.content?.trim()
    if (!content) return { ok: false, provider: 'scnet', reason: 'empty_content', latencyMs }
    const usage = Number(data.usage?.total_tokens ?? 0)
    return {
      ok: true,
      provider: 'scnet',
      model: data.model,
      content,
      requestId: response.headers.get('x-request-id') ?? (typeof data.id === 'string' ? data.id : null),
      requestSha256: sha256(body),
      responseSha256: sha256(raw),
      usageTokens: Number.isFinite(usage) && usage > 0 ? Math.floor(usage) : 0,
      latencyMs,
    }
  } catch (err) {
    const latencyMs = Date.now() - started
    if (err instanceof Error && err.message === 'response_too_large') return { ok: false, provider: 'scnet', reason: 'response_too_large', latencyMs }
    if (err instanceof SyntaxError) return { ok: false, provider: 'scnet', reason: 'invalid_response', latencyMs }
    const timeout = err instanceof Error && err.name === 'AbortError'
    return { ok: false, provider: 'scnet', reason: timeout ? 'timeout' : 'network_error', latencyMs }
  } finally {
    clearTimeout(timer)
  }
}
