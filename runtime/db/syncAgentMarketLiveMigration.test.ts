import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.hoisted(() => vi.fn())
const end = vi.hoisted(() => vi.fn())
const createConnection = vi.hoisted(() => vi.fn())
vi.mock('mysql2/promise', () => ({ default: { createConnection } }))

const originalArgv = process.argv

async function runMigration(registrationColumns: string[]) {
  query.mockReset()
  end.mockReset()
  query.mockImplementation(async (statement: string) => {
    if (statement.includes('SELECT DATABASE()')) return [[{ name: 'numx_agent_employment_test_mock' }]]
    if (statement.includes("table_name='st_agent_registrations'")) return [registrationColumns.map((name) => ({ COLUMN_NAME: name }))]
    if (statement.includes("table_name='st_agent_work_tasks'") && statement.includes('information_schema.columns')) {
      return [[{ COLUMN_NAME: 'public_feed' }, { COLUMN_NAME: 'public_actor_name' }]]
    }
    if (statement.includes('information_schema.statistics')) return [[{ INDEX_NAME: 'idx_agent_work_public_feed' }]]
    return [[]]
  })
  createConnection.mockResolvedValue({ query, end })
  vi.resetModules()
  await import('./sync-agent-market-live.mts')
  return query.mock.calls.map(([statement]) => String(statement))
}

describe('Agent 市场公开字段 additive migration', () => {
  beforeEach(() => {
    process.argv = [originalArgv[0], originalArgv[1]]
    vi.stubEnv('DATABASE_URL', 'mysql://test:test@127.0.0.1/numx_agent_employment_test_mock')
    vi.stubEnv('ECONOMY_MODE', 'test')
    vi.stubEnv('AGENT_EMPLOYMENT_TEST_DATABASE', '1')
    vi.stubEnv('NODE_ENV', 'test')
  })
  afterEach(() => {
    process.argv = originalArgv
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('两个公开字段都缺失时各补一次，不用旧空结果重复补首列', async () => {
    const statements = await runMigration([])
    const registrationAlters = statements.filter((statement) => statement.startsWith('ALTER TABLE st_agent_registrations ADD COLUMN'))
    expect(registrationAlters).toHaveLength(2)
    expect(registrationAlters.filter((statement) => statement.includes('showcase_opt_in'))).toHaveLength(1)
    expect(registrationAlters.filter((statement) => statement.includes('public_display_name'))).toHaveLength(1)
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('两个公开字段已存在时不重复写 schema', async () => {
    const statements = await runMigration(['showcase_opt_in', 'public_display_name'])
    expect(statements.filter((statement) => statement.startsWith('ALTER TABLE st_agent_registrations ADD COLUMN'))).toHaveLength(0)
  })
})
