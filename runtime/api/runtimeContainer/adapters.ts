import { createHash } from 'node:crypto'
import type { AgentRuntimeId } from '../../contracts/agentRuntimeContainer'
import { callDsh } from '../routers/dshClient'
import { agentModelProfile, agentRuntimeAdapterEnabled, agentStationKey, readWorkbuddyAgentConfig } from './registry'

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }
export interface RuntimeExecutionInput { taskNo: string; role: string; title: string; brief: string; factoryId: number }
export interface RuntimeExecutionSuccess {
  ok: true
  runtime: AgentRuntimeId
  content: string
  resultSha256: string
  provider: string
  model: string | null
  usageTokens: number
  latencyMs: number
  requestSha256: string
  responseSha256: string
  agentSession: { stationKey: string; modelProfile: string | null; ticketId?: string }
}
export interface RuntimeExecutionFailure { ok: false; runtime: AgentRuntimeId; errorCode: string; latencyMs: number }
export type RuntimeExecutionResult = RuntimeExecutionSuccess | RuntimeExecutionFailure
export type RuntimeExecutor = (runtime: AgentRuntimeId, task: RuntimeExecutionInput) => Promise<RuntimeExecutionResult>

export const executeRuntimeTask: RuntimeExecutor = async (runtime, task) => {
  const started = Date.now()
  const stationKey = agentStationKey(task.taskNo)
  const modelProfile = agentModelProfile(runtime)
  if (!agentRuntimeAdapterEnabled(runtime)) {
    return { ok: false, runtime, errorCode: 'agent_runtime_disabled', latencyMs: 0 }
  }
  const text = `【岗位】${task.role}\n【任务】${task.title}\n【要求】${task.brief}\n【交付纪律】你是实际 Agent 执行体，必须使用可用的 Agent 工具循环输出可复核交付物与已知局限，不得把执行等同于验收。`
  if (runtime === 'workbuddy') {
    const config = readWorkbuddyAgentConfig()
    if (!config) return { ok: false, runtime, errorCode: 'agent_runtime_not_configured', latencyMs: 0 }
    try {
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${config.token}` }
      const healthResponse = await fetch(`${config.baseUrl}/health`, { headers, signal: AbortSignal.timeout(15_000) })
      const health = await healthResponse.json() as { ok?: boolean; agentNotModel?: boolean }
      if (!healthResponse.ok || !health.ok || health.agentNotModel !== true) return { ok: false, runtime, errorCode: 'agent_protocol_violation', latencyMs: Date.now() - started }
      const response = await fetch(`${config.baseUrl}/run`, {
        method: 'POST', headers,
        body: JSON.stringify({ task: text, timeoutSec: 120, factoryId: task.factoryId, stationKey }),
        signal: AbortSignal.timeout(150_000),
      })
      const data = await response.json() as { ok?: boolean; answer?: string; error?: string; sessionId?: string; ticketId?: string; eventsUrl?: string; resultUrl?: string; cancelUrl?: string; resultSha256?: string }
      const latencyMs = Date.now() - started
      if (!response.ok || !data.ok || !data.answer?.trim()) return { ok: false, runtime, errorCode: data.error || `agent_http_${response.status}`, latencyMs }
      if (!data.ticketId || !data.sessionId || !data.eventsUrl || !data.resultUrl || !data.cancelUrl || !data.resultSha256) return { ok: false, runtime, errorCode: 'agent_protocol_violation', latencyMs }
      const [eventsResponse, resultResponse] = await Promise.all([
        fetch(`${config.baseUrl}${data.eventsUrl}`, { headers, signal: AbortSignal.timeout(15_000) }),
        fetch(`${config.baseUrl}${data.resultUrl}`, { headers, signal: AbortSignal.timeout(15_000) }),
      ])
      const events = await eventsResponse.json() as { events?: Array<{ type?: string }> }
      const result = await resultResponse.json() as { status?: string; answer?: string; resultSha256?: string }
      if (!eventsResponse.ok || !resultResponse.ok || !Array.isArray(events.events) || !events.events.some((event) => event.type === 'runtime.completed')) return { ok: false, runtime, errorCode: 'agent_protocol_violation', latencyMs }
      const content = data.answer.trim()
      if (result.status !== 'delivered' || result.answer !== content || result.resultSha256 !== data.resultSha256 || result.resultSha256 !== sha256(content)) return { ok: false, runtime, errorCode: 'agent_protocol_violation', latencyMs }
      return { ok: true, runtime, content, resultSha256: sha256(content), provider: 'workbuddy-agent', model: null,
        usageTokens: 0, latencyMs, requestSha256: sha256(text), responseSha256: sha256(content), agentSession: { stationKey: data.sessionId, modelProfile: null, ticketId: data.ticketId } }
    } catch { return { ok: false, runtime, errorCode: 'agent_network_error', latencyMs: Date.now() - started } }
  }
  const result = await callDsh(text, 120, task.factoryId, modelProfile ?? undefined, stationKey)
  const latencyMs = Date.now() - started
  if (!result.ok || !result.answer?.trim()) return { ok: false, runtime, errorCode: result.error || 'agent_empty_deliverable', latencyMs }
  const content = result.answer.trim()
  return { ok: true, runtime, content, resultSha256: sha256(content), provider: 'dsh-agent', model: modelProfile,
    usageTokens: 0, latencyMs, requestSha256: sha256(text), responseSha256: sha256(content), agentSession: { stationKey, modelProfile } }
}

export async function cancelWorkbuddyAgentTask(stationKey: string): Promise<boolean> {
  const config = readWorkbuddyAgentConfig()
  if (!config) return false
  try {
    const response = await fetch(`${config.baseUrl}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ stationKey }),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await response.json() as { ok?: boolean }
    return response.ok && data.ok === true
  } catch { return false }
}
