import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

describe('微信支付 feature gate', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })
  it('关闭时没有支付 namespace，也没有回调注册', { timeout: 20_000 }, async () => {
    vi.stubEnv('WECHAT_PAYMENTS_ENABLED', '0')
    const { appRouter } = await import('./router')
    expect(Object.prototype.hasOwnProperty.call(appRouter, 'agentPluginPayments')).toBe(false)
    const boot = readFileSync(new URL('./boot.ts', import.meta.url), 'utf8')
    expect(boot).toContain('wechatPaymentsEnabled()')
    expect(boot).toContain('assertWechatPaymentBootConfig()')
    expect(boot).toContain('app.post(WECHAT_CALLBACK_PATH, handleWechatPayCallback)')
  })
  it('打开时才挂载支付 namespace', async () => {
    vi.stubEnv('WECHAT_PAYMENTS_ENABLED', '1')
    const { appRouter } = await import('./router')
    expect(Object.prototype.hasOwnProperty.call(appRouter, 'agentPluginPayments')).toBe(true)
  })
})
