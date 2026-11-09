import { beforeEach, describe, expect, it, vi } from 'vitest'
const { callDshMock } = vi.hoisted(() => ({ callDshMock: vi.fn() }))
vi.mock('../routers/dshClient', () => ({ callDsh: callDshMock }))
import { executeRuntimeTask } from './adapters'
import { agentModelProfile, agentStationKey, runtimeRegistry } from './registry'
import { AGENT_RUNTIME_PLUGIN_PROTOCOL } from '../../contracts/agentRuntimePlugin'

const task = { taskNo: 'RP_TEST_R1', role: '巡检岗', title: '巡检', brief: '输出可复核证据', factoryId: 42 }
describe('ARP：真实 Agent 运行时适配', () => {
  beforeEach(() => {
    callDshMock.mockReset()
    callDshMock.mockResolvedValue({ ok: true, answer: '真实 Agent 交付', durationMs: 12 })
    process.env.DSH_SERVICE_TOKEN = 'test-only-agent-token-000000'
    for (const id of ['KIMI', 'GLM', 'QWEN']) process.env[`AGENT_RUNTIME_${id}_ENABLED`] = '1'
    delete process.env.WORKBUDDY_RUNTIME_URL
    delete process.env.WORKBUDDY_API_KEY
  })
  it('DSH/Kimi/GLM/千问全部创建 DSH Agent 会话并绑定 stationKey 与模型 Profile', async () => {
    for (const [runtime, profile] of [['dsh', null], ['kimi', 'kimi-k3'], ['glm', 'glm-5.2'], ['qwen', 'qwen3.5:cloud']] as const) {
      const result = await executeRuntimeTask(runtime, task)
      expect(result).toMatchObject({ ok: true, provider: 'dsh-agent', model: profile, agentSession: { stationKey: agentStationKey(task.taskNo), modelProfile: profile } })
      expect(callDshMock).toHaveBeenCalledWith(expect.stringContaining('实际 Agent 执行体'), 120, 42, profile ?? undefined, agentStationKey(task.taskNo))
    }
    expect(callDshMock).toHaveBeenCalledTimes(4)
  })
  it('未显式启用的 Profile 不得借 SCNet 或其它模型顶替', async () => {
    process.env.AGENT_RUNTIME_KIMI_ENABLED = '0'
    const result = await executeRuntimeTask('kimi', task)
    expect(result).toMatchObject({ ok: false, errorCode: 'agent_profile_not_enabled' })
    expect(callDshMock).not.toHaveBeenCalled()
  })

  it('workbuddy 没有真正 Agent 服务时拒绝，不拿模型 API 顶替', async () => {
    const result = await executeRuntimeTask('workbuddy', task)
    expect(result).toMatchObject({ ok: false, errorCode: 'agent_runtime_not_configured' })
    expect(callDshMock).not.toHaveBeenCalled()
  })
  it('协议明确 Agent 不是 Chat Completion，且不改变既有插件包', () => {
    expect(AGENT_RUNTIME_PLUGIN_PROTOCOL.agentNotModel).toBe(true)
    expect(AGENT_RUNTIME_PLUGIN_PROTOCOL.notPkx).toBe(true)
    expect(AGENT_RUNTIME_PLUGIN_PROTOCOL.operations.createTicket.creates).toContain('agentWork')
    expect(runtimeRegistry().every((runtime) => runtime.kind !== 'external-agent-bridge' || runtime.id === 'workbuddy')).toBe(true)
    expect(agentModelProfile('glm')).toBe('glm-5.2')
  })
})
