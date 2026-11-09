import { createHash } from 'node:crypto'
import type { AgentRuntimeId } from '../../contracts/agentRuntimeContainer'
import { callDsh } from '../routers/dshClient'
import { agentModelProfile, agentStationKey, readWorkbuddyAgentConfig } from './registry'

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
  agentSession: { stationKey: string; modelProfile: string | null }
}
export interface RuntimeExecutionFailure { ok: false; runtime: AgentRuntimeId; errorCode: string; latencyMs: number }
export type RuntimeExecutionResult = RuntimeExecutionSuccess | RuntimeExecutionFailure
export type RuntimeExecutor = (runtime: AgentRuntimeId, task: RuntimeExecutionInput) => Promise<RuntimeExecutionResult>

export const executeRuntimeTask: RuntimeExecutor = async (runtime, task) => {
  const started = Date.now()
  const stationKey = agentStationKey(task.taskNo)
  const modelProfile = agentModelProfile(runtime)
  if (runtime !== 'dsh' && runtime !== 'workbuddy' && process.env[`AGENT_RUNTIME_${runtime.toUpperCase()}_ENABLED`] !== '1') {
    return { ok: false, runtime, errorCode: 'agent_profile_not_enabled', latencyMs: 0 }
  }
  const text = `【岗位】${task.role}\n【任务】${task.title}\n【要求】${task.brief}\n【交付纪律】你是实际 Agent 执行体，必须使用可用的 Agent 工具循环输出可复核交付物与已知局限，不得把执行等同于验收。`
  if (runtime === 'workbuddy') {
    const config = readWorkbuddyAgentConfig()
    if (!config) return { ok: false, runtime, errorCode: 'agent_runtime_not_configured', latencyMs: 0 }
    try {
      const response = await fetch(`${config.baseUrl}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
        body: JSON.stringify({ task: text, timeoutSec: 120, factoryId: task.factoryId, stationKey }),
        signal: AbortSignal.timeout(150_000),
      })
      const data = await response.json() as { ok?: boolean; answer?: string; error?: string; sessionId?: string }
      const latencyMs = Date.now() - started
      if (!response.ok || !data.ok || !data.answer?.trim()) return { ok: false, runtime, errorCode: data.error || `agent_http_${response.status}`, latencyMs }
      const content = data.answer.trim()
      return { ok: true, runtime, content, resultSha256: sha256(content), provider: 'workbuddy-agent', model: null,
        usageTokens: 0, latencyMs, requestSha256: sha256(text), responseSha256: sha256(content), agentSession: { stationKey: data.sessionId ?? stationKey, modelProfile: null } }
    } catch { return { ok: false, runtime, errorCode: 'agent_network_error', latencyMs: Date.now() - started } }
  }
  const result = await callDsh(text, 120, task.factoryId, modelProfile ?? undefined, stationKey)
  const latencyMs = Date.now() - started
  if (!result.ok || !result.answer?.trim()) return { ok: false, runtime, errorCode: result.error || 'agent_empty_deliverable', latencyMs }
  const content = result.answer.trim()
  return { ok: true, runtime, content, resultSha256: sha256(content), provider: 'dsh-agent', model: modelProfile,
    usageTokens: 0, latencyMs, requestSha256: sha256(text), responseSha256: sha256(content), agentSession: { stationKey, modelProfile } }
}
