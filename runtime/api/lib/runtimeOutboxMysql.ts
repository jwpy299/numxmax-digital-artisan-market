import { sql } from 'drizzle-orm'
import { affectedRowsOf } from './dbResult'
import { rawRows } from '../queries/rawRows'
import { isDupEntry } from './dupEntry'
import { getDb } from '../queries/connection'
import type { RuntimeEventEnvelope } from './runtimeEventContract'
import { parseDbUtc } from './dbUtc'

type Db = ReturnType<typeof getDb>
export function toRuntimeUtcIso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const timestamp = parseDbUtc(value)
  if (!Number.isFinite(timestamp)) throw new Error('runtime_store_expiry_invalid')
  return new Date(timestamp).toISOString()
}

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
  leaseId: string; leaseEpoch: number; workerId: string; expiresAt?: string
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) throw new Error(`runtime_store_${field}_invalid`)
  return value
}
function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`runtime_store_${field}_invalid`)
  return Number(value)
}

function runtimeLeaseStatus(value: unknown): MysqlRuntimeLease['status'] {
  const status = String(value)
  if (status !== 'active' && status !== 'revoked' && status !== 'closed') throw new Error('runtime_store_lease_status_invalid')
  return status
}

/** MySQL canonical 执行证据适配器；不提供 delivered/合同/钱包写入能力。 */
export class RuntimeOutboxMysqlStore {
  private readonly db: Db
  constructor(db: Db) { this.db = db }
  async claim(event: { dedupeKey: string; eventId: string; leaseId: string; leaseEpoch: number; tenantId?: string; factoryId?: number; departmentId?: string; taskId?: number; workerId?: string }): Promise<'claimed' | 'duplicate' | 'evidence_write_failed'> {
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
      return this.db.transaction(async (tx) => {
        // record() 先锁 claim 行；lease 生死/scope 与证据条件在同一 CAS 当前读校验，避免长持 lease X 锁。
        const existing = rawRows(await tx.execute(sql`
          SELECT c.id, c.dedupe_key AS dedupeKey, c.event_id AS eventId, c.lease_id AS leaseId, c.lease_epoch AS leaseEpoch, c.status,
                 l.tenant_id AS leaseTenantId, l.factory_id AS leaseFactoryId, l.department_id AS leaseDepartmentId,
                 l.task_id AS leaseTaskId, l.worker_id AS leaseWorkerId
          FROM st_runtime_outbox_claims c LEFT JOIN st_runtime_leases l ON l.lease_id=c.lease_id
          WHERE c.dedupe_key=${dedupeKey} OR c.event_id=${eventId} FOR UPDATE OF c`))
        if (existing.length !== 1) throw new Error('runtime_store_claim_conflict')
        const prior = existing[0]
        const same = String(prior.dedupeKey) === dedupeKey && String(prior.eventId) === eventId
          && String(prior.leaseId) === leaseId && Number(prior.leaseEpoch) === leaseEpoch
        if (String(prior.status) === 'evidence_write_failed') return 'evidence_write_failed'
        if (same) {
          const evidence = rawRows(await tx.execute(sql`SELECT id FROM st_runtime_execution_evidence WHERE dedupe_key=${String(prior.dedupeKey)} OR event_id=${String(prior.eventId)} LIMIT 1 FOR UPDATE`))
          // claim 先于 executor 落库；无证据既不能盲目重跑，也不能伪装成已完成的 duplicate。
          return evidence.length > 0 ? 'duplicate' : 'evidence_write_failed'
        }
        if (String(prior.status) !== 'claimed') throw new Error('runtime_store_claim_conflict')
        const evidence = rawRows(await tx.execute(sql`SELECT id FROM st_runtime_execution_evidence WHERE dedupe_key=${String(prior.dedupeKey)} OR event_id=${String(prior.eventId)} LIMIT 1 FOR UPDATE`))
        if (evidence.length > 0) return 'duplicate'
        const takeover = String(prior.leaseId) !== leaseId && Number(prior.leaseEpoch) < leaseEpoch
          && String(prior.leaseTenantId) === event.tenantId && Number(prior.leaseFactoryId) === event.factoryId
          && String(prior.leaseDepartmentId) === event.departmentId && Number(prior.leaseTaskId) === event.taskId
          && String(prior.leaseWorkerId) !== event.workerId
        if (!takeover) throw new Error('runtime_store_claim_conflict')
        const result = await tx.execute(sql`
          UPDATE st_runtime_outbox_claims c
          JOIN st_runtime_leases l ON l.lease_id=${String(prior.leaseId)}
          SET c.dedupe_key=${dedupeKey}, c.event_id=${eventId}, c.lease_id=${leaseId}, c.lease_epoch=${leaseEpoch}, c.status='claimed'
          WHERE c.id=${Number(prior.id)} AND c.lease_id=${String(prior.leaseId)}
            AND c.lease_epoch=${Number(prior.leaseEpoch)} AND c.status='claimed'
            AND l.lease_epoch=${Number(prior.leaseEpoch)}
            AND l.tenant_id=${String(prior.leaseTenantId)} AND l.factory_id=${Number(prior.leaseFactoryId)}
            AND l.department_id=${String(prior.leaseDepartmentId)} AND l.task_id=${Number(prior.leaseTaskId)}
            AND l.worker_id=${String(prior.leaseWorkerId)}
            AND (l.status='revoked' OR l.status='closed' OR (l.status='active' AND l.expires_at <= UTC_TIMESTAMP()))
            AND NOT EXISTS (
              SELECT 1 FROM st_runtime_execution_evidence e
              WHERE e.dedupe_key=${String(prior.dedupeKey)} OR e.event_id=${String(prior.eventId)}
            )`)
        if (affectedRowsOf(result) === 1) return 'claimed'
        const evidenceAfter = rawRows(await tx.execute(sql`SELECT id FROM st_runtime_execution_evidence WHERE dedupe_key=${String(prior.dedupeKey)} OR event_id=${String(prior.eventId)} LIMIT 1 FOR UPDATE`))
        if (evidenceAfter.length > 0) return 'duplicate'
        throw new Error('runtime_store_claim_conflict')
      })
    }
  }
  async markEvidenceWriteFailed(event: Readonly<RuntimeEventEnvelope>): Promise<void> {
    const result = await this.db.execute(sql`
      UPDATE st_runtime_outbox_claims SET status='evidence_write_failed'
      WHERE dedupe_key=${text(event.dedupeKey, 'dedupe_key')} AND event_id=${text(event.eventId, 'event_id')}
        AND lease_id=${text(event.leaseId, 'lease_id')} AND lease_epoch=${positive(event.leaseEpoch, 'lease_epoch')}`)
    if (affectedRowsOf(result) !== 1) throw new Error('runtime_store_recovery_mark_ack_invalid')
  }
  async record(evidence: MysqlRuntimeExecutionEvidence): Promise<void> {
    const eventId = text(evidence.eventId, 'event_id')
    const dedupeKey = text(evidence.dedupeKey, 'dedupe_key')
    const leaseId = text(evidence.leaseId, 'lease_id')
    const leaseEpoch = positive(evidence.leaseEpoch, 'lease_epoch')
    if (!['executed_not_done', 'outcome_unknown', 'execution_failed'].includes(evidence.status)) throw new Error('runtime_store_status_invalid')
    if (evidence.delivered !== false || evidence.untrustedContent !== true) throw new Error('runtime_store_delivery_boundary_invalid')
    if (evidence.evidenceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(evidence.evidenceSha256)) throw new Error('runtime_store_evidence_invalid')
    if (evidence.summary !== undefined && evidence.summary.length > 2_000) throw new Error('runtime_store_summary_invalid')
    await this.db.transaction(async (tx) => {
      const claim = rawRows(await tx.execute(sql`SELECT id FROM st_runtime_outbox_claims WHERE event_id=${eventId} AND dedupe_key=${dedupeKey} AND lease_id=${leaseId} AND lease_epoch=${leaseEpoch} LIMIT 1 FOR UPDATE`))[0]
      if (!claim) throw new Error('runtime_store_evidence_claim_mismatch')
      const existing = rawRows(await tx.execute(sql`SELECT event_id AS eventId, dedupe_key AS dedupeKey, lease_id AS leaseId, lease_epoch AS leaseEpoch FROM st_runtime_execution_evidence WHERE event_id=${eventId} OR dedupe_key=${dedupeKey} LIMIT 1 FOR UPDATE`))[0]
      if (existing) {
        if (String(existing.eventId) !== eventId || String(existing.dedupeKey) !== dedupeKey || String(existing.leaseId) !== leaseId || Number(existing.leaseEpoch) !== leaseEpoch) throw new Error('runtime_store_evidence_scope_mismatch')
        // 首条证据为 canonical；丢 ACK 后的重试不得再写一条互相矛盾的证据。
        return
      }
      const result = await tx.execute(sql`
        INSERT INTO st_runtime_execution_evidence
          (event_id, dedupe_key, lease_id, lease_epoch, status, delivered,
           evidence_sha256, summary, failure_code, untrusted_content)
        VALUES
          (${eventId}, ${dedupeKey}, ${leaseId}, ${leaseEpoch},
           ${evidence.status}, 0, ${evidence.evidenceSha256 ?? null}, ${evidence.summary ?? null},
           ${evidence.failureCode ?? null}, 1)`)
      if (affectedRowsOf(result) !== 1) throw new Error('runtime_store_evidence_ack_invalid')
    })
  }
}

export async function readRuntimeLease(db: Db, leaseId: string): Promise<MysqlRuntimeLease | null> {
  text(leaseId, 'lease_id')
  const row = rawRows(await db.execute(sql`
    SELECT tenant_id AS tenantId, factory_id AS factoryId, department_id AS departmentId,
           task_id AS taskId, lease_id AS leaseId, lease_epoch AS leaseEpoch,
           worker_id AS workerId, status, expires_at AS expiresAt
    FROM st_runtime_leases WHERE lease_id=${leaseId} LIMIT 1`))[0]
  if (!row) return null
  return {
    tenantId: String(row.tenantId), factoryId: Number(row.factoryId), departmentId: String(row.departmentId),
    taskId: Number(row.taskId), leaseId: String(row.leaseId), leaseEpoch: Number(row.leaseEpoch),
    workerId: String(row.workerId), status: runtimeLeaseStatus(row.status),
    expiresAt: toRuntimeUtcIso(row.expiresAt),
  }
}
