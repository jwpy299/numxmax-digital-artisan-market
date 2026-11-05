import { sql } from 'drizzle-orm'
import { affectedRowsOf } from './dbResult'
import { rawRows } from '../queries/rawRows'
import { isDupEntry } from './dupEntry'
import { getDb } from '../queries/connection'

type Db = ReturnType<typeof getDb>
export interface MysqlRuntimeExecutionEvidence {
  eventId: string; dedupeKey: string; leaseId: string; leaseEpoch: number
  status: 'executed_not_done' | 'outcome_unknown' | 'execution_failed'
  delivered: false
  evidenceSha256?: string; summary?: string; failureCode?: string
  untrustedContent: true
}
export interface MysqlRuntimeLease {
  status: 'active' | 'revoked' | 'closed'
  tenantId: string; factoryId: number; departmentId: string; taskId: number
  leaseId: string; leaseEpoch: number; workerId: string
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) throw new Error(`runtime_store_${field}_invalid`)
  return value
}
function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`runtime_store_${field}_invalid`)
  return Number(value)
}

/** MySQL canonical 执行证据适配器；不提供 delivered/合同/钱包写入能力。 */
export class RuntimeOutboxMysqlStore {
  private readonly db: Db
  constructor(db: Db) { this.db = db }
  async claim(event: { dedupeKey: string; eventId: string; leaseId: string; leaseEpoch: number }): Promise<'claimed' | 'duplicate'> {
    const dedupeKey = text(event.dedupeKey, 'dedupe_key')
    const eventId = text(event.eventId, 'event_id')
    const leaseId = text(event.leaseId, 'lease_id')
    const leaseEpoch = positive(event.leaseEpoch, 'lease_epoch')
    try {
      const result = await this.db.execute(sql`
        INSERT INTO st_runtime_outbox_claims (dedupe_key, event_id, lease_id, lease_epoch)
        VALUES (${dedupeKey}, ${eventId}, ${leaseId}, ${leaseEpoch})`)
      if (affectedRowsOf(result) !== 1) throw new Error('runtime_store_claim_ack_invalid')
      return 'claimed'
    } catch (error) {
      if (!isDupEntry(error)) throw error
      const existing = rawRows(await this.db.execute(sql`
        SELECT dedupe_key AS dedupeKey, event_id AS eventId, lease_id AS leaseId, lease_epoch AS leaseEpoch
        FROM st_runtime_outbox_claims WHERE dedupe_key=${dedupeKey} OR event_id=${eventId}`))
      const same = existing.length === 1 && String(existing[0].dedupeKey) === dedupeKey
        && String(existing[0].eventId) === eventId && String(existing[0].leaseId) === leaseId
        && Number(existing[0].leaseEpoch) === leaseEpoch
      if (same) return 'duplicate'
      throw new Error('runtime_store_claim_conflict')
    }
  }
  async record(evidence: MysqlRuntimeExecutionEvidence): Promise<void> {
    text(evidence.eventId, 'event_id'); text(evidence.dedupeKey, 'dedupe_key'); text(evidence.leaseId, 'lease_id')
    positive(evidence.leaseEpoch, 'lease_epoch')
    if (!['executed_not_done', 'outcome_unknown', 'execution_failed'].includes(evidence.status)) throw new Error('runtime_store_status_invalid')
    if (evidence.delivered !== false || evidence.untrustedContent !== true) throw new Error('runtime_store_delivery_boundary_invalid')
    if (evidence.evidenceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(evidence.evidenceSha256)) throw new Error('runtime_store_evidence_invalid')
    if (evidence.summary !== undefined && evidence.summary.length > 2_000) throw new Error('runtime_store_summary_invalid')
    await this.db.execute(sql`
      INSERT INTO st_runtime_execution_evidence
        (event_id, dedupe_key, lease_id, lease_epoch, status, delivered,
         evidence_sha256, summary, failure_code, untrusted_content)
      VALUES
        (${evidence.eventId}, ${evidence.dedupeKey}, ${evidence.leaseId}, ${evidence.leaseEpoch},
         ${evidence.status}, 0, ${evidence.evidenceSha256 ?? null}, ${evidence.summary ?? null},
         ${evidence.failureCode ?? null}, 1)`)
  }
}

export async function readRuntimeLease(db: Db, leaseId: string): Promise<MysqlRuntimeLease | null> {
  text(leaseId, 'lease_id')
  const row = rawRows(await db.execute(sql`
    SELECT tenant_id AS tenantId, factory_id AS factoryId, department_id AS departmentId,
           task_id AS taskId, lease_id AS leaseId, lease_epoch AS leaseEpoch,
           worker_id AS workerId, status
    FROM st_runtime_leases WHERE lease_id=${leaseId} LIMIT 1`))[0]
  if (!row) return null
  return {
    tenantId: String(row.tenantId), factoryId: Number(row.factoryId), departmentId: String(row.departmentId),
    taskId: Number(row.taskId), leaseId: String(row.leaseId), leaseEpoch: Number(row.leaseEpoch),
    workerId: String(row.workerId), status: String(row.status) as MysqlRuntimeLease['status'],
  }
}
