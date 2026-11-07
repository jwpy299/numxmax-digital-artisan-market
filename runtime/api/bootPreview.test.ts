import { afterEach, describe, expect, it, vi } from 'vitest'

describe('隔离测试预览监听边界', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })
  it('非回环地址在数据库连接与监听前 fail-closed', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('ECONOMY_MODE', 'test')
    vi.stubEnv('AGENT_EMPLOYMENT_TEST_DATABASE', '1')
    vi.stubEnv('AGENT_EMPLOYMENT_TEST_PREVIEW', '1')
    vi.stubEnv('BIND_HOST', '0.0.0.0')
    vi.stubEnv('PORT', '4095')
    await expect(import('./boot')).rejects.toThrow('AGENT_TEST_PREVIEW_HOST_FORBIDDEN')
  }, 20_000)
})
