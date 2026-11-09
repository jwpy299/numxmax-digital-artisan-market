import { createHash } from 'node:crypto'
import { AGENT_RUNTIME_IDS, type AgentRuntimeId, type AgentRuntimePreference } from '../../contracts/agentRuntimeContainer'

export interface RuntimeDescriptor {
  id: AgentRuntimeId
  name: string
  kind: 'dsh-agent' | 'dsh-agent-profile' | 'external-agent-bridge'
  configured: boolean
  ready: boolean
  detail: string
  capabilities: readonly string[]
  modelProfile: string | null
}
function nonEmpty(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
export function agentModelProfile(runtime: AgentRuntimeId): string | null {
  if (runtime === 'kimi') return 'kimi-k3'
  if (runtime === 'glm') return 'glm-5.2'
  if (runtime === 'qwen') return 'qwen3.5:cloud'
  return null
}
export function agentStationKey(taskNo: string): string { return `rt-${createHash('sha256').update(taskNo).digest('hex').slice(0, 32)}` }
export const ARP_ENABLED_RUNTIME_IDS = ['dsh', 'kimi', 'workbuddy'] as const
export function agentRuntimeAdapterEnabled(runtime: AgentRuntimeId): boolean {
  return (ARP_ENABLED_RUNTIME_IDS as readonly AgentRuntimeId[]).includes(runtime)
}
function agentProfileEnabled(runtime: AgentRuntimeId): boolean {
  // 当前只开放 DSH、Kimi、workbuddy。GLM／千问保留描述与历史数据兼容，
  // 但任何环境变量都不得重新打开执行面，避免误用其它模型替代目标 Agent。
  return agentRuntimeAdapterEnabled(runtime)
}
function workbuddyConfig(): { baseUrl: string; token: string } | null {
  const baseUrl = nonEmpty(process.env.WORKBUDDY_RUNTIME_URL).replace(/\/+$/, '')
  const token = nonEmpty(process.env.WORKBUDDY_API_KEY)
  if (!baseUrl || token.length < 16) return null
  try {
    const url = new URL(baseUrl)
    const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null
    return { baseUrl, token }
  } catch { return null }
}
export function readWorkbuddyAgentConfig(): { baseUrl: string; token: string } | null { return workbuddyConfig() }
export function runtimeRegistry(): RuntimeDescriptor[] {
  const dshConfigured = Boolean(nonEmpty(process.env.DSH_SERVICE_TOKEN))
  return AGENT_RUNTIME_IDS.map((id) => {
    if (id === 'workbuddy') {
      const config = workbuddyConfig()
      return { id, name: 'workbuddy', kind: 'external-agent-bridge' as const, configured: Boolean(config), ready: Boolean(config),
        detail: config ? '外部 Agent 服务已配置；必须走 Ticket/事件/交付协议' : '未配置 workbuddy Agent 服务；模型 API 不能替代 Agent',
        capabilities: ['agent-ticket', 'agent-events', 'agent-deliverable', 'agent-cancel'], modelProfile: null }
    }
    const profile = agentModelProfile(id)
    const labels = { dsh: 'DSH', kimi: 'Kimi Agent（DSH Profile）', glm: 'GLM Agent（DSH Profile）', qwen: '千问 Agent（DSH Profile）' } as const
    const enabled = agentProfileEnabled(id)
    return { id, name: labels[id], kind: id === 'dsh' ? 'dsh-agent' as const : 'dsh-agent-profile' as const,
      configured: dshConfigured, ready: dshConfigured && enabled,
      detail: !enabled ? 'ARP 适配已硬关闭：当前仅开放 DSH/Kimi/workbuddy' : !dshConfigured ? '未配置 DSH Agent 服务凭证' : `真实 DSH Agent 会话/工具循环${profile ? ` · modelProfile=${profile}` : ' · 默认模型'}`,
      capabilities: ['agent-session', 'tool-loop', 'work-directory', 'factory-isolation', 'event-deliverable'], modelProfile: profile }
  })
}
export function runtimeReady(runtime: AgentRuntimeId): boolean { return runtimeRegistry().some((item) => item.id === runtime && item.ready) }
export function selectAutoRuntime(seed: string): AgentRuntimeId | null {
  const ready = runtimeRegistry().filter((item) => item.ready).map((item) => item.id)
  if (ready.length === 0) return null
  const digest = createHash('sha256').update(seed).digest()
  return ready[digest[0] % ready.length] ?? null
}
export function resolveAssignedRuntime(preference: AgentRuntimePreference, seed: string): AgentRuntimeId | null {
  return preference === 'auto' ? selectAutoRuntime(seed) : runtimeReady(preference) ? preference : null
}
