import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })
const GATE_TEST_TIMEOUT = 20000
function fakeDb(results: unknown[]) {
  return { execute: vi.fn(async () => results.shift()) }
}
async function gate() {
  vi.resetModules()
  vi.stubEnv('ECONOMY_MODE', 'production')
  return (await import('./agentEmployment')).assertAgentEmploymentSchemaReady
}

describe('个人 Agent 公开 Feed schema gate', () => {
  it('缺公开审计表时在业务 SQL 前 fail-closed', async () => {
    const assertReady = await gate()
    const db = fakeDb([[[{ count: 12 }]]])
    await expect(assertReady(db as never)).rejects.toThrow('agent_employment_schema_not_ready')
    expect(db.execute).toHaveBeenCalledTimes(1)
  }, GATE_TEST_TIMEOUT)
  it('缺 public_feed/public_actor_name 任一列时明确拒绝', async () => {
    const assertReady = await gate()
    const db = fakeDb([[[{ count: 14 }]], [[{ count: 18 }]]])
    await expect(assertReady(db as never)).rejects.toThrow('agent_employment_schema_columns_not_ready')
    expect(db.execute).toHaveBeenCalledTimes(2)
  }, GATE_TEST_TIMEOUT)
  it('公开 Feed 复合索引缺失时明确拒绝', async () => {
    const assertReady = await gate()
    const db = fakeDb([[[{ count: 14 }]], [[{ count: 20 }]], [[{ count: 1 }]], [[{ count: 0 }]]])
    await expect(assertReady(db as never)).rejects.toThrow('agent_employment_schema_index_not_ready')
    expect(db.execute).toHaveBeenCalledTimes(4)
  }, GATE_TEST_TIMEOUT)
  it('新表、两列和两类索引齐备才放行', async () => {
    const assertReady = await gate()
    const db = fakeDb([[[{ count: 14 }]], [[{ count: 20 }]], [[{ count: 1 }]], [[{ count: 1 }]]])
    await expect(assertReady(db as never)).resolves.toBeUndefined()
    expect(db.execute).toHaveBeenCalledTimes(4)
  }, GATE_TEST_TIMEOUT)
})
