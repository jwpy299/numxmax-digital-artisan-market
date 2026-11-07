import { sql } from 'drizzle-orm'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { scanRuntimeWatchdogSnapshots, type RuntimeWatchdogLeaseSnapshot } from './runtimeWatchdogScanner'
import { toRuntimeUtcIso } from './runtimeOutboxMysql'
import type { ReadOnlyWatchdogEvidence } from './runtimeEventContract'
import type { RuntimeLeaseContext } from './runtimeLeaseFence'

type Db = ReturnType<typeof getDb>
function tenant(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) throw new Error('runtime_watchdog_tenant_invalid')
  return value
}

function leaseStatus(value: unknown): RuntimeLeaseContext['status'] {
  const status = String(value)
  if (status !== 'active' && status !== 'revoked' && status !== 'closed') throw new Error('runtime_watchdog_lease_status_invalid')
  return status
}

/** 只读 lease 快照；不涉及 claim、合同、资金、暂停或状态迁移。 */
export async function readRuntimeWatchdogSnapshots(db: Db, tenantId: string, afterLeaseId = '', limit = 500): Promise<RuntimeWatchdogLeaseSnapshot[]> {
  const scoped = tenant(tenantId)
  if (typeof afterLeaseId !== 'string' || afterLeaseId.length > 128) throw new Error('runtime_watchdog_cursor_invalid')
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) throw new Error('runtime_watchdog_limit_invalid')
  return rawRows(await db.execute(sql`
    SELECT tenant_id AS tenantId, factory_id AS factoryId, department_id AS departmentId,
           task_id AS taskId, lease_id AS leaseId, lease_epoch AS leaseEpoch,
           worker_id AS workerId, status,
           COALESCE(last_heartbeat_at, created_at) AS lastHeartbeatAt
    FROM st_runtime_leases WHERE tenant_id=${scoped} AND lease_id>${afterLeaseId}
    ORDER BY lease_id ASC LIMIT ${limit}`)).map((row) => ({
    lease: {
      tenantId: String(row.tenantId), factoryId: Number(row.factoryId), departmentId: String(row.departmentId),
      taskId: Number(row.taskId), leaseId: String(row.leaseId), leaseEpoch: Number(row.leaseEpoch),
      workerId: String(row.workerId), status: leaseStatus(row.status),
    },
    lastHeartbeatAt: toRuntimeUtcIso(row.lastHeartbeatAt)!,
  }))
}

export async function runRuntimeWatchdogMysqlOnce(args: {
  db: Db
  tenantId: string
  now: string
  heartbeatTimeoutMs: number
  batchSize?: number
}): Promise<ReadOnlyWatchdogEvidence[]> {
  const evidence: ReadOnlyWatchdogEvidence[] = []
  let afterLeaseId = ''
  const batchSize = args.batchSize ?? 500
  for (;;) {
    const snapshots = await readRuntimeWatchdogSnapshots(args.db, args.tenantId, afterLeaseId, batchSize)
    if (snapshots.length === 0) break
    scanRuntimeWatchdogSnapshots({ snapshots, now: args.now, heartbeatTimeoutMs: args.heartbeatTimeoutMs, emit: (item) => evidence.push(item) })
    if (snapshots.length < batchSize) break
    afterLeaseId = snapshots[snapshots.length - 1].lease.leaseId
  }
  return evidence
}
