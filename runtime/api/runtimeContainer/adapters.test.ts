import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
const { callDshMock, fetchMock } = vi.hoisted(() => ({ callDshMock: vi.fn(), fetchMock: vi.fn() }))
vi.mock('../routers/dshClient', () => ({ callDsh: callDshMock }))
import { cancelWorkbuddyAgentTask, executeRuntimeTask } from './adapters'
import { agentModelProfile, agentStationKey, runtimeRegistry } from './registry'
import { AGENT_RUNTIME_PLUGIN_PROTOCOL } from '../../contracts/agentRuntimePlugin'

const task = { taskNo: 'RP_TEST_R1', role: '巡检岗', title: '巡检', brief: '输出可复核证据', factoryId: 42 }
describe('ARP：真实 Agent 运行时适配', () => {
  beforeEach(() => {
    callDshMock.mockReset()
    fetchMock.mockReset()
    globalThis.fetch = fetchMock as never
    callDshMock.mockResolvedValue({ ok: true, answer: '真实 Agent 交付', durationMs: 12 })
    process.env.DSH_SERVICE_TOKEN = 'test-only-agent-token-000000'
    // 故意保留旧环境开关，验证它不能把 GLM／千问重新打开，也不能关掉 Kimi。
    for (const id of ['KIMI', 'GLM', 'QWEN']) process.env[`AGENT_RUNTIME_${id}_ENABLED`] = '1'
    delete process.env.WORKBUDDY_RUNTIME_URL
    delete process.env.WORKBUDDY_API_KEY
  })
  it('仅 DSH/Kimi 创建 DSH Agent 会话并绑定 stationKey 与模型 Profile', async () => {
    for (const [runtime, profile] of [['dsh', null], ['kimi', 'kimi-k3']] as const) {
      const result = await executeRuntimeTask(runtime, task)
      expect(result).toMatchObject({ ok: true, provider: 'dsh-agent', model: profile, agentSession: { stationKey: agentStationKey(task.taskNo), modelProfile: profile } })
      expect(callDshMock).toHaveBeenCalledWith(expect.stringContaining('实际 Agent 执行体'), 120, 42, profile ?? undefined, agentStationKey(task.taskNo))
    }
    expect(callDshMock).toHaveBeenCalledTimes(2)
  })
  it('GLM/千问即使旧环境开关为 1 也保持硬关闭，不得借其它模型顶替', async () => {
    for (const runtime of ['glm', 'qwen'] as const) {
      const result = await executeRuntimeTask(runtime, task)
      expect(result).toMatchObject({ ok: false, errorCode: 'agent_runtime_disabled' })
      expect(runtimeRegistry().find((item) => item.id === runtime)).toMatchObject({ ready: false })
    }
    expect(callDshMock).not.toHaveBeenCalled()
  })
  it('Kimi 属于当前白名单，不受旧 Profile 环境开关影响', async () => {
    process.env.AGENT_RUNTIME_KIMI_ENABLED = '0'
    const result = await executeRuntimeTask('kimi', task)
    expect(result).toMatchObject({ ok: true, provider: 'dsh-agent', model: 'kimi-k3' })
    expect(callDshMock).toHaveBeenCalledTimes(1)
  })

  it('workbuddy 没有真正 Agent 服务时拒绝，不拿模型 API 顶替', async () => {
    const result = await executeRuntimeTask('workbuddy', task)
    expect(result).toMatchObject({ ok: false, errorCode: 'agent_runtime_not_configured' })
    expect(callDshMock).not.toHaveBeenCalled()
  })
  it('workbuddy 必须完成 Ticket／事件／交付协议后才算成功', async () => {
    process.env.WORKBUDDY_RUNTIME_URL = 'http://127.0.0.1:18797'
    process.env.WORKBUDDY_API_KEY = 'test-workbuddy-token-000000'
    const content = 'workbuddy 真实交付'
    const resultSha256 = createHash('sha256').update(content).digest('hex')
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true, agentNotModel: true }))
      if (url.endsWith('/run')) return new Response(JSON.stringify({ ok: true, answer: content, ticketId: 'wb-test-1', sessionId: 'wb-session-1', resultSha256, eventsUrl: '/events?ticketId=wb-test-1', resultUrl: '/result?ticketId=wb-test-1', cancelUrl: '/cancel' }))
      if (url.includes('/events?')) return new Response(JSON.stringify({ ok: true, events: [{ type: 'runtime.completed' }] }))
      if (url.includes('/result?')) return new Response(JSON.stringify({ ok: true, status: 'delivered', answer: content, resultSha256 }))
      if (url.endsWith('/cancel')) return new Response(JSON.stringify({ ok: true, cancelled: true }))
      throw new Error(`unexpected url ${url}`)
    })
    const result = await executeRuntimeTask('workbuddy', task)
    expect(result).toMatchObject({ ok: true, provider: 'workbuddy-agent', resultSha256, agentSession: { stationKey: 'wb-session-1', ticketId: 'wb-test-1' } })
    await expect(cancelWorkbuddyAgentTask('wb-session-1')).resolves.toBe(true)
  })
  it('workbuddy 缺 Ticket 或交付证据时 fail-closed，不把 /run 答案当完成', async () => {
    process.env.WORKBUDDY_RUNTIME_URL = 'http://127.0.0.1:18797'
    process.env.WORKBUDDY_API_KEY = 'test-workbuddy-token-000000'
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true, agentNotModel: true }))
      if (url.endsWith('/run')) return new Response(JSON.stringify({ ok: true, answer: '只有答案没有 Ticket' }))
      throw new Error(`unexpected url ${url}`)
    })
    const result = await executeRuntimeTask('workbuddy', task)
    expect(result).toMatchObject({ ok: false, errorCode: 'agent_protocol_violation' })
  })
  it('协议明确 Agent 不是 Chat Completion，且不改变既有插件包', () => {
    expect(AGENT_RUNTIME_PLUGIN_PROTOCOL.agentNotModel).toBe(true)
    expect(AGENT_RUNTIME_PLUGIN_PROTOCOL.notPkx).toBe(true)
    expect(AGENT_RUNTIME_PLUGIN_PROTOCOL.operations.createTicket.creates).toContain('agentWork')
    expect(runtimeRegistry().every((runtime) => runtime.kind !== 'external-agent-bridge' || runtime.id === 'workbuddy')).toBe(true)
    expect(runtimeRegistry().filter((runtime) => runtime.ready).map((runtime) => runtime.id)).toEqual(['dsh', 'kimi'])
    expect(agentModelProfile('glm')).toBe('glm-5.2')
  })
})
