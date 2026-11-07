import { describe, expect, it } from 'vitest'
import { parseRuntimeEventEnvelope, createReadOnlyWatchdogEvidence } from './runtimeEventContract'
import type { RuntimeEventMandate } from './runtimeLeaseFence'

const scope: RuntimeEventMandate = {
  eventId: 'evt-1', tenantId: 'tenant-a', factoryId: 7, departmentId: 'dept-a',
  taskId: 11, leaseId: 'lease-1', leaseEpoch: 3, workerId: 'worker-a',
}
const envelope = {
  ...scope, source: 'router', type: 'task.dispatch', payloadSha256: 'a'.repeat(64),
  createdAt: '2026-11-04T16:00:00.000Z', dedupeKey: 'dedupe-1',
}

describe('runtime event contract 与只读 Watchdog', () => {
  it('校验事件包并规范时间，不透传额外资金指令', () => {
    const parsed = parseRuntimeEventEnvelope({ ...envelope, refund: true, createdAt: '2026-11-04T16:00:00Z' })
    expect(parsed.createdAt).toBe('2026-11-04T16:00:00.000Z')
    expect('refund' in parsed).toBe(false)
    expect(Object.isFrozen(parsed)).toBe(true)
  })
  it('无时区 MySQL 文本时间按 UTC 归一，不受进程时区影响', () => {
    expect(parseRuntimeEventEnvelope({ ...envelope, createdAt: '2026-11-04 16:00:00' }).createdAt).toBe('2026-11-04T16:00:00.000Z')
    expect(createReadOnlyWatchdogEvidence(scope, 'stuck', 'timeout', '2026-11-04 16:01:00').observedAt).toBe('2026-11-04T16:01:00.000Z')
  })
  it('坏证据哈希和非法 scope  fail-closed', () => {
    expect(() => parseRuntimeEventEnvelope({ ...envelope, payloadSha256: 'bad' })).toThrow('runtime_event_payload_sha256_invalid')
    expect(() => parseRuntimeEventEnvelope({ ...envelope, leaseEpoch: 0 })).toThrow('runtime_lease_epoch_invalid')
  })
  it('Watchdog 证据显式只读，修复只能回后端状态机', () => {
    const evidence = createReadOnlyWatchdogEvidence(scope, 'stuck', 'worker heartbeat timeout', '2026-11-04T16:01:00Z')
    expect(evidence).toMatchObject({ readOnly: true, mutatesCanonicalState: false, repairChannel: 'backend_state_machine', untrustedContent: true })
    expect(Object.isFrozen(evidence)).toBe(true)
    expect(Object.isFrozen(evidence.scope)).toBe(true)
  })
  it('未知故障分类不得形成修复证据', () => {
    expect(() => createReadOnlyWatchdogEvidence(scope, 'refund_now' as never, 'bad', '2026-11-04T16:01:00Z')).toThrow('runtime_watchdog_classification_invalid')
  })
})
