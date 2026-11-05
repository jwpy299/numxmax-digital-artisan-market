import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_TEST_DATABASE_PREFIX, agentTestPreviewFlag, agentEconomyMode, assertAgentEconomyBootMode, assertAgentTestDatabase, assertAgentTestDatabaseName } from './agentEconomy'

afterEach(() => { vi.unstubAllEnvs() })

describe('Agent 双轨经济开关', () => {
  it('缺省为 production 人民币口径', () => {
    expect(agentEconomyMode()).toBe('production')
    expect(() => assertAgentEconomyBootMode()).not.toThrow()
  })

  it('test 只在显式非生产与独立测试库同时成立时允许', () => {
    vi.stubEnv('ECONOMY_MODE', 'test')
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('AGENT_EMPLOYMENT_TEST_DATABASE', '1')
    expect(() => assertAgentEconomyBootMode()).not.toThrow()
    expect(() => assertAgentTestDatabase()).not.toThrow()
  })

  it('生产 NODE_ENV 与 test 同配直接拒绝', () => {
    vi.stubEnv('ECONOMY_MODE', 'test')
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AGENT_EMPLOYMENT_TEST_DATABASE', '1')
    expect(() => assertAgentEconomyBootMode()).toThrow('ECONOMY_MODE_TEST_FORBIDDEN_IN_PRODUCTION')
  })

  it('test 缺独立库标识或模式非法均拒绝', () => {
    vi.stubEnv('ECONOMY_MODE', 'test')
    vi.stubEnv('NODE_ENV', 'development')
    expect(() => assertAgentEconomyBootMode()).toThrow('AGENT_EMPLOYMENT_TEST_DATABASE_REQUIRED')
    vi.stubEnv('ECONOMY_MODE', 'invalid')
    expect(() => agentEconomyMode()).toThrow('ECONOMY_MODE_INVALID')
  })
  it('运行时真实库名必须与隔离测试库前缀一致', () => {
    vi.stubEnv('ECONOMY_MODE', 'test')
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('AGENT_EMPLOYMENT_TEST_DATABASE', '1')
    expect(() => assertAgentTestDatabaseName(`${AGENT_TEST_DATABASE_PREFIX}runtime`)).not.toThrow()
    for (const name of ['', 'numx_agent_production_test_runtime', 'nebula', null, undefined]) {
      expect(() => assertAgentTestDatabaseName(name)).toThrow('AGENT_EMPLOYMENT_TEST_DATABASE_NAME_MISMATCH')
    }
  })
  it('隔离预览只接受 1/true/yes，非法值明确拒绝', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes']) expect(agentTestPreviewFlag(value)).toBe(true)
    for (const value of ['', undefined]) expect(agentTestPreviewFlag(value)).toBe(false)
    for (const value of ['0', 'false', ' typo ', '2']) expect(() => agentTestPreviewFlag(value)).toThrow('AGENT_EMPLOYMENT_TEST_PREVIEW_INVALID')
  })
})
