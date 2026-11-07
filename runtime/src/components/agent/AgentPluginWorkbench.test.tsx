// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AgentPluginWorkbench from './AgentPluginWorkbench'

const mocks = vi.hoisted(() => ({ callWb: vi.fn(), useWbQuery: vi.fn(), save: vi.fn(), refetch: vi.fn() }))
vi.mock('@/lib/wbSession', () => ({
  callWb: mocks.callWb,
  useWbQuery: mocks.useWbQuery,
  wbErrorMessage: (err: unknown) => err instanceof Error ? err.message : String(err),
}))
vi.mock('@/lib/agentPluginDownload', () => ({ savePluginArtifact: mocks.save }))

const session = { token: 'unit-test-session' } as never
const registrations = [{ id: 7, registrationNo: 'AR-7', agentName: '测试 Agent' }]
const manifest = { entry: 'index.js', permissions: ['tasks:read'], platform: 'linux', arch: 'x64', dependencies: ['runtime:oap-v0'], payloadSha256: 'a'.repeat(64), signature: 'sig', signerPublicKey: 'key' }
const pkg = { id: 11, packageKey: 'agent.tasks', name: '任务插件', version: '1.0.0', description: null, artifactSha256: 'a'.repeat(64), priceCents: 9900, durationDays: 30, status: 'active', manifest, signatureVerified: true, trustedKeySha256: 'c'.repeat(64) }

describe('Agent 插件工作台交互（jsdom 单元测试，不冒充真机）', () => {
  afterEach(() => cleanup())
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useWbQuery.mockImplementation((name: string) => ({
      data: name === 'agentPlugins.list' ? { packages: [pkg] } : { installs: [], entitlements: [{ packageId: 11, status: 'active', effectiveStatus: 'active', expiresAt: null }] },
      loading: false, error: null, refetch: mocks.refetch,
    }))
    mocks.callWb.mockImplementation(async (_method: string, name: string) => {
      if (name === 'agentPlugins.install') return { installTicket: 'pt_test', already: false }
      if (name === 'agentPlugins.download') return { fileName: 'agent.tasks-1.0.0.pkx', artifactBase64: btoa('PK-test'), artifactSha256: 'a'.repeat(64), executable: false }
      if (name === 'agentPlugins.rollback') return { version: '1.0.0', installTicket: 'rpt_test' }
      if (name === 'agentPluginPayments.create') return { orderNo: 'pp_test_order' }
      if (name === 'agentPluginPayments.qr') {
        return {
          orderNo: 'pp_test_order',
          codeUrl: 'weixin://wxpay/bizpayurl?pr=test',
          pngBase64: 'iVBORw0KGgo=',
          binding: { outTradeNo: 'pp_test_order', registrationId: 7, packageId: 11, factoryId: 1, amountCents: 9900, durationDays: 30 },
        }
      }
      if (name === 'agentPluginPayments.status') return { status: 'pending' }
      return { ok: true, affectedRows: 1 }
    })
  })
  it('未选择达标 Agent 时禁止动作；选择后安装与验签下载调用真实 API 契约', async () => {
    const { rerender } = render(<AgentPluginWorkbench session={session} registrations={registrations} registrationId={0} onRegistrationChange={() => undefined} />)
    expect(screen.getByRole('button', { name: '安装' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '验签下载' })).toHaveProperty('disabled', true)
    rerender(<AgentPluginWorkbench session={session} registrations={registrations} registrationId={7} onRegistrationChange={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    await screen.findByText(/安装回执已回读：pt_test/)
    expect(mocks.callWb).toHaveBeenCalledWith('mutation', 'agentPlugins.install', session, { registrationId: 7, packageId: 11 })
    fireEvent.click(screen.getByRole('button', { name: '验签下载' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalled())
    expect(mocks.save.mock.calls[0][0]).toMatchObject({ executable: false, artifactSha256: 'a'.repeat(64) })
    expect(mocks.refetch).toHaveBeenCalled()
  })
  it('卸载和回滚都带 registrationId/packageId，并回读服务端', async () => {
    const installed = { id: 5, registrationId: 7, packageId: 11, packageKey: 'agent.tasks', name: '任务插件', version: '1.1.0', status: 'installed', installTicket: 'pt_11', rollbackOf: null, artifactSha256: 'b'.repeat(64) }
    mocks.useWbQuery.mockImplementation((name: string) => ({ data: name === 'agentPlugins.list' ? { packages: [pkg] } : { installs: [installed], entitlements: [{ packageId: 11, status: 'active', effectiveStatus: 'active', expiresAt: null }] }, loading: false, error: null, refetch: mocks.refetch }))
    render(<AgentPluginWorkbench session={session} registrations={registrations} registrationId={7} onRegistrationChange={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: '回滚' }))
    await screen.findByText(/已回滚到 1.0.0/)
    expect(mocks.callWb).toHaveBeenCalledWith('mutation', 'agentPlugins.rollback', session, { registrationId: 7, packageId: 11 })
    fireEvent.click(screen.getByRole('button', { name: '卸载' }))
    await screen.findByText(/已卸载并回读/)
    expect(mocks.callWb).toHaveBeenCalledWith('mutation', 'agentPlugins.uninstall', session, { registrationId: 7, packageId: 11 })
  })
  it('订阅二维码绑定订单、金额和服务端期限', async () => {
    mocks.useWbQuery.mockImplementation((name: string) => ({ data: name === 'agentPlugins.list' ? { packages: [pkg] } : { installs: [], entitlements: [{ packageId: 11, status: 'revoked', effectiveStatus: 'inactive', expiresAt: null }] }, loading: false, error: null, refetch: mocks.refetch }))
    render(<AgentPluginWorkbench session={session} registrations={registrations} registrationId={7} onRegistrationChange={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: '订阅30天 ¥99.00' }))
    await screen.findByAltText(/微信支付二维码/)
    expect(mocks.callWb).toHaveBeenCalledWith('mutation', 'agentPluginPayments.create', session, { registrationId: 7, packageId: 11, idempotencyKey: expect.stringMatching(/^plugin-subscription-/) })
    expect(mocks.callWb).toHaveBeenCalledWith('query', 'agentPluginPayments.qr', session, { orderNo: 'pp_test_order' })
    expect(screen.getByText(/期限：30 天/)).toBeTruthy()
    expect(screen.queryByText(/一个月/)).toBeNull()
    expect(screen.getByText(/out_trade_no：pp_test_order/)).toBeTruthy()
  })

  it('订阅失败重试复用同一幂等键', async () => {
    mocks.useWbQuery.mockImplementation((name: string) => ({ data: name === 'agentPlugins.list' ? { packages: [pkg] } : { installs: [], entitlements: [{ packageId: 11, status: 'revoked', effectiveStatus: 'inactive', expiresAt: null }] }, loading: false, error: null, refetch: mocks.refetch }))
    mocks.callWb.mockImplementationOnce(async () => { throw new Error('create failed') })
    render(<AgentPluginWorkbench session={session} registrations={registrations} registrationId={7} onRegistrationChange={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: '订阅30天 ¥99.00' }))
    fireEvent.click(await screen.findByRole('button', { name: /重试（服务端幂等回读）/ }))
    await screen.findByAltText(/微信支付二维码/)
    const keys = mocks.callWb.mock.calls.filter((call) => call[1] === 'agentPluginPayments.create').map((call) => call[3].idempotencyKey)
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
  })
  it('切换 Agent 后清除旧重试与旧二维码，不把动作发给原 Agent', async () => {
    const twoRegistrations = [...registrations, { id: 8, registrationNo: 'AR-8', agentName: '另一个 Agent' }]
    mocks.useWbQuery.mockImplementation((name: string) => ({ data: name === 'agentPlugins.list' ? { packages: [pkg] } : { installs: [], entitlements: [{ packageId: 11, status: 'revoked', effectiveStatus: 'inactive', expiresAt: null }] }, loading: false, error: null, refetch: mocks.refetch }))
    mocks.callWb.mockImplementationOnce(async () => { throw new Error('create failed') })
    const { rerender } = render(<AgentPluginWorkbench session={session} registrations={twoRegistrations} registrationId={7} onRegistrationChange={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: '订阅30天 ¥99.00' }))
    expect(await screen.findByRole('button', { name: /重试（服务端幂等回读）/ })).toBeTruthy()
    rerender(<AgentPluginWorkbench session={session} registrations={twoRegistrations} registrationId={8} onRegistrationChange={() => undefined} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: /重试（服务端幂等回读）/ })).toBeNull())
    expect(mocks.callWb.mock.calls.filter((call) => call[1] === 'agentPluginPayments.create')).toHaveLength(1)
  })
  it('非 30 天套餐按服务端 durationDays 展示按钮与二维码期限', async () => {
    const custom = { ...pkg, durationDays: 45 }
    mocks.useWbQuery.mockImplementation((name: string) => ({ data: name === 'agentPlugins.list' ? { packages: [custom] } : { installs: [], entitlements: [{ packageId: 11, status: 'revoked', effectiveStatus: 'inactive', expiresAt: null }] }, loading: false, error: null, refetch: mocks.refetch }))
    mocks.callWb.mockImplementation(async (_method: string, name: string) => {
      if (name === 'agentPluginPayments.create') return { orderNo: 'pp_test_order' }
      if (name === 'agentPluginPayments.qr') return { orderNo: 'pp_test_order', codeUrl: 'weixin://wxpay/bizpayurl?pr=test', pngBase64: 'iVBORw0KGgo=', binding: { outTradeNo: 'pp_test_order', registrationId: 7, packageId: 11, factoryId: 1, amountCents: 9900, durationDays: 45 } }
      return { ok: true }
    })
    render(<AgentPluginWorkbench session={session} registrations={registrations} registrationId={7} onRegistrationChange={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: '订阅45天 ¥99.00' }))
    await screen.findByAltText(/微信支付二维码/)
    expect(screen.getByText(/期限：45 天/)).toBeTruthy()
    expect(screen.queryByText(/一个月/)).toBeNull()
  })
})
