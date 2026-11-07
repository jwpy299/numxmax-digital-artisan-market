import { describe, expect, it, vi } from 'vitest'
import { executeRuntimeOutboxEvent, type RuntimeOutboxEvidenceStore } from './runtimeOutboxExecutor'
import { createRuntimePluginEventAuthorizer, type RuntimePluginGrant } from './runtimePluginGrant'
import type { RuntimeLeaseContext } from './runtimeLeaseFence'

const scope = { eventId: 'evt-plugin', tenantId: 'factory:7', factoryId: 7, departmentId: 'dept-a', taskId: 11, leaseId: 'lease-1', leaseEpoch: 3, workerId: 'worker-a' }
const lease: RuntimeLeaseContext = { status: 'active', ...scope, expiresAt: '2999-01-01T00:00:00Z' }
const event = { ...scope, source: 'plugin:agent.tasks', type: 'tasks.read', payloadSha256: 'a'.repeat(64), createdAt: '2026-11-04T16:00:00Z', dedupeKey: 'dedupe-plugin' }
const grant: RuntimePluginGrant = { registrationId: 7, factoryId: 7, tenantId: 'factory:7', departmentId: 'dept-a', packageKey: 'agent.tasks', version: '1.0.0', installTicket: `pt_${'a'.repeat(48)}_r1`, artifactSha256: 'b'.repeat(64), status: 'installed', permissions: ['tasks:read'], entitlementStatus: 'active', expiresAt: null }
const result = { evidenceSha256: 'c'.repeat(64), summary: 'plugin executed; independent review still required' }
function store(): RuntimeOutboxEvidenceStore & { claim: ReturnType<typeof vi.fn>; record: ReturnType<typeof vi.fn> } {
  return { claim: vi.fn(async () => 'claimed' as const), record: vi.fn(async () => undefined) }
}

describe('runtime outbox 插件授权前置闸', () => {
  it('权限与来源通过才允许 lease／claim／执行，结果仍不是 delivered', async () => {
    const persistence = store()
    const outcome = await executeRuntimeOutboxEvent(event, async () => lease, persistence, async () => result, createRuntimePluginEventAuthorizer(grant, 'tasks:read'))
    expect(outcome).toMatchObject({ status: 'executed_not_done', delivered: false })
    expect(persistence.claim).toHaveBeenCalledTimes(1)
  })
  it('跨插件来源在 lease 查询和原子 claim 之前拒绝，无任何执行副作用', async () => {
    const persistence = store()
    const readLease = vi.fn(async () => lease)
    const executor = vi.fn(async () => result)
    await expect(executeRuntimeOutboxEvent({ ...event, source: 'plugin:other' }, readLease, persistence, executor, createRuntimePluginEventAuthorizer(grant, 'tasks:read'))).rejects.toThrow('runtime_plugin_source_mismatch')
    expect(readLease).not.toHaveBeenCalled()
    expect(persistence.claim).not.toHaveBeenCalled()
    expect(persistence.record).not.toHaveBeenCalled()
    expect(executor).not.toHaveBeenCalled()
  })
})
