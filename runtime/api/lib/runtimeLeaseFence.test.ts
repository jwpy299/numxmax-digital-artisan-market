import { describe, expect, it, vi } from 'vitest'
import { assertRuntimeEventDelivery, RuntimeLeaseFenceError, type RuntimeEventMandate, type RuntimeLeaseContext } from './runtimeLeaseFence'

const mandate: RuntimeEventMandate = {
  eventId: 'evt-1', tenantId: 'tenant-a', factoryId: 7, departmentId: 'dept-a',
  taskId: 11, leaseId: 'lease-1', leaseEpoch: 3, workerId: 'worker-a',
}
const lease: RuntimeLeaseContext = { status: 'active', ...mandate, expiresAt: '2999-01-01T00:00:00Z' }
function errorOf(fn: () => void): string {
  try { fn(); return '' } catch (error) { return error instanceof RuntimeLeaseFenceError ? error.code : 'unexpected' }
}

describe('runtime event lease fence', () => {
  it('接受同租户、同部门、同 Worker、同 epoch 的有效投递', () => {
    expect(() => assertRuntimeEventDelivery(mandate, lease)).not.toThrow()
  })
  it('撤销或关闭租约不得执行', () => {
    for (const status of ['revoked', 'closed'] as const) {
      expect(errorOf(() => assertRuntimeEventDelivery(mandate, { ...lease, status }))).toBe('runtime_lease_not_active')
    }
  })
  it('缺失到期时间必须 fail-closed', () => {
    expect(errorOf(() => assertRuntimeEventDelivery(mandate, { ...lease, expiresAt: undefined }))).toBe('runtime_lease_expiry_invalid')
  })
  it('到期与非法时间 lease 不得执行，未到期 lease 可执行', () => {
    expect(errorOf(() => assertRuntimeEventDelivery(mandate, { ...lease, expiresAt: '2000-01-01T00:00:00Z' }))).toBe('runtime_lease_expired')
    expect(errorOf(() => assertRuntimeEventDelivery(mandate, { ...lease, expiresAt: 'not-a-date' }))).toBe('runtime_lease_expiry_invalid')
    expect(() => assertRuntimeEventDelivery(mandate, { ...lease, expiresAt: '2999-01-01T00:00:00Z' })).not.toThrow()
  })
  it('MySQL 无时区 wall-clock 始终按 UTC 判定，不受进程 TZ 影响', () => {
    const previousTz = process.env.TZ
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 4, 16, 0, 0))
    process.env.TZ = 'America/New_York'
    try {
      expect(errorOf(() => assertRuntimeEventDelivery(mandate, { ...lease, expiresAt: '2026-11-04 16:00:00' }))).toBe('runtime_lease_expired')
      expect(errorOf(() => assertRuntimeEventDelivery(mandate, { ...lease, expiresAt: '2026-11-04 16:00:01' }))).toBe('')
    } finally {
      if (previousTz === undefined) delete process.env.TZ
      else process.env.TZ = previousTz
      vi.restoreAllMocks()
    }
  })
  it('旧 epoch 与未来 epoch 都 fail-closed', () => {
    expect(errorOf(() => assertRuntimeEventDelivery({ ...mandate, leaseEpoch: 2 }, lease))).toBe('runtime_lease_stale')
    expect(errorOf(() => assertRuntimeEventDelivery({ ...mandate, leaseEpoch: 4 }, lease))).toBe('runtime_lease_epoch_conflict')
  })
  it('换部门、换租户、换 Worker 或换任务均拒绝', () => {
    for (const next of [
      { ...lease, departmentId: 'dept-b' }, { ...lease, tenantId: 'tenant-b' },
      { ...lease, workerId: 'worker-b' }, { ...lease, taskId: 12 }, { ...lease, factoryId: 8 },
    ]) expect(errorOf(() => assertRuntimeEventDelivery(mandate, next))).toBe('runtime_lease_scope_mismatch')
  })
  it('非法 epoch、空标识和非正整数 ID 不得进入执行面', () => {
    for (const leaseEpoch of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(errorOf(() => assertRuntimeEventDelivery({ ...mandate, leaseEpoch }, lease))).toBe('runtime_lease_epoch_invalid')
    }
    expect(errorOf(() => assertRuntimeEventDelivery({ ...mandate, eventId: '' }, lease))).toBe('runtime_mandate_event_id_invalid')
    expect(errorOf(() => assertRuntimeEventDelivery({ ...mandate, taskId: 0 }, lease))).toBe('runtime_mandate_task_id_invalid')
  })
})
