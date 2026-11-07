import { assertRuntimeEventDelivery, assertRuntimeMandateShape, RuntimeLeaseFenceError, type RuntimeEventMandate, type RuntimeLeaseContext } from './runtimeLeaseFence'
import { parseDbUtc } from './dbUtc'

export interface RuntimeCheckpoint extends RuntimeEventMandate {
  checkpointSeq: number
  state: 'started' | 'progress' | 'executed_not_done' | 'took_over'
  evidenceSha256?: string
}

function seq(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new RuntimeLeaseFenceError('runtime_checkpoint_seq_invalid')
  return Number(value)
}
function requiredText(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) throw new RuntimeLeaseFenceError(code)
  return value
}
function time(value: unknown, code: string): number {
  if (typeof value !== 'string') throw new RuntimeLeaseFenceError(code)
  const parsed = parseDbUtc(value)
  if (!Number.isFinite(parsed)) throw new RuntimeLeaseFenceError(code)
  return parsed
}
function shape(checkpoint: RuntimeCheckpoint): void {
  assertRuntimeMandateShape(checkpoint)
  seq(checkpoint.checkpointSeq)
  if (!['started', 'progress', 'executed_not_done', 'took_over'].includes(checkpoint.state)) throw new RuntimeLeaseFenceError('runtime_checkpoint_state_invalid')
  if (checkpoint.evidenceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(checkpoint.evidenceSha256)) throw new RuntimeLeaseFenceError('runtime_checkpoint_evidence_invalid')
}

/** 正常推进只能在同一 lease/epoch/Worker 内按序号 +1，禁止旧 Worker 或历史 checkpoint 回写。 */
export function assertNextRuntimeCheckpoint(previous: RuntimeCheckpoint, next: RuntimeCheckpoint, lease: RuntimeLeaseContext): void {
  shape(previous); shape(next)
  assertRuntimeEventDelivery(previous, lease)
  assertRuntimeEventDelivery(next, lease)
  const sameIdentity = previous.eventId === next.eventId
    && previous.tenantId === next.tenantId && previous.factoryId === next.factoryId
    && previous.departmentId === next.departmentId && previous.taskId === next.taskId
    && previous.leaseId === next.leaseId && previous.leaseEpoch === next.leaseEpoch
    && previous.workerId === next.workerId
  if (!sameIdentity) throw new RuntimeLeaseFenceError('runtime_checkpoint_identity_mismatch')
  if (next.state === 'took_over') throw new RuntimeLeaseFenceError('runtime_checkpoint_takeover_requires_lease_change')
  const allowedTransitions: Record<RuntimeCheckpoint['state'], readonly RuntimeCheckpoint['state'][]> = {
    started: ['progress'],
    progress: ['progress', 'executed_not_done'],
    took_over: ['progress', 'executed_not_done'],
    executed_not_done: [],
  }
  if (!allowedTransitions[previous.state].includes(next.state)) throw new RuntimeLeaseFenceError('runtime_checkpoint_state_transition_invalid')
  if (seq(next.checkpointSeq) !== seq(previous.checkpointSeq) + 1) throw new RuntimeLeaseFenceError('runtime_checkpoint_sequence_conflict')
}

/** 只制定接管 checkpoint；真实 lease 发放与落库仍由后端事务完成。 */
export function createLeaseTakeoverCheckpoint(args: {
  currentLease: RuntimeLeaseContext
  previous: RuntimeCheckpoint
  nextLeaseId: string
  nextWorkerId: string
  nextEventId: string
  leaseExpiresAt: string
  now: string
}): Readonly<RuntimeCheckpoint> {
  const { currentLease, previous } = args
  shape(previous)
  if (previous.state === 'executed_not_done') throw new RuntimeLeaseFenceError('runtime_checkpoint_terminal')
  if (currentLease.status !== 'active' && currentLease.status !== 'revoked' && currentLease.status !== 'closed') throw new RuntimeLeaseFenceError('runtime_lease_not_active')
  // 到期事实只能来自当前 canonical lease；调用方时间仅作交叉校验，不能伪造接管条件。
  const expiresAt = time(currentLease.expiresAt, 'runtime_lease_expiry_invalid')
  const claimedExpiresAt = time(args.leaseExpiresAt, 'runtime_lease_expiry_invalid')
  if (claimedExpiresAt !== expiresAt) throw new RuntimeLeaseFenceError('runtime_lease_expiry_mismatch')
  const callerNow = time(args.now, 'runtime_takeover_now_invalid')
  if (Math.abs(Date.now() - callerNow) > 300_000) throw new RuntimeLeaseFenceError('runtime_takeover_clock_skew')
  const now = Date.now()
  if (currentLease.status === 'active' && now < expiresAt) throw new RuntimeLeaseFenceError('runtime_lease_not_expired')
  const sameScope = previous.tenantId === currentLease.tenantId && previous.factoryId === currentLease.factoryId
    && previous.departmentId === currentLease.departmentId && previous.taskId === currentLease.taskId
    && previous.leaseId === currentLease.leaseId && previous.workerId === currentLease.workerId
  if (!sameScope) throw new RuntimeLeaseFenceError('runtime_lease_scope_mismatch')
  if (previous.leaseEpoch !== currentLease.leaseEpoch) throw new RuntimeLeaseFenceError('runtime_lease_epoch_conflict')
  const nextEpoch = currentLease.leaseEpoch + 1
  if (!Number.isSafeInteger(nextEpoch)) throw new RuntimeLeaseFenceError('runtime_lease_epoch_invalid')
  const next: RuntimeCheckpoint = {
    eventId: requiredText(args.nextEventId, 'runtime_mandate_event_id_invalid'),
    tenantId: previous.tenantId, factoryId: previous.factoryId, departmentId: previous.departmentId,
    taskId: previous.taskId,
    leaseId: requiredText(args.nextLeaseId, 'runtime_mandate_lease_id_invalid'),
    leaseEpoch: nextEpoch,
    workerId: requiredText(args.nextWorkerId, 'runtime_mandate_worker_id_invalid'),
    checkpointSeq: previous.checkpointSeq + 1,
    state: 'took_over',
    evidenceSha256: previous.evidenceSha256,
  }
  if (next.leaseId === previous.leaseId || next.workerId === previous.workerId) throw new RuntimeLeaseFenceError('runtime_takeover_identity_required')
  shape(next)
  return Object.freeze(next)
}
