import { describe, expect, it } from 'vitest'
import { assertNextRuntimeCheckpoint, createLeaseTakeoverCheckpoint, type RuntimeCheckpoint } from './runtimeCheckpoint'
import type { RuntimeLeaseContext } from './runtimeLeaseFence'

const previous: RuntimeCheckpoint = { eventId: 'evt-1', tenantId: 'tenant-a', factoryId: 7, departmentId: 'dept-a', taskId: 11, leaseId: 'lease-1', leaseEpoch: 3, workerId: 'worker-a', checkpointSeq: 2, state: 'progress' }
const lease: RuntimeLeaseContext = { status: 'active', ...previous }
const next = { ...previous, checkpointSeq: 3 }
const takeoverArgs = { currentLease: lease, previous, nextLeaseId: 'lease-2', nextWorkerId: 'worker-b', nextEventId: 'evt-1', leaseExpiresAt: '2026-11-04T16:00:00Z', now: '2026-11-04T16:01:00Z' }

describe('runtime checkpoint 与跨设备接管', () => {
  it('同一 lease/epoch/Worker 只允许序号 +1', () => {
    expect(() => assertNextRuntimeCheckpoint(previous, next, lease)).not.toThrow()
    for (const checkpointSeq of [2, 4, 0, -1]) expect(() => assertNextRuntimeCheckpoint(previous, { ...next, checkpointSeq }, lease)).toThrow()
  })
  it('正常推进不得换 Worker、lease 或 epoch', () => {
    for (const changed of [{ workerId: 'worker-b' }, { leaseId: 'lease-2' }, { leaseEpoch: 4 }]) {
      expect(() => assertNextRuntimeCheckpoint(previous, { ...next, ...changed }, lease)).toThrow()
    }
  })
  it('到期接管生成 epoch+1 的连续 checkpoint，旧 Worker 不能再写', () => {
    const taken = createLeaseTakeoverCheckpoint(takeoverArgs)
    expect(taken).toMatchObject({ leaseId: 'lease-2', leaseEpoch: 4, workerId: 'worker-b', checkpointSeq: 3, state: 'took_over' })
    expect(() => assertNextRuntimeCheckpoint(previous, next, { ...lease, status: 'revoked' })).toThrow('runtime_lease_not_active')
  })
  it('未到期、撤销租约、同 Worker 或同 lease 接管全部拒绝', () => {
    expect(() => createLeaseTakeoverCheckpoint({ ...takeoverArgs, now: '2026-11-04T15:59:00Z' })).toThrow('runtime_lease_not_expired')
    expect(() => createLeaseTakeoverCheckpoint({ ...takeoverArgs, currentLease: { ...lease, status: 'revoked' } })).toThrow('runtime_lease_not_active')
    expect(() => createLeaseTakeoverCheckpoint({ ...takeoverArgs, nextWorkerId: 'worker-a' })).toThrow('runtime_takeover_identity_required')
    expect(() => createLeaseTakeoverCheckpoint({ ...takeoverArgs, nextLeaseId: 'lease-1' })).toThrow('runtime_takeover_identity_required')
  })
})
