import { RuntimeLeaseFenceError, type RuntimeEventMandate } from './runtimeLeaseFence'
import { AGENT_PLUGIN_PERMISSIONS } from './agentPluginManifest'
import type { RuntimeEventEnvelope } from './runtimeEventContract'

export const RUNTIME_PLUGIN_PERMISSIONS = AGENT_PLUGIN_PERMISSIONS
const EVENT_PERMISSIONS: Record<string, RuntimePluginPermission> = {
  'tasks.read': 'tasks:read',
  'tasks.write': 'tasks:write',
  'evidence.read': 'evidence:read',
  'training.read': 'training:read',
}
export type RuntimePluginPermission = 'tasks:read' | 'tasks:write' | 'evidence:read' | 'training:read'
export interface RuntimePluginGrant {
  registrationId: number
  factoryId: number
  tenantId: string
  departmentId: string
  packageKey: string
  version: string
  installTicket: string
  artifactSha256: string
  status: 'installed' | 'uninstalled' | 'revoked'
  permissions: RuntimePluginPermission[]
  entitlementStatus: 'active' | 'revoked' | 'expired'
  expiresAt: string | null
}

/** 输入必须来自 canonical 安装票据、权益和已验签制品回读，不能直接信任浏览器或 manifest 自声明。 */
export function assertRuntimePluginGrant(grant: RuntimePluginGrant, now = Date.now()): void {
  if (!Number.isSafeInteger(grant.registrationId) || grant.registrationId <= 0 || !Number.isSafeInteger(grant.factoryId) || grant.factoryId <= 0) throw new RuntimeLeaseFenceError('runtime_plugin_grant_invalid')
  if (grant.tenantId !== `factory:${grant.factoryId}` || typeof grant.departmentId !== 'string' || grant.departmentId.trim().length === 0 || grant.departmentId.length > 64) throw new RuntimeLeaseFenceError('runtime_plugin_grant_invalid')
  if (!/^[a-z][a-z0-9._-]{1,63}$/.test(grant.packageKey) || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(grant.version)) throw new RuntimeLeaseFenceError('runtime_plugin_grant_invalid')
  if (!/^(?:pt|rpt)_[a-f0-9]{48}(?:_r\d+)?$/.test(grant.installTicket) || !/^[a-f0-9]{64}$/.test(grant.artifactSha256)) throw new RuntimeLeaseFenceError('runtime_plugin_grant_invalid')
  if (grant.status !== 'installed' || grant.entitlementStatus !== 'active') throw new RuntimeLeaseFenceError('runtime_plugin_grant_inactive')
  if (!Array.isArray(grant.permissions) || grant.permissions.length === 0 || grant.permissions.length > 8 || new Set(grant.permissions).size !== grant.permissions.length || grant.permissions.some((permission) => !RUNTIME_PLUGIN_PERMISSIONS.has(permission))) throw new RuntimeLeaseFenceError('runtime_plugin_permissions_invalid')
  if (grant.expiresAt !== null && (!Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now)) throw new RuntimeLeaseFenceError('runtime_plugin_entitlement_expired')
}

export function createRuntimePluginEventAuthorizer(grant: RuntimePluginGrant, action: RuntimePluginPermission, now = Date.now()): (event: Readonly<RuntimeEventEnvelope>) => void {
  assertRuntimePluginGrant(grant, now)
  if (!grant.permissions.includes(action)) throw new RuntimeLeaseFenceError('runtime_plugin_permission_denied')
  return (event) => {
    assertRuntimePluginGrant(grant)
    const required = EVENT_PERMISSIONS[event.type as RuntimePluginPermission]
    if (!required) throw new RuntimeLeaseFenceError('runtime_plugin_event_type_invalid')
    if (required !== action) throw new RuntimeLeaseFenceError('runtime_plugin_event_action_mismatch')
    if (!grant.permissions.includes(required)) throw new RuntimeLeaseFenceError('runtime_plugin_permission_denied')
    if (event.tenantId !== grant.tenantId || event.departmentId !== grant.departmentId || event.factoryId !== grant.factoryId) throw new RuntimeLeaseFenceError('runtime_plugin_tenant_mismatch')
    if (event.source !== `plugin:${grant.packageKey}`) throw new RuntimeLeaseFenceError('runtime_plugin_source_mismatch')
  }
}

export type { RuntimeEventMandate }
