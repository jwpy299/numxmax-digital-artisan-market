import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePlannerContent, planNaturalLanguage } from './planner'

const oldKey = process.env.SCNET_API_KEY
beforeEach(() => { process.env.SCNET_API_KEY = 'test-only-scnet-key-000000000000' })
afterEach(() => {
  if (oldKey === undefined) delete process.env.SCNET_API_KEY
  else process.env.SCNET_API_KEY = oldKey
  vi.restoreAllMocks()
})
const departments = [{ id: 'dept-a', name: '制造部' }]
const content = JSON.stringify({ tasks: [
  { role: '巡检负责人', title: '巡检产线', brief: '输出巡检清单、证据与异常边界。', runtime: 'dsh' },
  { role: '复核负责人', title: '复核报告', brief: '独立复核报告并列出未验证项。', runtime: 'kimi' },
] })

describe('SCNet 严格自然语言规划', () => {
  it('只接受严格岗位 JSON，拒绝伪造执行结果或越界 runtime', () => {
    expect(parsePlannerContent(content)).toHaveLength(2)
    expect(() => parsePlannerContent('{"tasks":[{"role":"a","title":"b","brief":"c","runtime":"other"}]}')).toThrow('invalid')
    expect(() => parsePlannerContent('不是JSON')).toThrow('invalid_json')
  })
  it('真实 HTTP 合同只发指定 SCNet 模型，不降级供应商', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'planner-test', model: 'DeepSeek-V4.1-Flash-1017', choices: [{ message: { content } }], usage: { total_tokens: 88 } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const result = await planNaturalLanguage({ instruction: '让两个岗位并行完成巡检和复核', departmentId: 'dept-a', departments, availableRuntimes: ['dsh', 'kimi'], fetchImpl: fetchImpl as typeof fetch })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body)).model).toBe('DeepSeek-V4.1-Flash-1017')
    expect(result.tasks).toHaveLength(2)
    expect(result.evidence).toMatchObject({ provider: 'scnet', model: 'DeepSeek-V4.1-Flash-1017', usageTokens: 88 })
  })
  it('SCNet 失败只报错，不调用第二家、不生成替代计划', async () => {
    const fetchImpl = vi.fn(async () => new Response('denied', { status: 401 }))
    await expect(planNaturalLanguage({ instruction: '并行安排两个岗位', departmentId: 'dept-a', departments, availableRuntimes: ['dsh'], fetchImpl: fetchImpl as typeof fetch })).rejects.toThrow('agent_runtime_planner_http_error')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
