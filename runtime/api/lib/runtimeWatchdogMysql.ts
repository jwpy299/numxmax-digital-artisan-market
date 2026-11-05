import { sql } from 'drizzle-orm'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { scanRuntimeWatchdogSnapshots, type RuntimeWatchdogLeaseSnapshot } from './runtimeWatchdogScanner'
import type { ReadOnlyWatchdogEvidence } from './runtimeEventContract'
import type { RuntimeLeaseContext } from './runtimeLeaseFence'

type Db = ReturnType<typeof getDb>
function tenant(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) throw new Error('runtime_watchdog_tenant_invalid')
  return value
}

/** 只读 lease 快照；不涉及 claim、合同、资金、暂停或状态迁移。 */
export async function readRuntimeWatchdogSnapshots(db: Db, tenantId: string): Promise<RuntimeWatchdogLeaseSnapshot[]> {
  const scoped = tenant(tenantId)
  return rawRows(await db.execute(sql`
    SELECT tenant_id AS tenantId, factory_id AS factoryId, department_id AS departmentId,
           task_id AS taskId, lease_id AS leaseId, lease_epoch AS leaseEpoch,
           worker_id AS workerId, status,
           COALESCE(last_heartbeat_at, created_at) AS lastHeartbeatAt
    FROM st_runtime_leases WHERE tenant_id=${scoped} ORDER BY lease_id ASC`)).map((row) => ({
    lease: {
      tenantId: String(row.tenantId), factoryId: Number(row.factoryId), departmentId: String(row.departmentId),
      taskId: Number(row.taskId), leaseId: String(row.leaseId), leaseEpoch: Number(row.leaseEpoch),
      workerId: String(row.workerId), status: String(row.status) as RuntimeLeaseContext['status'],
    },
    lastHeartbeatAt: row.lastHeartbeatAt instanceof Date ? row.lastHeartbeatAt.toISOString() : String(row.lastHeartbeatAt),
  }))
}

export async function runRuntimeWatchdogMysqlOnce(args: {
  db: Db
  tenantId: string
  now: string
  heartbeatTimeoutMs: number
}): Promise<ReadOnlyWatchdogEvidence[]> {
  const snapshots = await readRuntimeWatchdogSnapshots(args.db, args.tenantId)
  const evidence: ReadOnlyWatchdogEvidence[] = []
  scanRuntimeWatchdogSnapshots({ snapshots, now: args.now, heartbeatTimeoutMs: args.heartbeatTimeoutMs, emit: (item) => evidence.push(item) })
  return evidence
}
