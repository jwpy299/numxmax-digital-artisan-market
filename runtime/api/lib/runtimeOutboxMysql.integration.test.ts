/** 真实 MySQL runtime outbox/lease 验证；默认跳过，只在显式隔离库运行。 */
import { beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { RuntimeOutboxMysqlStore, readRuntimeLease } from './runtimeOutboxMysql'
import { AGENT_TEST_DATABASE_PREFIX } from './agentEconomy'

const enabled = process.env.AGENT_EMPLOYMENT_MYSQL_TEST === '1'
const db = enabled ? getDb() : (undefined as unknown as ReturnType<typeof getDb>)
const suffix = randomBytes(5).toString('hex')
const leaseId = `lease-${suffix}`
const event = { eventId: `event-${suffix}`, dedupeKey: `dedupe-${suffix}`, leaseId, leaseEpoch: 3 }

beforeAll(async () => {
  if (!enabled) return
  const database = rawRows(await db.execute(sql`SELECT DATABASE() AS name`))[0]
  expect(String(database?.name)).toMatch(new RegExp(`^${AGENT_TEST_DATABASE_PREFIX}`))
  await db.execute(sql`INSERT INTO st_runtime_leases
    (lease_id, tenant_id, factory_id, department_id, task_id, lease_epoch, worker_id, status, expires_at)
    VALUES (${leaseId}, 'tenant-a', 1, 'dept-a', 11, 3, 'worker-a', 'active', DATE_ADD(NOW(), INTERVAL 1 HOUR))`)
})

describe('runtime outbox MySQL canonical adapter', () => {
  it('并发 claim 只有一个执行权，证据保持 delivered=0，lease 可真实回读', async () => {
    if (!enabled) return
    const store = new RuntimeOutboxMysqlStore(db)
    const claims = await Promise.all([store.claim(event), store.claim(event)])
    expect(claims.filter((value) => value === 'claimed')).toHaveLength(1)
    expect(claims.filter((value) => value === 'duplicate')).toHaveLength(1)
    await expect(store.claim({ ...event, leaseEpoch: 4 })).rejects.toThrow('runtime_store_claim_conflict')
    await store.record({ ...event, status: 'executed_not_done', delivered: false, evidenceSha256: 'a'.repeat(64), summary: 'executed; awaiting independent review', untrustedContent: true })
    await expect(store.record({ ...event, status: 'executed_not_done', delivered: true, untrustedContent: true } as never)).rejects.toThrow('runtime_store_delivery_boundary_invalid')
    const evidence = rawRows(await db.execute(sql`SELECT status, delivered, untrusted_content AS untrusted FROM st_runtime_execution_evidence WHERE event_id=${event.eventId}`))
    expect(evidence).toHaveLength(1)
    expect(Number(evidence[0].delivered)).toBe(0)
    expect(Number(evidence[0].untrusted)).toBe(1)
    expect(await readRuntimeLease(db, leaseId)).toMatchObject({ leaseId, leaseEpoch: 3, workerId: 'worker-a', status: 'active', factoryId: 1, departmentId: 'dept-a', taskId: 11 })
  })
})
