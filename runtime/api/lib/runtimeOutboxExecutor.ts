import { parseRuntimeEventEnvelope, type RuntimeEventEnvelope } from './runtimeEventContract'
import { assertRuntimeEventDelivery, RuntimeLeaseFenceError, type RuntimeLeaseContext } from './runtimeLeaseFence'

export type RuntimeExecutionStatus = 'executed_not_done' | 'outcome_unknown' | 'execution_failed'
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
  claim(event: Readonly<RuntimeEventEnvelope>): Promise<'claimed' | 'duplicate'>
  record(evidence: RuntimeExecutionEvidence): Promise<void>
}

function failure(event: RuntimeEventEnvelope, status: RuntimeExecutionStatus, failureCode: string): RuntimeExecutionEvidence {
  return { eventId: event.eventId, dedupeKey: event.dedupeKey, leaseId: event.leaseId, leaseEpoch: event.leaseEpoch,
    status, delivered: false, failureCode, untrustedContent: true }
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
  if (await store.claim(event) === 'duplicate') return { status: 'duplicate', delivered: false }

  let executed: RuntimeExecutorResult
  try { executed = await executor(event) }
  catch {
    const evidence = failure(event, 'execution_failed', 'executor_error')
    await store.record(evidence)
    return evidence
  }
  if (!/^[a-f0-9]{64}$/.test(executed.evidenceSha256) || typeof executed.summary !== 'string' || executed.summary.length > 2_000) {
    const evidence = failure(event, 'execution_failed', 'executor_evidence_invalid')
    await store.record(evidence)
    return evidence
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
  await store.record(evidence)
  return evidence
}
