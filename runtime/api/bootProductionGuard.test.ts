import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureOpsTables } from '../db/sync-ops.mts'
import { ensureSmsTables } from './routers/smsYxt'

vi.mock('../db/sync-ops.mts', () => ({ ensureOpsTables: vi.fn() }))
vi.mock('./routers/smsYxt', () => ({
  ensureSmsTables: vi.fn(),
  smsYxtReportHandler: vi.fn(),
  smsYxtMoHandler: vi.fn(),
}))

describe('生产经济模式启动红线', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('生产误配 test 经济模式时，在 ops/sms DDL 与监听前 fail-closed', async () => {
    vi.stubEnv('APP_ID', 'boot-guard-test')
    vi.stubEnv('APP_SECRET', 'boot-guard-test')
    vi.stubEnv('DATABASE_URL', 'mysql://test:test@127.0.0.1:3306/numx_agent_employment_test_boot_guard')
    vi.stubEnv('KIMI_AUTH_URL', 'https://auth.example.invalid')
    vi.stubEnv('KIMI_OPEN_URL', 'https://api.example.invalid')
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ECONOMY_MODE', 'test')
    vi.stubEnv('AGENT_EMPLOYMENT_TEST_DATABASE', '1')
    vi.stubEnv('AGENT_EMPLOYMENT_TEST_PREVIEW', '0')
    vi.stubEnv('NEBULA_VITE_DEV_SERVER', '0')
    vi.stubEnv('BIND_HOST', '127.0.0.1')
    vi.stubEnv('PORT', '4096')

    await expect(import('./boot')).rejects.toThrow('ECONOMY_MODE_TEST_FORBIDDEN_IN_PRODUCTION')
    expect(vi.mocked(ensureOpsTables)).not.toHaveBeenCalled()
    expect(vi.mocked(ensureSmsTables)).not.toHaveBeenCalled()
  }, 20_000)
})
