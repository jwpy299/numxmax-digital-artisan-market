import { describe, expect, it, vi } from 'vitest'
import { scanRuntimeWatchdogSnapshots } from './runtimeWatchdogScanner'
import type { RuntimeLeaseContext } from './runtimeLeaseFence'

const lease: RuntimeLeaseContext = { status: 'active', tenantId: 'tenant-a', factoryId: 1, departmentId: 'dept-a', taskId: 11, leaseId: 'lease-1', leaseEpoch: 1, workerId: 'worker-a' }
const args = { now: '2026-11-04T16:10:00Z', heartbeatTimeoutMs: 1000 }

describe('只读 Watchdog 快照扫描', () => {
  it('健康快照不产生告警，超时与撤销只产生证据', () => {
    const emit = vi.fn()
    const snapshots = Object.freeze([
      Object.freeze({ lease, lastHeartbeatAt: '2026-11-04T16:09:59Z' }),
      Object.freeze({ lease: { ...lease, leaseId: 'lease-2' }, lastHeartbeatAt: '2026-11-04T16:09:00Z' }),
      Object.freeze({ lease: { ...lease, leaseId: 'lease-3', status: 'revoked' as const }, lastHeartbeatAt: '2026-11-04T16:09:59Z' }),
    ])
    expect(scanRuntimeWatchdogSnapshots({ snapshots, ...args, emit })).toBe(2)
    expect(emit).toHaveBeenCalledTimes(2)
    const evidence = emit.mock.calls.map((call) => call[0])
    expect(evidence.map((item) => item.classification)).toEqual(['stuck', 'lease_revoked'])
    expect(evidence.every((item) => item.readOnly && !item.mutatesCanonicalState && item.repairChannel === 'backend_state_machine')).toBe(true)
  })
  it('非法时间或超时有界校验失败', () => {
    expect(() => scanRuntimeWatchdogSnapshots({ snapshots: [], now: 'bad', heartbeatTimeoutMs: 1, emit: vi.fn() })).toThrow('runtime_watchdog_now_invalid')
    expect(() => scanRuntimeWatchdogSnapshots({ snapshots: [], now: args.now, heartbeatTimeoutMs: 0, emit: vi.fn() })).toThrow('runtime_watchdog_timeout_invalid')
  })
})
