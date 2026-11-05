/** 真实 MySQL outbox 执行链集成；默认跳过，只在显式隔离库运行。 */
import { beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { executeRuntimeOutboxEvent } from './runtimeOutboxExecutor'
import { RuntimeOutboxMysqlStore, readRuntimeLease } from './runtimeOutboxMysql'
import { AGENT_TEST_DATABASE_PREFIX } from './agentEconomy'

const enabled = process.env.AGENT_EMPLOYMENT_MYSQL_TEST === '1'
const db = enabled ? getDb() : (undefined as unknown as ReturnType<typeof getDb>)
const store = enabled ? new RuntimeOutboxMysqlStore(db) : null
const suffix = randomBytes(5).toString('hex')
function eventFor(leaseId: string, label: string) {
  return {
    eventId: `${label}-${suffix}`, tenantId: 'tenant-a', factoryId: 1, departmentId: 'dept-a', taskId: 11,
    leaseId, leaseEpoch: 3, workerId: 'worker-a', source: 'router', type: 'task.dispatch',
    payloadSha256: 'a'.repeat(64), createdAt: '2026-11-05T01:00:00Z', dedupeKey: `${label}-${suffix}`,
  }
}
async function seed(leaseId: string, status = 'active') {
  await db.execute(sql`INSERT INTO st_runtime_leases
    (lease_id, tenant_id, factory_id, department_id, task_id, lease_epoch, worker_id, status, expires_at)
    VALUES (${leaseId}, 'tenant-a', 1, 'dept-a', 11, 3, 'worker-a', ${status}, DATE_ADD(NOW(), INTERVAL 1 HOUR))`)
}
async function lease(leaseId: string) {
  const current = await readRuntimeLease(db, leaseId)
  if (!current) throw new Error('test_lease_missing')
  return current
}
const allowAll = async () => undefined
const result = { evidenceSha256: 'b'.repeat(64), summary: 'executed; review required' }

beforeAll(async () => {
  if (!enabled) return
  const row = rawRows(await db.execute(sql`SELECT DATABASE() AS name`))[0]
  expect(String(row?.name)).toMatch(new RegExp(`^${AGENT_TEST_DATABASE_PREFIX}`))
  await seed(`valid-${suffix}`); await seed(`revoked-${suffix}`, 'revoked')
  await seed(`mid-${suffix}`); await seed(`failed-${suffix}`)
})

describe('runtime outbox 真实执行集成', () => {
  it('有效事件 executed_not_done，重复事件不重复执行或写证据', async () => {
    if (!enabled || !store) return
    const event = eventFor(`valid-${suffix}`, 'valid-event')
    let executions = 0
    const executor = async () => { executions += 1; return result }
    expect(await executeRuntimeOutboxEvent(event, () => lease(event.leaseId), store, executor, allowAll)).toMatchObject({ status: 'executed_not_done', delivered: false })
    expect(await executeRuntimeOutboxEvent(event, () => lease(event.leaseId), store, executor, allowAll)).toEqual({ status: 'duplicate', delivered: false })
    expect(executions).toBe(1)
    expect(rawRows(await db.execute(sql`SELECT id FROM st_runtime_execution_evidence WHERE event_id=${event.eventId}`))).toHaveLength(1)
  })
  it('执行前撤销没有执行权', async () => {
    if (!enabled || !store) return
    const event = eventFor(`revoked-${suffix}`, 'revoked-event')
    await expect(executeRuntimeOutboxEvent(event, () => lease(event.leaseId), store, async () => result, allowAll)).rejects.toThrow('runtime_lease_not_active')
    expect(rawRows(await db.execute(sql`SELECT id FROM st_runtime_outbox_claims WHERE event_id=${event.eventId}`))).toHaveLength(0)
  })
  it('执行中撤销只记 outcome_unknown', async () => {
    if (!enabled || !store) return
    const event = eventFor(`mid-${suffix}`, 'mid-event')
    const outcome = await executeRuntimeOutboxEvent(event, () => lease(event.leaseId), store, async () => {
      await db.execute(sql`UPDATE st_runtime_leases SET status='revoked' WHERE lease_id=${event.leaseId}`)
      return result
    }, allowAll)
    expect(outcome).toMatchObject({ status: 'outcome_unknown', delivered: false, failureCode: 'runtime_lease_not_active' })
  })
  it('执行器失败只记 execution_failed', async () => {
    if (!enabled || !store) return
    const event = eventFor(`failed-${suffix}`, 'failed-event')
    const outcome = await executeRuntimeOutboxEvent(event, () => lease(event.leaseId), store, async () => { throw new Error('worker crashed') }, allowAll)
    expect(outcome).toMatchObject({ status: 'execution_failed', delivered: false, failureCode: 'executor_error' })
  })
})
