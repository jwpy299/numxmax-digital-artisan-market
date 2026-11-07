import { beforeEach, describe, expect, it, vi } from 'vitest'
import { executeCanonicalPluginOutboxEvent } from './runtimePluginDispatch'
import { readRuntimePluginGrant } from './runtimePluginGrantMysql'
import type { RuntimePluginGrant } from './runtimePluginGrant'
import type { RuntimeLeaseContext } from './runtimeLeaseFence'

vi.mock('./runtimePluginGrantMysql', () => ({ readRuntimePluginGrant: vi.fn() }))
const loader = vi.mocked(readRuntimePluginGrant)
const grant: RuntimePluginGrant = { registrationId: 7, factoryId: 7, tenantId: 'factory:7', departmentId: 'dept-a', packageKey: 'agent.tasks', version: '1.0.0', installTicket: `pt_${'a'.repeat(48)}_r1`, artifactSha256: 'b'.repeat(64), status: 'installed', permissions: ['tasks:read'], entitlementStatus: 'active', expiresAt: null }
const scope = { eventId: 'evt-dispatch', tenantId: 'factory:7', factoryId: 7, departmentId: 'dept-a', taskId: 11, leaseId: 'lease-1', leaseEpoch: 3, workerId: 'worker-a' }
const lease: RuntimeLeaseContext = { status: 'active', ...scope, expiresAt: '2999-01-01T00:00:00Z' }
const event = { ...scope, source: 'plugin:agent.tasks', type: 'tasks.read', payloadSha256: 'a'.repeat(64), createdAt: '2026-11-04T16:00:00Z', dedupeKey: 'dedupe-dispatch' }
const result = { evidenceSha256: 'c'.repeat(64), summary: 'plugin dispatched; independent review required' }
function store() { return { claim: vi.fn(async () => 'claimed' as const), record: vi.fn(async () => undefined) } }

describe('canonical plugin dispatch', () => {
  beforeEach(() => { vi.clearAllMocks(); loader.mockResolvedValue(grant) })
  it('先读 canonical grant，再授权执行，结果仍不是 delivered', async () => {
    const persistence = store()
    const outcome = await executeCanonicalPluginOutboxEvent({ value: event, registrationId: 7, packageId: 11, factoryId: 7, action: 'tasks:read', readLease: async () => lease, store: persistence, executor: async () => result })
    expect(outcome).toMatchObject({ status: 'executed_not_done', delivered: false })
    expect(loader).toHaveBeenCalledWith({ registrationId: 7, packageId: 11, factoryId: 7 }, undefined)
    expect(persistence.claim).toHaveBeenCalledTimes(1)
  })
  it('工厂不匹配在 lease/claim/executor 前拒绝', async () => {
    const persistence = store(); const readLease = vi.fn(async () => lease); const executor = vi.fn(async () => result)
    await expect(executeCanonicalPluginOutboxEvent({ value: { ...event, factoryId: 999 }, registrationId: 7, packageId: 11, factoryId: 7, action: 'tasks:read', readLease, store: persistence, executor })).rejects.toThrow('runtime_plugin_tenant_mismatch')
    expect(readLease).not.toHaveBeenCalled(); expect(persistence.claim).not.toHaveBeenCalled(); expect(executor).not.toHaveBeenCalled()
  })
  it('canonical grant 不可用则没有执行权', async () => {
    loader.mockRejectedValue(new Error('runtime_plugin_grant_inactive'))
    const persistence = store(); const readLease = vi.fn(async () => lease)
    await expect(executeCanonicalPluginOutboxEvent({ value: event, registrationId: 7, packageId: 11, factoryId: 7, action: 'tasks:read', readLease, store: persistence, executor: async () => result })).rejects.toThrow('runtime_plugin_grant_inactive')
    expect(readLease).not.toHaveBeenCalled(); expect(persistence.claim).not.toHaveBeenCalled()
  })
})
