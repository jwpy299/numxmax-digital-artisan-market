/** 真实 MySQL 审计超时验证；默认跳过，只在显式隔离库运行。 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import mysql from 'mysql2/promise'
import { randomBytes } from 'node:crypto'
import { writeAdminAuditResult } from './adminAnalytics'

const enabled = process.env.AGENT_EMPLOYMENT_MYSQL_TEST === '1'
const url = process.env.DATABASE_URL
const suffix = randomBytes(5).toString('hex')
let blocker: mysql.Connection | undefined

beforeAll(async () => {
  if (!enabled || !url) return
  blocker = await mysql.createConnection(url)
  await blocker.query(`CREATE TABLE IF NOT EXISTS st_admin_audit (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    admin_user_id BIGINT NOT NULL, admin_name VARCHAR(64) NOT NULL,
    action VARCHAR(64) NOT NULL, target VARCHAR(191) NOT NULL,
    detail_json TEXT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)
})
afterAll(async () => {
  if (blocker) { try { await blocker.query('UNLOCK TABLES') } catch { /* closed */ } await blocker.end() }
  delete process.env.ADMIN_AUDIT_TIMEOUT_MS
})

describe('admin audit 真实超时取消', () => {
  it('写锁阻塞 INSERT 时 timeout，KILL 后解锁也不得迟到写入', async () => {
    if (!enabled || !url || !blocker) return
    process.env.ADMIN_AUDIT_TIMEOUT_MS = '60'
    expect(await writeAdminAuditResult(1, 'audit-test', `audit-normal-${suffix}`, 'target')).toBe('written')
    await blocker.query('LOCK TABLES st_admin_audit WRITE')
    let outcome: string
    try { outcome = await writeAdminAuditResult(1, 'audit-test', `audit-blocked-${suffix}`, 'target') }
    finally { await blocker.query('UNLOCK TABLES') }
    expect(outcome!).toBe('timeout')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const [rows] = await blocker.query('SELECT action FROM st_admin_audit WHERE action LIKE ? ORDER BY id', [`audit-%-${suffix}`])
    expect((rows as { action: string }[]).map((row) => row.action)).toEqual([`audit-normal-${suffix}`])
  }, 10_000)
})
