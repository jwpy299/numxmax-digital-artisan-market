import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const createConnection = vi.hoisted(() => vi.fn())
vi.mock('mysql2/promise', () => ({ default: { createConnection } }))
vi.mock('../queries/connection', () => ({ getDb: () => ({ execute: vi.fn() }) }))
import { writeAdminAuditResult } from './adminAnalytics'

interface FakeConnection {
  query: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}
function connection(queryImpl: (sql: string) => Promise<unknown>): FakeConnection {
  return { query: vi.fn(queryImpl), end: vi.fn(async () => undefined), destroy: vi.fn() }
}
beforeEach(() => {
  createConnection.mockReset()
  process.env.DATABASE_URL = 'mysql://isolated-test.invalid/audit'
  process.env.ADMIN_AUDIT_TIMEOUT_MS = '15'
})
afterEach(() => {
  delete process.env.DATABASE_URL
  delete process.env.ADMIN_AUDIT_TIMEOUT_MS
})

describe('admin audit 独立连接与超时取消', () => {
  it('第二个连接失败也释放第一个连接', async () => {
    const first = connection(async () => [])
    createConnection.mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('max_connections'))
    await expect(writeAdminAuditResult(1, 'admin', 'test', 'target')).resolves.toBe('failed')
    expect(first.end).toHaveBeenCalledTimes(1)
    expect(first.destroy).toHaveBeenCalledTimes(1)
  })

  it('INSERT 卡死时从独立连接 KILL QUERY，并收敛两端资源', async () => {
    const writer = connection(async (sql) => {
      if (sql === 'SELECT CONNECTION_ID() AS id') return [[{ id: 42 }]]
      return new Promise(() => undefined)
    })
    const killer = connection(async () => [])
    createConnection.mockResolvedValueOnce(writer).mockResolvedValueOnce(killer)
    await expect(writeAdminAuditResult(1, 'admin', 'test', 'target')).resolves.toBe('timeout')
    expect(killer.query).toHaveBeenCalledWith('KILL QUERY 42')
    expect(writer.destroy).toHaveBeenCalled()
    expect(killer.destroy).toHaveBeenCalled()
  })

  it('正常写入返回 written，不误发 KILL', async () => {
    const writer = connection(async (sql) => sql === 'SELECT CONNECTION_ID() AS id' ? [[{ id: 43 }]] : [])
    const killer = connection(async () => [])
    createConnection.mockResolvedValueOnce(writer).mockResolvedValueOnce(killer)
    await expect(writeAdminAuditResult(1, 'admin', 'test', 'target')).resolves.toBe('written')
    expect(killer.query).not.toHaveBeenCalledWith('KILL QUERY 43')
  })
  it('循环引用与 BigInt 详情不击穿审计进程，按 written/failed/timeout 收敛', async () => {
    const writer = connection(async (sql) => sql === 'SELECT CONNECTION_ID() AS id' ? [[{ id: 44 }]] : [])
    const killer = connection(async () => [])
    createConnection.mockResolvedValueOnce(writer).mockResolvedValueOnce(killer)
    const circular: Record<string, unknown> = {}; circular.self = circular
    await expect(writeAdminAuditResult(1, 'admin', 'test', 'target', circular)).resolves.toBe('written')
    await expect(writeAdminAuditResult(1, 'admin', 'test', 'target', { amount: 1n })).resolves.toBe('written')
  })
})
