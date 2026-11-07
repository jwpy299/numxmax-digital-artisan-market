/** 真实 MySQL runtime outbox/lease 验证；默认跳过，只在显式隔离库运行。 */
import { beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { RuntimeOutboxMysqlStore, readRuntimeLease, toRuntimeUtcIso } from './runtimeOutboxMysql'
import { AGENT_TEST_DATABASE_PREFIX } from './agentEconomy'
import { assertRuntimeEventDelivery } from './runtimeLeaseFence'

const enabled = process.env.AGENT_EMPLOYMENT_MYSQL_TEST === '1'
const db = enabled ? getDb() : (undefined as unknown as ReturnType<typeof getDb>)
const suffix = randomBytes(5).toString('hex')
const leaseId = `lease-${suffix}`
const event = { eventId: `event-${suffix}`, dedupeKey: `dedupe-${suffix}`, leaseId, leaseEpoch: 3 }

type Db = ReturnType<typeof getDb>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Query = Parameters<Db['execute']>[0]

/** 在 takeover CAS 前开门，确定性复现旧 worker record 与恢复流程的交错。 */
type Executor = Pick<Db, 'execute'>
function gateTakeoverUpdate(db: Db, entered: () => void, release: Promise<void>): Db {
  let gated = false
  const wrap = (runner: Executor) => async (query: Query) => {
    if (!gated && JSON.stringify(query).includes('UPDATE st_runtime_outbox_claims c')) {
      gated = true
      entered()
      await release
    }
    return runner.execute(query)
  }
  return {
    execute: wrap(db),
    transaction: async (callback: (tx: Tx) => Promise<unknown>) => db.transaction(async (tx) => {
      const wrapped = Object.create(tx) as Tx
      wrapped.execute = wrap(tx as unknown as Executor)
      return callback(wrapped)
    }),
  } as unknown as Db
}

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
    expect(claims.filter((value) => value === 'evidence_write_failed')).toHaveLength(1)
    await expect(store.claim({ ...event, leaseEpoch: 4 })).rejects.toThrow('runtime_store_claim_conflict')
    await store.record({ ...event, status: 'executed_not_done', delivered: false, evidenceSha256: 'a'.repeat(64), summary: 'executed; awaiting independent review', untrustedContent: true })
    await store.record({ ...event, status: 'outcome_unknown', delivered: false, failureCode: 'evidence_write_failed', untrustedContent: true })
    await expect(store.record({ ...event, status: 'executed_not_done', delivered: true, untrustedContent: true } as never)).rejects.toThrow('runtime_store_delivery_boundary_invalid')
    expect(await store.claim({ ...event, leaseId: `never-execute-${suffix}`, leaseEpoch: 4, workerId: 'worker-b', tenantId: 'tenant-a', factoryId: 1, departmentId: 'dept-a', taskId: 11 })).toBe('duplicate')
    const evidence = rawRows(await db.execute(sql`SELECT status, delivered, untrusted_content AS untrusted FROM st_runtime_execution_evidence WHERE event_id=${event.eventId}`))
    expect(evidence).toHaveLength(1)
    expect(Number(evidence[0].delivered)).toBe(0)
    expect(Number(evidence[0].untrusted)).toBe(1)
    expect(await readRuntimeLease(db, leaseId)).toMatchObject({ leaseId, leaseEpoch: 3, workerId: 'worker-a', status: 'active', factoryId: 1, departmentId: 'dept-a', taskId: 11 })
  })

  it('只有无证据的合法接管可 CAS 换 lease；旧 lease 与未知恢复态不得重跑', async () => {
    if (!enabled) return
    const store = new RuntimeOutboxMysqlStore(db)
    const oldLeaseId = `old-takeover-${suffix}`
    const nextLeaseId = `next-takeover-${suffix}`
    await db.execute(sql`INSERT INTO st_runtime_leases
      (lease_id, tenant_id, factory_id, department_id, task_id, lease_epoch, worker_id, status, expires_at)
      VALUES (${oldLeaseId}, 'tenant-a', 1, 'dept-a', 11, 3, 'worker-a', 'active', DATE_ADD(NOW(), INTERVAL 1 HOUR))`)
    const oldEvent = { eventId: `takeover-event-${suffix}`, dedupeKey: `takeover-dedupe-${suffix}`, leaseId: oldLeaseId, leaseEpoch: 3 }
    expect(await store.claim(oldEvent)).toBe('claimed')
    await db.execute(sql`UPDATE st_runtime_leases SET status='revoked' WHERE lease_id=${oldLeaseId}`)
    await db.execute(sql`INSERT INTO st_runtime_leases
      (lease_id, tenant_id, factory_id, department_id, task_id, lease_epoch, worker_id, status, expires_at)
      VALUES (${nextLeaseId}, 'tenant-a', 1, 'dept-a', 11, 4, 'worker-b', 'active', DATE_ADD(NOW(), INTERVAL 1 HOUR))`)
    const nextEvent = { ...oldEvent, leaseId: nextLeaseId, leaseEpoch: 4, tenantId: 'tenant-a', factoryId: 1, departmentId: 'dept-a', taskId: 11, workerId: 'worker-b' }
    expect(await store.claim(nextEvent)).toBe('claimed')
    expect(await store.claim(nextEvent)).toBe('evidence_write_failed')
    await expect(store.claim({ ...oldEvent, tenantId: 'tenant-a', factoryId: 1, departmentId: 'dept-a', taskId: 11, workerId: 'worker-a' })).rejects.toThrow('runtime_store_claim_conflict')
    const claim = rawRows(await db.execute(sql`SELECT lease_id AS leaseId, lease_epoch AS leaseEpoch FROM st_runtime_outbox_claims WHERE event_id=${oldEvent.eventId}`))[0]
    expect(claim).toMatchObject({ leaseId: nextLeaseId, leaseEpoch: 4 })
    await db.execute(sql`UPDATE st_runtime_outbox_claims SET status='evidence_write_failed' WHERE event_id=${oldEvent.eventId}`)
    expect(await store.claim({ ...nextEvent, leaseId: `third-takeover-${suffix}`, leaseEpoch: 5, workerId: 'worker-c' })).toBe('evidence_write_failed')
  })
  it('同 dedupe 换 eventId 的合法接管按 claim id CAS，并可写回新事件证据', async () => {
    if (!enabled) return
    const store = new RuntimeOutboxMysqlStore(db)
    const oldLeaseId = `rotate-old-lease-${suffix}`
    const nextLeaseId = `rotate-next-lease-${suffix}`
    await db.execute(sql`INSERT INTO st_runtime_leases
      (lease_id, tenant_id, factory_id, department_id, task_id, lease_epoch, worker_id, status, expires_at)
      VALUES (${oldLeaseId}, 'tenant-a', 1, 'dept-a', 11, 1, 'worker-a', 'active', DATE_ADD(NOW(), INTERVAL 1 HOUR)),
             (${nextLeaseId}, 'tenant-a', 1, 'dept-a', 11, 2, 'worker-b', 'active', DATE_ADD(NOW(), INTERVAL 1 HOUR))`)
    const previous = { eventId: `rotate-old-event-${suffix}`, dedupeKey: `rotate-dedupe-${suffix}`, leaseId: oldLeaseId, leaseEpoch: 1 }
    expect(await store.claim(previous)).toBe('claimed')
    const rotated = { ...previous, eventId: `rotate-new-event-${suffix}`, leaseId: nextLeaseId, leaseEpoch: 2, tenantId: 'tenant-a', factoryId: 1, departmentId: 'dept-a', taskId: 11, workerId: 'worker-b' }
    await db.execute(sql`UPDATE st_runtime_leases SET status='revoked' WHERE lease_id=${oldLeaseId}`)
    expect(await store.claim(rotated)).toBe('claimed')
    await store.record({ ...rotated, status: 'executed_not_done', delivered: false, untrustedContent: true })
    const claim = rawRows(await db.execute(sql`SELECT event_id AS eventId, dedupe_key AS dedupeKey, lease_id AS leaseId FROM st_runtime_outbox_claims WHERE dedupe_key=${rotated.dedupeKey}`))[0]
    expect(claim).toMatchObject({ eventId: rotated.eventId, dedupeKey: rotated.dedupeKey, leaseId: nextLeaseId })
    expect(rawRows(await db.execute(sql`SELECT id FROM st_runtime_execution_evidence WHERE event_id=${rotated.eventId}`))).toHaveLength(1)
  })
  it('活跃未到期旧 lease 禁止接管，过期 active lease 才允许 CAS 接管', async () => {
    if (!enabled) return
    const store = new RuntimeOutboxMysqlStore(db)
    const oldLeaseId = `active-old-${suffix}`
    const nextLeaseId = `active-next-${suffix}`
    await db.execute(sql`INSERT INTO st_runtime_leases
      (lease_id, tenant_id, factory_id, department_id, task_id, lease_epoch, worker_id, status, expires_at)
      VALUES (${oldLeaseId}, 'tenant-a', 1, 'dept-a', 11, 3, 'worker-a', 'active', DATE_ADD(NOW(), INTERVAL 1 HOUR)),
             (${nextLeaseId}, 'tenant-a', 1, 'dept-a', 11, 4, 'worker-b', 'active', DATE_ADD(NOW(), INTERVAL 1 HOUR))`)
    const previous = { eventId: `active-event-${suffix}`, dedupeKey: `active-dedupe-${suffix}`, leaseId: oldLeaseId, leaseEpoch: 3 }
    expect(await store.claim(previous)).toBe('claimed')
    const next = { ...previous, leaseId: nextLeaseId, leaseEpoch: 4, tenantId: 'tenant-a', factoryId: 1, departmentId: 'dept-a', taskId: 11, workerId: 'worker-b' }
    await expect(store.claim(next)).rejects.toThrow('runtime_store_claim_conflict')
    await db.execute(sql`UPDATE st_runtime_leases SET expires_at=DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE lease_id=${oldLeaseId}`)
    expect(await store.claim(next)).toBe('claimed')
    const claim = rawRows(await db.execute(sql`SELECT lease_id AS leaseId, lease_epoch AS leaseEpoch FROM st_runtime_outbox_claims WHERE event_id=${previous.eventId}`))[0]
    expect(claim).toMatchObject({ leaseId: nextLeaseId, leaseEpoch: 4 })
  })
  it('takeover 与旧 worker record 使用真实 tx 行锁串行，旧证据不得跨 lease 写入', async () => {
    if (!enabled) return
    const store = new RuntimeOutboxMysqlStore(db)
    const oldLeaseId = `race-old-${suffix}`
    const nextLeaseId = `race-next-${suffix}`
    await db.execute(sql`INSERT INTO st_runtime_leases
      (lease_id, tenant_id, factory_id, department_id, task_id, lease_epoch, worker_id, status, expires_at)
      VALUES (${oldLeaseId}, 'tenant-a', 1, 'dept-a', 11, 1, 'worker-a', 'active', DATE_ADD(NOW(), INTERVAL 1 HOUR)),
             (${nextLeaseId}, 'tenant-a', 1, 'dept-a', 11, 2, 'worker-b', 'active', DATE_ADD(NOW(), INTERVAL 1 HOUR))`)
    const previous = { eventId: `race-event-${suffix}`, dedupeKey: `race-dedupe-${suffix}`, leaseId: oldLeaseId, leaseEpoch: 1 }
    expect(await store.claim(previous)).toBe('claimed')
    await db.execute(sql`UPDATE st_runtime_leases SET status='revoked' WHERE lease_id=${oldLeaseId}`)
    const next = { ...previous, leaseId: nextLeaseId, leaseEpoch: 2, tenantId: 'tenant-a', factoryId: 1, departmentId: 'dept-a', taskId: 11, workerId: 'worker-b' }

    let enteredGate!: () => void
    let releaseGate!: () => void
    const entered = new Promise<void>((resolve) => { enteredGate = resolve })
    const release = new Promise<void>((resolve) => { releaseGate = resolve })
    const gatedStore = new RuntimeOutboxMysqlStore(gateTakeoverUpdate(db, enteredGate, release))
    const takeover = gatedStore.claim(next)
    await entered
    const oldRecord = store.record({ ...previous, status: 'executed_not_done', delivered: false, untrustedContent: true }).then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    releaseGate()

    expect(await takeover).toBe('claimed')
    const oldOutcome = await oldRecord
    expect(oldOutcome.status).toBe('rejected')
    expect(String((oldOutcome as { error: unknown }).error)).toContain('runtime_store_evidence_claim_mismatch')
    const claim = rawRows(await db.execute(sql`SELECT lease_id AS leaseId FROM st_runtime_outbox_claims WHERE event_id=${previous.eventId}`))[0]
    expect(claim).toMatchObject({ leaseId: nextLeaseId })
    expect(rawRows(await db.execute(sql`SELECT id FROM st_runtime_execution_evidence WHERE event_id=${previous.eventId}`))).toHaveLength(0)
    await store.record({ ...next, status: 'executed_not_done', delivered: false, untrustedContent: true })
    const evidence = rawRows(await db.execute(sql`SELECT lease_id AS leaseId, lease_epoch AS leaseEpoch FROM st_runtime_execution_evidence WHERE event_id=${next.eventId}`))
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({ leaseId: nextLeaseId, leaseEpoch: 2 })
  })
  it('CAS 前旧 lease 被续期时必须当前读拒绝，不得依靠过期快照发放执行权', async () => {
    if (!enabled) return
    const store = new RuntimeOutboxMysqlStore(db)
    const oldLeaseId = `renew-old-${suffix}`
    const nextLeaseId = `renew-next-${suffix}`
    await db.execute(sql`INSERT INTO st_runtime_leases
      (lease_id, tenant_id, factory_id, department_id, task_id, lease_epoch, worker_id, status, expires_at)
      VALUES (${oldLeaseId}, 'tenant-a', 1, 'dept-a', 11, 1, 'worker-a', 'active', DATE_SUB(NOW(), INTERVAL 1 SECOND)),
             (${nextLeaseId}, 'tenant-a', 1, 'dept-a', 11, 2, 'worker-b', 'active', DATE_ADD(NOW(), INTERVAL 1 HOUR))`)
    const previous = { eventId: `renew-event-${suffix}`, dedupeKey: `renew-dedupe-${suffix}`, leaseId: oldLeaseId, leaseEpoch: 1 }
    expect(await store.claim(previous)).toBe('claimed')
    const next = { ...previous, leaseId: nextLeaseId, leaseEpoch: 2, tenantId: 'tenant-a', factoryId: 1, departmentId: 'dept-a', taskId: 11, workerId: 'worker-b' }

    let enteredGate!: () => void
    let releaseGate!: () => void
    const entered = new Promise<void>((resolve) => { enteredGate = resolve })
    const release = new Promise<void>((resolve) => { releaseGate = resolve })
    const gatedStore = new RuntimeOutboxMysqlStore(gateTakeoverUpdate(db, enteredGate, release))
    const takeover = gatedStore.claim(next)
    await entered
    await db.execute(sql`UPDATE st_runtime_leases SET status='active', expires_at=DATE_ADD(NOW(), INTERVAL 1 HOUR) WHERE lease_id=${oldLeaseId}`)
    releaseGate()

    await expect(takeover).rejects.toThrow('runtime_store_claim_conflict')
    const claim = rawRows(await db.execute(sql`SELECT lease_id AS leaseId FROM st_runtime_outbox_claims WHERE event_id=${previous.eventId}`))[0]
    expect(claim).toMatchObject({ leaseId: oldLeaseId })
    expect(rawRows(await db.execute(sql`SELECT id FROM st_runtime_execution_evidence WHERE event_id=${previous.eventId}`))).toHaveLength(0)
  })
  it('readRuntimeLease 回读到期时间，过期投递在 fence 直接拒绝', async () => {
    if (!enabled) return
    const expiredLeaseId = `expired-${suffix}`
    await db.execute(sql`INSERT INTO st_runtime_leases
      (lease_id, tenant_id, factory_id, department_id, task_id, lease_epoch, worker_id, status, expires_at)
      VALUES (${expiredLeaseId}, 'tenant-a', 1, 'dept-a', 11, 3, 'worker-a', 'active', DATE_SUB(NOW(), INTERVAL 1 SECOND))`)
    const current = await readRuntimeLease(db, expiredLeaseId)
    expect(current?.expiresAt).toBeTruthy()
    expect(() => assertRuntimeEventDelivery({ eventId: 'expired-event', tenantId: 'tenant-a', factoryId: 1, departmentId: 'dept-a', taskId: 11, leaseId: expiredLeaseId, leaseEpoch: 3, workerId: 'worker-a' }, current!)).toThrow('runtime_lease_expired')
  })
  it('MySQL 文本时间按 UTC 归一，不随进程时区漂移', () => {
    expect(toRuntimeUtcIso('2030-01-01 01:02:03')).toBe('2030-01-01T01:02:03.000Z')
    expect(toRuntimeUtcIso('2030-01-01T01:02:03Z')).toBe('2030-01-01T01:02:03.000Z')
    expect(toRuntimeUtcIso('2030-01-01 01:02:03.456')).toBe('2030-01-01T01:02:03.456Z')
    expect(toRuntimeUtcIso('2030-01-01 01:02:03.123456')).toBe('2030-01-01T01:02:03.123Z')
    expect(() => toRuntimeUtcIso('not-a-date')).toThrow('runtime_store_expiry_invalid')
  })

})
