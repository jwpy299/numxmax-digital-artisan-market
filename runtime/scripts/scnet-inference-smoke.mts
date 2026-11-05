import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { callScnetInference } from '../api/lib/scnetRuntime'

const out = process.argv[2]
if (!out) throw new Error('usage: scnet-inference-smoke.mts <redacted-evidence.json>')
const startedAt = new Date().toISOString()
const result = await callScnetInference({
  messages: [
    { role: 'system', content: '你是连通性探针，只按用户要求回复。' },
    { role: 'user', content: '只回复 SCNET_OK，不要输出其他内容。' },
  ],
  maxTokens: 32,
  temperature: 0,
  timeoutMs: 60_000,
})
const evidence = {
  schema: 'numx.scnet.inference-evidence.v1',
  startedAt,
  finishedAt: new Date().toISOString(),
  environment: 'staging',
  provider: 'scnet',
  endpoint: 'https://api.scnet.cn/api/llm/v1/chat/completions',
  ok: result.ok,
  model: result.ok ? result.model : 'DeepSeek-V4.1-Flash-1017',
  requestId: result.ok ? result.requestId : null,
  requestSha256: result.ok ? result.requestSha256 : null,
  responseSha256: result.ok ? result.responseSha256 : null,
  usageTokens: result.ok ? result.usageTokens : 0,
  latencyMs: result.latencyMs,
  reason: result.ok ? null : result.reason,
  httpStatus: result.ok ? null : result.httpStatus ?? null,
  promptClassification: 'non-sensitive-connectivity-probe',
  productionDeployment: false,
  realTraining: false,
}
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(evidence, null, 2) + String.fromCharCode(10), { mode: 0o600 })
console.log(JSON.stringify({ ok: result.ok, model: evidence.model, requestIdPresent: Boolean(evidence.requestId), usageTokens: evidence.usageTokens, latencyMs: evidence.latencyMs, reason: evidence.reason, httpStatus: evidence.httpStatus, evidence: out }))
if (!result.ok) process.exitCode = 1
