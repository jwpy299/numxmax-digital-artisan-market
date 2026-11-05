import { createReadOnlyWatchdogEvidence, type ReadOnlyWatchdogEvidence } from './runtimeEventContract'
import type { RuntimeLeaseContext } from './runtimeLeaseFence'

export interface RuntimeWatchdogLeaseSnapshot {
  lease: RuntimeLeaseContext
  lastHeartbeatAt: string
}

/** 只读快照扫描：无 lease/store 写入参数，不能暂停、退款、改合同或成为第二调度器。 */
export function scanRuntimeWatchdogSnapshots(args: {
  snapshots: readonly RuntimeWatchdogLeaseSnapshot[]
  now: string
  heartbeatTimeoutMs: number
  emit: (evidence: ReadOnlyWatchdogEvidence) => void
}): number {
  const now = Date.parse(args.now)
  if (!Number.isFinite(now)) throw new Error('runtime_watchdog_now_invalid')
  if (!Number.isSafeInteger(args.heartbeatTimeoutMs) || args.heartbeatTimeoutMs <= 0 || args.heartbeatTimeoutMs > 86_400_000) throw new Error('runtime_watchdog_timeout_invalid')
  let emitted = 0
  for (const snapshot of args.snapshots) {
    const heartbeat = Date.parse(snapshot.lastHeartbeatAt)
    if (!Number.isFinite(heartbeat)) throw new Error('runtime_watchdog_heartbeat_invalid')
    const classification = snapshot.lease.status === 'revoked' ? 'lease_revoked' : now - heartbeat > args.heartbeatTimeoutMs ? 'stuck' : null
    if (!classification) continue
    args.emit(createReadOnlyWatchdogEvidence({
      eventId: `watchdog-${snapshot.lease.leaseId}-${snapshot.lease.leaseEpoch}`,
      tenantId: snapshot.lease.tenantId, factoryId: snapshot.lease.factoryId,
      departmentId: snapshot.lease.departmentId, taskId: snapshot.lease.taskId,
      leaseId: snapshot.lease.leaseId, leaseEpoch: snapshot.lease.leaseEpoch, workerId: snapshot.lease.workerId,
    }, classification, `lease ${classification}; heartbeat=${snapshot.lastHeartbeatAt}`, args.now))
    emitted += 1
  }
  return emitted
}
