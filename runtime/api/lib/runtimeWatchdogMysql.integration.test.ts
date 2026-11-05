/** 真实 MySQL 只读 Watchdog 验证；默认跳过，只在显式隔离库运行。 */
import { beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { runRuntimeWatchdogMysqlOnce } from './runtimeWatchdogMysql'

const enabled = process.env.AGENT_EMPLOYMENT_MYSQL_TEST === '1'
const db = enabled ? getDb() : (undefined as unknown as ReturnType<typeof getDb>)
const tenantId = `watchdog-${randomBytes(5).toString('hex')}`
async function seed(leaseId: string, status: string, heartbeat: string) {
  await db.execute(sql`INSERT INTO st_runtime_leases
    (lease_id, tenant_id, factory_id, department_id, task_id, lease_epoch, worker_id, status, expires_at, last_heartbeat_at)
    VALUES (${leaseId}, ${tenantId}, 1, 'dept-a', 11, 1, 'worker-a', ${status}, DATE_ADD(NOW(), INTERVAL 1 HOUR), ${heartbeat})`)
}

beforeAll(async () => {
  if (!enabled) return
  await seed(`${tenantId}-healthy`, 'active', '2026-11-05 00:59:59')
  await seed(`${tenantId}-stuck`, 'active', '2026-11-05 00:58:00')
  await seed(`${tenantId}-revoked`, 'revoked', '2026-11-05 00:59:59')
})

describe('runtime Watchdog 真实只读扫描', () => {
  it('只返回超时/撤销证据，不改 lease、不建 claim、不生成第二调度动作', async () => {
    if (!enabled) return
    const before = rawRows(await db.execute(sql`SELECT lease_id AS id, status FROM st_runtime_leases WHERE tenant_id=${tenantId} ORDER BY lease_id`))
    const claimsBefore = Number(rawRows(await db.execute(sql`SELECT COUNT(*) AS n FROM st_runtime_outbox_claims`))[0].n)
    const executionBefore = Number(rawRows(await db.execute(sql`SELECT COUNT(*) AS n FROM st_runtime_execution_evidence`))[0].n)
    const evidence = await runRuntimeWatchdogMysqlOnce({ db, tenantId, now: '2026-11-05T01:00:00Z', heartbeatTimeoutMs: 1000 })
    expect(evidence.map((item) => item.classification)).toEqual(['lease_revoked', 'stuck'])
    expect(evidence.every((item) => item.readOnly && !item.mutatesCanonicalState && item.repairChannel === 'backend_state_machine')).toBe(true)
    const after = rawRows(await db.execute(sql`SELECT lease_id AS id, status FROM st_runtime_leases WHERE tenant_id=${tenantId} ORDER BY lease_id`))
    expect(after).toEqual(before)
    expect(Number(rawRows(await db.execute(sql`SELECT COUNT(*) AS n FROM st_runtime_outbox_claims`))[0].n)).toBe(claimsBefore)
    expect(Number(rawRows(await db.execute(sql`SELECT COUNT(*) AS n FROM st_runtime_execution_evidence`))[0].n)).toBe(executionBefore)
  })
})
