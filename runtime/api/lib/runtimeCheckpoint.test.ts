import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { assertNextRuntimeCheckpoint, createLeaseTakeoverCheckpoint, type RuntimeCheckpoint } from './runtimeCheckpoint'
import type { RuntimeLeaseContext } from './runtimeLeaseFence'

beforeEach(() => { vi.setSystemTime(new Date('2026-11-04T16:01:00Z')) })
afterEach(() => { vi.useRealTimers() })

const previous: RuntimeCheckpoint = { eventId: 'evt-1', tenantId: 'tenant-a', factoryId: 7, departmentId: 'dept-a', taskId: 11, leaseId: 'lease-1', leaseEpoch: 3, workerId: 'worker-a', checkpointSeq: 2, state: 'progress' }
const lease: RuntimeLeaseContext = { status: 'active', ...previous, expiresAt: '2999-01-01T00:00:00Z' }
const next = { ...previous, checkpointSeq: 3 }
const takeoverArgs = { currentLease: { ...lease, expiresAt: '2026-11-04T16:00:00Z' }, previous, nextLeaseId: 'lease-2', nextWorkerId: 'worker-b', nextEventId: 'evt-1', leaseExpiresAt: '2026-11-04T16:00:00Z', now: '2026-11-04T16:01:00Z' }

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
  it('普通同 lease 推进不得伪造 took_over', () => {
    expect(() => assertNextRuntimeCheckpoint(previous, { ...next, state: 'took_over' }, lease)).toThrow('runtime_checkpoint_takeover_requires_lease_change')
  })
  it('checkpoint 只允许 started→progress→executed_not_done 的合法迁移', () => {
    const startedCheckpoint = { ...previous, state: 'started' as const }
    expect(() => assertNextRuntimeCheckpoint(startedCheckpoint, { ...next, state: 'progress' }, lease)).not.toThrow()
    expect(() => assertNextRuntimeCheckpoint(startedCheckpoint, { ...next, state: 'executed_not_done' }, lease)).toThrow('runtime_checkpoint_state_transition_invalid')
    expect(() => assertNextRuntimeCheckpoint(previous, { ...next, state: 'started' }, lease)).toThrow('runtime_checkpoint_state_transition_invalid')
    expect(() => assertNextRuntimeCheckpoint({ ...previous, state: 'executed_not_done' }, { ...next, state: 'progress' }, lease)).toThrow('runtime_checkpoint_state_transition_invalid')
    expect(() => assertNextRuntimeCheckpoint({ ...previous, state: 'took_over' }, { ...next, state: 'progress' }, lease)).not.toThrow()
  })
  it('到期接管生成 epoch+1 的连续 checkpoint，旧 Worker 不能再写', () => {
    const taken = createLeaseTakeoverCheckpoint(takeoverArgs)
    expect(taken).toMatchObject({ leaseId: 'lease-2', leaseEpoch: 4, workerId: 'worker-b', checkpointSeq: 3, state: 'took_over' })
    expect(() => assertNextRuntimeCheckpoint(previous, next, { ...lease, status: 'revoked' })).toThrow('runtime_lease_not_active')
  })
  it('未到期、撤销租约、同 Worker 或同 lease 接管全部拒绝', () => {
    vi.setSystemTime(new Date('2026-11-04T15:59:00Z'))
    expect(() => createLeaseTakeoverCheckpoint({ ...takeoverArgs, now: '2026-11-04T15:59:00Z' })).toThrow('runtime_lease_not_expired')
    const expiredRevokedLease = { ...takeoverArgs.currentLease, status: 'revoked' as const, expiresAt: '2026-11-04T15:00:00Z' }
    const expiredRevokedArgs = { ...takeoverArgs, currentLease: expiredRevokedLease, leaseExpiresAt: expiredRevokedLease.expiresAt }
    expect(() => createLeaseTakeoverCheckpoint(expiredRevokedArgs)).not.toThrow()
    expect(() => createLeaseTakeoverCheckpoint({ ...expiredRevokedArgs, nextWorkerId: 'worker-a' })).toThrow('runtime_takeover_identity_required')
    expect(() => createLeaseTakeoverCheckpoint({ ...expiredRevokedArgs, nextLeaseId: 'lease-1' })).toThrow('runtime_takeover_identity_required')
  })
  it('到期但未撤销的 active lease 允许接管，scope 不匹配的到期 lease 仍拒绝', () => {
    const taken = createLeaseTakeoverCheckpoint({ ...takeoverArgs, currentLease: { ...lease, expiresAt: '2026-11-04T16:00:00Z' } })
    expect(taken).toMatchObject({ leaseId: 'lease-2', leaseEpoch: 4, workerId: 'worker-b', state: 'took_over' })
    expect(() => createLeaseTakeoverCheckpoint({ ...takeoverArgs, currentLease: { ...lease, tenantId: 'tenant-b', expiresAt: '2026-11-04T16:00:00Z' } })).toThrow('runtime_lease_scope_mismatch')
  })

  it('revoked 或 closed lease 可按 canonical 时间接管，active 未到期仍拒绝', () => {
    vi.setSystemTime(new Date('2026-11-04T15:59:00Z'))
    for (const status of ['revoked', 'closed'] as const) {
      const taken = createLeaseTakeoverCheckpoint({ ...takeoverArgs, currentLease: { ...takeoverArgs.currentLease, status } })
      expect(taken).toMatchObject({ leaseId: 'lease-2', leaseEpoch: 4, workerId: 'worker-b', state: 'took_over' })
    }
    expect(() => createLeaseTakeoverCheckpoint({ ...takeoverArgs, now: '2026-11-04T15:59:00Z' })).toThrow('runtime_lease_not_expired')
  })
  it('未来 args.now 不得伪造 active lease 已到期', () => {
    vi.setSystemTime(new Date('2026-11-04T15:00:00Z'))
    expect(() => createLeaseTakeoverCheckpoint(takeoverArgs)).toThrow('runtime_takeover_clock_skew')
  })
  it('executed_not_done 终态不得通过新 lease 或 Worker 重新打开', () => {
    expect(() => createLeaseTakeoverCheckpoint({ ...takeoverArgs, previous: { ...previous, state: 'executed_not_done' } })).toThrow('runtime_checkpoint_terminal')
  })
  it('接管只认 canonical lease 到期时间，调用方伪造或缺失时间均拒绝', () => {
    for (const leaseExpiresAt of ['2026-11-04T15:00:00Z', '2026-11-04T17:00:00Z']) {
      expect(() => createLeaseTakeoverCheckpoint({ ...takeoverArgs, leaseExpiresAt })).toThrow('runtime_lease_expiry_mismatch')
    }
    expect(() => createLeaseTakeoverCheckpoint({ ...takeoverArgs, currentLease: { ...lease, expiresAt: undefined } })).toThrow('runtime_lease_expiry_invalid')
    expect(() => createLeaseTakeoverCheckpoint({ ...takeoverArgs, currentLease: { ...takeoverArgs.currentLease, expiresAt: 'not-a-date' } })).toThrow('runtime_lease_expiry_invalid')
  })
  it('Date.parse 可接受但 canonical UTC 解析器不接受的旧格式必须 fail-closed', () => {
    for (const now of ['2026-11-04 16:01:00 GMT', 'Wed, 04 Nov 2026 16:01:00 GMT']) {
      expect(Number.isFinite(Date.parse(now))).toBe(true)
      expect(() => createLeaseTakeoverCheckpoint({ ...takeoverArgs, now })).toThrow('runtime_takeover_now_invalid')
    }
  })
})
