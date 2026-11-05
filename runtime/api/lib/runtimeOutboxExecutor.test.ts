import { describe, expect, it, vi } from 'vitest'
import { executeRuntimeOutboxEvent, type RuntimeExecutionEvidence, type RuntimeOutboxEvidenceStore } from './runtimeOutboxExecutor'
import type { RuntimeLeaseContext } from './runtimeLeaseFence'

const scope = { eventId: 'evt-1', tenantId: 'tenant-a', factoryId: 7, departmentId: 'dept-a', taskId: 11, leaseId: 'lease-1', leaseEpoch: 3, workerId: 'worker-a' }
const lease: RuntimeLeaseContext = { status: 'active', ...scope }
const event = { ...scope, source: 'router', type: 'task.dispatch', payloadSha256: 'a'.repeat(64), createdAt: '2026-11-04T16:00:00Z', dedupeKey: 'dedupe-1' }
function store(claim: 'claimed' | 'duplicate' = 'claimed') {
  const recorded: RuntimeExecutionEvidence[] = []
  return { recorded, claim: vi.fn(async () => claim), record: vi.fn(async (evidence: RuntimeExecutionEvidence) => { recorded.push(evidence) }) } satisfies RuntimeOutboxEvidenceStore & { recorded: RuntimeExecutionEvidence[] }
}
const allowAll = async () => undefined
const result = { evidenceSha256: 'b'.repeat(64), summary: 'executed; independent review still required' }

describe('runtime outbox 执行证据边界', () => {
  it('有效执行只记 executed_not_done，绝不等于 delivered', async () => {
    const persistence = store()
    const executor = vi.fn(async () => result)
    const outcome = await executeRuntimeOutboxEvent(event, async () => lease, persistence, executor, allowAll)
    expect(outcome).toMatchObject({ status: 'executed_not_done', delivered: false, evidenceSha256: result.evidenceSha256 })
    expect(executor).toHaveBeenCalledTimes(1)
    expect(persistence.recorded[0]).toMatchObject({ status: 'executed_not_done', delivered: false })
  })
  it('原子 dedupe 命中时不执行', async () => {
    const persistence = store('duplicate'); const executor = vi.fn(async () => result)
    expect(await executeRuntimeOutboxEvent(event, async () => lease, persistence, executor, allowAll)).toEqual({ status: 'duplicate', delivered: false })
    expect(executor).not.toHaveBeenCalled()
  })
  it('执行前 lease 已失效则没有执行权', async () => {
    const persistence = store(); const executor = vi.fn(async () => result)
    await expect(executeRuntimeOutboxEvent(event, async () => ({ ...lease, status: 'revoked' }), persistence, executor, allowAll)).rejects.toThrow('runtime_lease_not_active')
    expect(executor).not.toHaveBeenCalled(); expect(persistence.claim).not.toHaveBeenCalled()
  })
  it('执行中撤销 lease 时只记 outcome_unknown，不能伪装正常完成', async () => {
    const persistence = store(); let reads = 0
    const outcome = await executeRuntimeOutboxEvent(event, async () => (++reads === 1 ? lease : { ...lease, status: 'revoked' }), persistence, async () => result, allowAll)
    expect(outcome).toMatchObject({ status: 'outcome_unknown', delivered: false, failureCode: 'runtime_lease_not_active' })
    expect(persistence.recorded[0]?.status).toBe('outcome_unknown')
  })
  it('执行器失败只记 execution_failed', async () => {
    const persistence = store()
    const outcome = await executeRuntimeOutboxEvent(event, async () => lease, persistence, async () => { throw new Error('worker crashed') }, allowAll)
    expect(outcome).toMatchObject({ status: 'execution_failed', delivered: false, failureCode: 'executor_error' })
  })
  it('缺 authorizer 时在 lease 与 claim 前拒绝', async () => {
    const persistence = store()
    await expect(executeRuntimeOutboxEvent(event, async () => lease, persistence, async () => result, undefined as never)).rejects.toThrow('runtime_authorizer_required')
    expect(persistence.claim).not.toHaveBeenCalled()
  })
})
