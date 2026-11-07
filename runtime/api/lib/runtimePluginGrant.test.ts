import { describe, expect, it, vi } from 'vitest'
import { createRuntimePluginEventAuthorizer, type RuntimePluginGrant } from './runtimePluginGrant'
import { parseRuntimeEventEnvelope } from './runtimeEventContract'

const grant: RuntimePluginGrant = { registrationId: 7, factoryId: 7, tenantId: 'factory:7', departmentId: 'dept-a', packageKey: 'agent.tasks', version: '1.0.0', installTicket: `pt_${'a'.repeat(48)}_r1`, artifactSha256: 'b'.repeat(64), status: 'installed', permissions: ['tasks:read'], entitlementStatus: 'active', expiresAt: null }
const event = parseRuntimeEventEnvelope({ eventId: 'evt-plugin', tenantId: 'factory:7', factoryId: 7, departmentId: 'dept-a', taskId: 11, leaseId: 'lease-a', leaseEpoch: 1, workerId: 'worker-a', source: 'plugin:agent.tasks', type: 'tasks.read', payloadSha256: 'c'.repeat(64), createdAt: new Date().toISOString(), dedupeKey: 'dedupe-plugin' })

describe('runtime-events 插件最小权限', () => {
  it('有效安装票据＋有效权益＋来源＋权限才放行', () => {
    expect(() => createRuntimePluginEventAuthorizer(grant, 'tasks:read')(event)).not.toThrow()
  })
  it('未声明权限、卸载、权益撤销、过期和跨插件来源全部拒绝', () => {
    expect(() => createRuntimePluginEventAuthorizer(grant, 'tasks:write')).toThrow('runtime_plugin_permission_denied')
    expect(() => createRuntimePluginEventAuthorizer({ ...grant, status: 'uninstalled' }, 'tasks:read')).toThrow('runtime_plugin_grant_inactive')
    expect(() => createRuntimePluginEventAuthorizer({ ...grant, entitlementStatus: 'revoked' }, 'tasks:read')).toThrow('runtime_plugin_grant_inactive')
    expect(() => createRuntimePluginEventAuthorizer({ ...grant, expiresAt: new Date(Date.now() - 1000).toISOString() }, 'tasks:read')).toThrow('runtime_plugin_entitlement_expired')
    expect(() => createRuntimePluginEventAuthorizer(grant, 'tasks:read')({ ...event, source: 'plugin:other' })).toThrow('runtime_plugin_source_mismatch')
    expect(() => createRuntimePluginEventAuthorizer(grant, 'tasks:read')({ ...event, factoryId: 999 })).toThrow('runtime_plugin_tenant_mismatch')
    expect(() => createRuntimePluginEventAuthorizer(grant, 'tasks:read')({ ...event, tenantId: 'factory:999' })).toThrow('runtime_plugin_tenant_mismatch')
    expect(() => createRuntimePluginEventAuthorizer(grant, 'tasks:read')({ ...event, departmentId: 'dept-b' })).toThrow('runtime_plugin_tenant_mismatch')
  })
  it('wallet/admin 等任意权限不能进入授权面', () => {
    expect(() => createRuntimePluginEventAuthorizer({ ...grant, permissions: ['wallet:write' as never] }, 'tasks:read')).toThrow('runtime_plugin_permissions_invalid')
  })
  it('权益在事件发生时过期同样拒绝，不能沿用创建授权器时的旧时间', () => {
    vi.useFakeTimers()
    try {
      const now = Date.now()
      const authorize = createRuntimePluginEventAuthorizer({ ...grant, expiresAt: new Date(now + 1000).toISOString() }, 'tasks:read', now)
      vi.setSystemTime(now + 1001)
      expect(() => authorize(event)).toThrow('runtime_plugin_entitlement_expired')
    } finally { vi.useRealTimers() }
  })

  it('写事件和未知事件类型不能绕过 read 权限', () => {
    expect(() => createRuntimePluginEventAuthorizer(grant, 'tasks:read')({ ...event, type: 'tasks.write' })).toThrow('runtime_plugin_event_action_mismatch')
    expect(() => createRuntimePluginEventAuthorizer(grant, 'tasks:read')({ ...event, type: 'training.read' })).toThrow('runtime_plugin_event_action_mismatch')
    expect(() => createRuntimePluginEventAuthorizer(grant, 'tasks:read')({ ...event, type: 'admin.write' })).toThrow('runtime_plugin_event_type_invalid')
  })

})
