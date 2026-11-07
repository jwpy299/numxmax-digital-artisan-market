import { parseDbUtc } from './dbUtc'

/** P1 runtime delivery fence. Pure functions only; canonical state remains in the backend. */
export type RuntimeLeaseStatus = 'active' | 'revoked' | 'closed'

export interface RuntimeEventMandate {
  eventId: string
  tenantId: string
  factoryId: number
  departmentId: string
  taskId: number
  leaseId: string
  leaseEpoch: number
  workerId: string
}

export interface RuntimeLeaseContext {
  status: RuntimeLeaseStatus
  tenantId: string
  factoryId: number
  departmentId: string
  taskId: number
  leaseId: string
  leaseEpoch: number
  workerId: string
  expiresAt?: string
}

export class RuntimeLeaseFenceError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'RuntimeLeaseFenceError' }
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new RuntimeLeaseFenceError(`runtime_mandate_${field}_invalid`)
  }
  return value
}
function id(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new RuntimeLeaseFenceError(`runtime_mandate_${field}_invalid`)
  }
  return Number(value)
}
function epoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new RuntimeLeaseFenceError('runtime_lease_epoch_invalid')
  return Number(value)
}

export function assertRuntimeMandateShape(mandate: RuntimeEventMandate): void {
  text(mandate.eventId, 'event_id')
  text(mandate.tenantId, 'tenant_id')
  id(mandate.factoryId, 'factory_id')
  text(mandate.departmentId, 'department_id')
  id(mandate.taskId, 'task_id')
  text(mandate.leaseId, 'lease_id')
  epoch(mandate.leaseEpoch)
  text(mandate.workerId, 'worker_id')
}

/** Every delivery re-checks current scope and exact lease ownership; stale/future epochs never execute. */
export function assertRuntimeEventDelivery(mandate: RuntimeEventMandate, lease: RuntimeLeaseContext): void {
  assertRuntimeMandateShape(mandate)
  const currentEpoch = epoch(lease.leaseEpoch)
  if (lease.status !== 'active') throw new RuntimeLeaseFenceError('runtime_lease_not_active')
  const scopeMatches = mandate.tenantId === lease.tenantId
    && mandate.factoryId === id(lease.factoryId, 'factory_id')
    && mandate.departmentId === lease.departmentId
    && mandate.taskId === id(lease.taskId, 'task_id')
    && mandate.leaseId === lease.leaseId
    && mandate.workerId === lease.workerId
  if (!scopeMatches) throw new RuntimeLeaseFenceError('runtime_lease_scope_mismatch')
  const expiresAt = parseDbUtc(lease.expiresAt ?? '')
  if (!Number.isFinite(expiresAt)) throw new RuntimeLeaseFenceError('runtime_lease_expiry_invalid')
  if (expiresAt <= Date.now()) throw new RuntimeLeaseFenceError('runtime_lease_expired')
  if (mandate.leaseEpoch < currentEpoch) throw new RuntimeLeaseFenceError('runtime_lease_stale')
  if (mandate.leaseEpoch > currentEpoch) throw new RuntimeLeaseFenceError('runtime_lease_epoch_conflict')
}
