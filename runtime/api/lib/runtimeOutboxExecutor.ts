import { parseRuntimeEventEnvelope, type RuntimeEventEnvelope } from './runtimeEventContract'
import { assertRuntimeEventDelivery, RuntimeLeaseFenceError, type RuntimeLeaseContext } from './runtimeLeaseFence'

export type RuntimeExecutionStatus = 'executed_not_done' | 'outcome_unknown' | 'execution_failed'
export type RuntimeOutboxClaim = 'claimed' | 'duplicate' | 'evidence_write_failed'
export interface RuntimeExecutorResult { evidenceSha256: string; summary: string }
export interface RuntimeExecutionEvidence {
  eventId: string
  dedupeKey: string
  leaseId: string
  leaseEpoch: number
  status: RuntimeExecutionStatus
  delivered: false
  evidenceSha256?: string
  summary?: string
  failureCode?: string
  untrustedContent: true
}
export interface RuntimeOutboxEvidenceStore {
  /** 必须原子实现；重复键只允许一个执行权。数据库适配器由后端另行实现。 */
  claim(event: Readonly<RuntimeEventEnvelope>): Promise<RuntimeOutboxClaim>
  record(evidence: RuntimeExecutionEvidence): Promise<void>
  /** 原始证据与最小未知证据都写不进时，给 claim 留恢复标记；不得借此自动重跑执行器。 */
  markEvidenceWriteFailed?(event: Readonly<RuntimeEventEnvelope>): Promise<void>
}

function failure(event: RuntimeEventEnvelope, status: RuntimeExecutionStatus, failureCode: string): RuntimeExecutionEvidence {
  return { eventId: event.eventId, dedupeKey: event.dedupeKey, leaseId: event.leaseId, leaseEpoch: event.leaseEpoch,
    status, delivered: false, failureCode, untrustedContent: true }
}

async function recordEvidence(event: RuntimeEventEnvelope, store: RuntimeOutboxEvidenceStore, evidence: RuntimeExecutionEvidence): Promise<RuntimeExecutionEvidence> {
  try {
    await store.record(evidence)
    return evidence
  } catch {
    const unknown: RuntimeExecutionEvidence = {
      ...failure(event, 'outcome_unknown', 'evidence_write_failed'),
      evidenceSha256: evidence.evidenceSha256,
      summary: evidence.summary,
    }
    // 最小未知证据仍可落库时，调用方与后续审计都能区分“执行过但原始证据缺失”。
    try { await store.record(unknown); return unknown } catch { /* 继续给 claim 留恢复标记 */ }
    if (store.markEvidenceWriteFailed) {
      try { await store.markEvidenceWriteFailed(event) } catch { /* 数据库不可用时仍返回显式未知，不伪装已恢复 */ }
    }
    return unknown
  }
}

/** 只连接事件校验、lease fence 与执行证据；不写合同、钱包、资格或 delivered。 */
export async function executeRuntimeOutboxEvent(
  value: unknown,
  readLease: () => Promise<RuntimeLeaseContext>,
  store: RuntimeOutboxEvidenceStore,
  executor: (event: Readonly<RuntimeEventEnvelope>) => Promise<RuntimeExecutorResult>,
  authorize: (event: Readonly<RuntimeEventEnvelope>) => void | Promise<void>,
): Promise<RuntimeExecutionEvidence | { status: 'duplicate'; delivered: false }> {
  const event = parseRuntimeEventEnvelope(value)
  if (typeof authorize !== 'function') throw new RuntimeLeaseFenceError('runtime_authorizer_required')
  await authorize(event)
  assertRuntimeEventDelivery(event, await readLease())
  const claim = await store.claim(event)
  if (claim === 'duplicate') return { status: 'duplicate', delivered: false }
  if (claim === 'evidence_write_failed') return failure(event, 'outcome_unknown', 'evidence_write_failed')
  if (claim !== 'claimed') throw new RuntimeLeaseFenceError('runtime_store_claim_invalid')

  let executed: RuntimeExecutorResult
  try { executed = await executor(event) }
  catch {
    return recordEvidence(event, store, failure(event, 'execution_failed', 'executor_error'))
  }
  if (!executed || typeof executed !== 'object') return recordEvidence(event, store, failure(event, 'execution_failed', 'executor_evidence_invalid'))
  if (!/^[a-f0-9]{64}$/.test(executed.evidenceSha256) || typeof executed.summary !== 'string' || executed.summary.length > 2_000) {
    return recordEvidence(event, store, failure(event, 'execution_failed', 'executor_evidence_invalid'))
  }

  let postLeaseError: unknown = null
  try { assertRuntimeEventDelivery(event, await readLease()) } catch (error) { postLeaseError = error }
  const evidence: RuntimeExecutionEvidence = {
    eventId: event.eventId, dedupeKey: event.dedupeKey, leaseId: event.leaseId, leaseEpoch: event.leaseEpoch,
    status: postLeaseError ? 'outcome_unknown' : 'executed_not_done', delivered: false,
    evidenceSha256: executed.evidenceSha256, summary: executed.summary,
    failureCode: postLeaseError instanceof RuntimeLeaseFenceError ? postLeaseError.code : postLeaseError ? 'runtime_lease_recheck_failed' : undefined,
    untrustedContent: true,
  }
  return recordEvidence(event, store, evidence)
}
