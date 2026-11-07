import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const createConnection = vi.hoisted(() => vi.fn())
vi.mock('mysql2/promise', () => ({ default: { createConnection } }))
vi.mock('../queries/connection', () => ({ getDb: () => ({ execute: vi.fn() }), getProbeConnectionUrl: (ms: number) => `mysql://isolated-test.invalid/audit?connectTimeout=${ms}` }))
vi.mock('../lib/env', () => ({ env: { get databaseUrl() { return process.env.DATABASE_URL ?? '' } } }))
import { writeAdminAuditResult, __resetAdminAuditInFlightForTest } from './adminAnalytics'

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
  __resetAdminAuditInFlightForTest()
  process.env.DATABASE_URL = 'mysql://isolated-test.invalid/audit'
  process.env.ADMIN_AUDIT_TIMEOUT_MS = '15'
})
afterEach(() => {
  delete process.env.DATABASE_URL
  delete process.env.ADMIN_AUDIT_TIMEOUT_MS
})

describe('admin audit 独立连接与超时取消', () => {
  it('killer 建立失败不影响正常写入与主连接释放', async () => {
    const first = connection(async (sql) => sql === 'SELECT CONNECTION_ID() AS id' ? [[{ id: 41 }]] : [])
    createConnection.mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('max_connections'))
    await expect(writeAdminAuditResult(1, 'admin', 'test', 'target')).resolves.toBe('written')
    expect(first.end).toHaveBeenCalledTimes(1)
    expect(first.destroy).toHaveBeenCalledTimes(1)
    expect(createConnection).toHaveBeenCalledTimes(1)
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
    expect(createConnection).toHaveBeenCalledTimes(1)
  })
  it('正常写入后 end/destroy 同步抛错仍返回 written', async () => {
    const writer = connection(async (sql) => sql === 'SELECT CONNECTION_ID() AS id' ? [[{ id: 45 }]] : [])
    const killer = connection(async () => [])
    writer.end.mockImplementation(() => { throw new Error('end_failed') })
    writer.destroy.mockImplementation(() => { throw new Error('destroy_failed') })
    killer.destroy.mockImplementation(() => { throw new Error('destroy_failed') })
    createConnection.mockResolvedValueOnce(writer).mockResolvedValueOnce(killer)
    await expect(writeAdminAuditResult(1, 'admin', 'test', 'target')).resolves.toBe('written')
  })
  it('超时 cancel/close 的 destroy 同步抛错仍返回 timeout', async () => {
    const writer = connection(async (sql) => {
      if (sql === 'SELECT CONNECTION_ID() AS id') return [[{ id: 46 }]]
      return new Promise(() => undefined)
    })
    const killer = connection(async () => [])
    writer.destroy.mockImplementation(() => { throw new Error('destroy_failed') })
    killer.destroy.mockImplementation(() => { throw new Error('destroy_failed') })
    createConnection.mockResolvedValueOnce(writer).mockResolvedValueOnce(killer)
    await expect(writeAdminAuditResult(1, 'admin', 'test', 'target')).resolves.toBe('timeout')
  })
  it('循环引用与 BigInt 详情不击穿审计进程，按 written/failed/timeout 收敛', async () => {
    const writer = connection(async (sql) => sql === 'SELECT CONNECTION_ID() AS id' ? [[{ id: 44 }]] : [])
    const killer = connection(async () => [])
    createConnection.mockResolvedValue(writer)
    const circular: Record<string, unknown> = {}; circular.self = circular
    await expect(writeAdminAuditResult(1, 'admin', 'test', 'target', circular)).resolves.toBe('written')
    await expect(writeAdminAuditResult(1, 'admin', 'test', 'target', { amount: 1n })).resolves.toBe('written')
  })

  it('超过 4 个在飞审计时快速失败，不继续创建连接', async () => {
    const writer = connection(async (sql) => sql === 'SELECT CONNECTION_ID() AS id' ? [[{ id: 50 }]] : new Promise(() => undefined))
    createConnection.mockResolvedValue(writer)
    const firstFour = Array.from({ length: 4 }, (_, index) => writeAdminAuditResult(1, 'admin', `pending-${index}`, 'target'))
    const fifth = await writeAdminAuditResult(1, 'admin', 'overflow', 'target')
    expect(fifth).toBe('failed')
    expect(createConnection).toHaveBeenCalledTimes(4)
    await expect(Promise.all(firstFour)).resolves.toEqual(['timeout', 'timeout', 'timeout', 'timeout'])
  })

})
