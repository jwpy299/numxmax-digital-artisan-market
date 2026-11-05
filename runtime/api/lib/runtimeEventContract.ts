import { assertRuntimeMandateShape, RuntimeLeaseFenceError, type RuntimeEventMandate } from './runtimeLeaseFence'

export interface RuntimeEventEnvelope extends RuntimeEventMandate {
  source: string
  type: string
  payloadSha256: string
  createdAt: string
  dedupeKey: string
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeLeaseFenceError('runtime_event_envelope_invalid')
  return value as Record<string, unknown>
}
function text(value: unknown, field: string, max = 128): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new RuntimeLeaseFenceError(`runtime_event_${field}_invalid`)
  return value
}
function isoTime(value: unknown): string {
  const raw = text(value, 'created_at')
  const time = Date.parse(raw)
  if (!Number.isFinite(time)) throw new RuntimeLeaseFenceError('runtime_event_created_at_invalid')
  return new Date(time).toISOString()
}
function mandateOf(value: Record<string, unknown>): RuntimeEventMandate {
  return {
    eventId: value.eventId, tenantId: value.tenantId, factoryId: value.factoryId,
    departmentId: value.departmentId, taskId: value.taskId, leaseId: value.leaseId,
    leaseEpoch: value.leaseEpoch, workerId: value.workerId,
  } as RuntimeEventMandate
}

/** 只透传明确字段；事件本体不携带可执行代码或额外资金/合同指令。 */
export function parseRuntimeEventEnvelope(value: unknown): Readonly<RuntimeEventEnvelope> {
  const input = record(value)
  const mandate = mandateOf(input)
  assertRuntimeMandateShape(mandate)
  const payloadSha256 = text(input.payloadSha256, 'payload_sha256')
  if (!/^[a-f0-9]{64}$/.test(payloadSha256)) throw new RuntimeLeaseFenceError('runtime_event_payload_sha256_invalid')
  return Object.freeze({
    ...mandate,
    source: text(input.source, 'source'),
    type: text(input.type, 'type'),
    payloadSha256,
    createdAt: isoTime(input.createdAt),
    dedupeKey: text(input.dedupeKey, 'dedupe_key'),
  })
}

export type WatchdogClassification = 'stuck' | 'failed' | 'timeout' | 'lease_revoked'
export interface ReadOnlyWatchdogEvidence {
  scope: RuntimeEventMandate
  classification: WatchdogClassification
  detail: string
  observedAt: string
  readOnly: true
  mutatesCanonicalState: false
  repairChannel: 'backend_state_machine'
  untrustedContent: true
}

/** Watchdog 只能形成证据；修复必须回后端状态机，召回/详情一律视为不可信内容。 */
export function createReadOnlyWatchdogEvidence(
  scope: RuntimeEventMandate,
  classification: WatchdogClassification,
  detail: string,
  observedAt: string,
): Readonly<ReadOnlyWatchdogEvidence> {
  assertRuntimeMandateShape(scope)
  if (!['stuck', 'failed', 'timeout', 'lease_revoked'].includes(classification)) throw new RuntimeLeaseFenceError('runtime_watchdog_classification_invalid')
  return Object.freeze({
    scope: Object.freeze({ ...scope }),
    classification,
    detail: text(detail, 'detail', 2_000),
    observedAt: isoTime(observedAt),
    readOnly: true,
    mutatesCanonicalState: false,
    repairChannel: 'backend_state_machine',
    untrustedContent: true,
  })
}
