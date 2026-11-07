import { describe, expect, it, vi } from 'vitest'
import { executeRuntimeOutboxEvent, type RuntimeExecutionEvidence, type RuntimeOutboxEvidenceStore } from './runtimeOutboxExecutor'
import type { RuntimeLeaseContext } from './runtimeLeaseFence'

const scope = { eventId: 'evt-1', tenantId: 'tenant-a', factoryId: 7, departmentId: 'dept-a', taskId: 11, leaseId: 'lease-1', leaseEpoch: 3, workerId: 'worker-a' }
const lease: RuntimeLeaseContext = { status: 'active', ...scope, expiresAt: '2999-01-01T00:00:00Z' }
const event = { ...scope, source: 'router', type: 'task.dispatch', payloadSha256: 'a'.repeat(64), createdAt: '2026-11-04T16:00:00Z', dedupeKey: 'dedupe-1' }
function store(claim: 'claimed' | 'duplicate' | 'evidence_write_failed' = 'claimed') {
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
  it('原始证据写失败时改写最小 outcome_unknown，不清 claim 重跑', async () => {
    const persistence = store()
    persistence.claim.mockResolvedValueOnce('claimed').mockResolvedValue('duplicate')
    persistence.record.mockImplementationOnce(async () => { throw new Error('injected evidence write failure') })
    const executor = vi.fn(async () => result)
    const outcome = await executeRuntimeOutboxEvent(event, async () => lease, persistence, executor, allowAll)
    expect(outcome).toMatchObject({ status: 'outcome_unknown', delivered: false, failureCode: 'evidence_write_failed', evidenceSha256: result.evidenceSha256 })
    expect(persistence.recorded).toHaveLength(1)
    expect(persistence.recorded[0]).toMatchObject({ status: 'outcome_unknown', failureCode: 'evidence_write_failed' })
    expect(await executeRuntimeOutboxEvent(event, async () => lease, persistence, executor, allowAll)).toEqual({ status: 'duplicate', delivered: false })
    expect(executor).toHaveBeenCalledTimes(1)
  })
  it('证据连续写失败时持久化恢复标记，后续事件只读未知状态', async () => {
    let claimState: 'claimed' | 'evidence_write_failed' = 'claimed'
    const persistence = {
      claim: vi.fn(async () => claimState),
      record: vi.fn(async () => { throw new Error('database unavailable') }),
      markEvidenceWriteFailed: vi.fn(async () => { claimState = 'evidence_write_failed' }),
    } satisfies RuntimeOutboxEvidenceStore
    const executor = vi.fn(async () => result)
    const first = await executeRuntimeOutboxEvent(event, async () => lease, persistence, executor, allowAll)
    const second = await executeRuntimeOutboxEvent(event, async () => lease, persistence, executor, allowAll)
    expect(first).toMatchObject({ status: 'outcome_unknown', failureCode: 'evidence_write_failed' })
    expect(second).toMatchObject({ status: 'outcome_unknown', failureCode: 'evidence_write_failed' })
    expect(persistence.markEvidenceWriteFailed).toHaveBeenCalledTimes(1)
    expect(executor).toHaveBeenCalledTimes(1)
  })
  it('执行器返回 nullish 时只记 executor_evidence_invalid，不抛裸 TypeError', async () => {
    const persistence = store()
    const outcome = await executeRuntimeOutboxEvent(event, async () => lease, persistence, async () => undefined as never, allowAll)
    expect(outcome).toMatchObject({ status: 'execution_failed', delivered: false, failureCode: 'executor_evidence_invalid' })
  })
  it('缺 authorizer 时在 lease 与 claim 前拒绝', async () => {
    const persistence = store()
    await expect(executeRuntimeOutboxEvent(event, async () => lease, persistence, async () => result, undefined as never)).rejects.toThrow('runtime_authorizer_required')
    expect(persistence.claim).not.toHaveBeenCalled()
  })
  it('未知 claim 结果必须失败关闭，不得无执行权调用 executor', async () => {
    const persistence = store('unexpected-claim-state' as never)
    const executor = vi.fn(async () => result)
    await expect(executeRuntimeOutboxEvent(event, async () => lease, persistence, executor, allowAll)).rejects.toThrow('runtime_store_claim_invalid')
    expect(executor).not.toHaveBeenCalled()
  })

})
