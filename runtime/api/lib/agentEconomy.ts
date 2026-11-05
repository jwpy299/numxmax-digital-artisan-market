export type AgentEconomyMode = 'production' | 'test'

export const AGENT_TEST_DATABASE_PREFIX = 'numx_agent_employment_test_'

export function agentEconomyMode(): AgentEconomyMode {
  const value = (process.env.ECONOMY_MODE ?? 'production').trim()
  if (value !== 'production' && value !== 'test') throw new Error('ECONOMY_MODE_INVALID')
  return value
}

export function isAgentTestEconomy(): boolean {
  return agentEconomyMode() === 'test'
}

/** 启动期硬边界：test 只允许显式非生产、独立测试库；生产默认人民币且禁止 test。 */
export function assertAgentEconomyBootMode(): void {
  const mode = agentEconomyMode()
  if (mode === 'test' && process.env.NODE_ENV === 'production') throw new Error('ECONOMY_MODE_TEST_FORBIDDEN_IN_PRODUCTION')
  if (mode === 'test' && process.env.AGENT_EMPLOYMENT_TEST_DATABASE !== '1') throw new Error('AGENT_EMPLOYMENT_TEST_DATABASE_REQUIRED')
}

export function assertAgentTestDatabase(): void {
  if (!isAgentTestEconomy()) throw new Error('AGENT_TEST_ECONOMY_REQUIRED')
  if (process.env.AGENT_EMPLOYMENT_TEST_DATABASE !== '1') throw new Error('AGENT_EMPLOYMENT_TEST_DATABASE_REQUIRED')
}

/** 运行时的真实库身份必须与迁移闸使用同一前缀；布尔 flag 不能替代数据库回读。 */
export function assertAgentTestDatabaseName(databaseName: unknown): void {
  assertAgentTestDatabase()
  if (typeof databaseName !== 'string' || !databaseName.startsWith(AGENT_TEST_DATABASE_PREFIX)) {
    throw new Error('AGENT_EMPLOYMENT_TEST_DATABASE_NAME_MISMATCH')
  }
}

/** 隔离预览开关：空值关闭，1/true/yes 开启，其他值 fail-closed，不静默丢监听。 */
export function agentTestPreviewFlag(value = process.env.AGENT_EMPLOYMENT_TEST_PREVIEW): boolean {
  const normalized = value?.trim().toLowerCase() ?? ''
  if (!normalized) return false
  if (!['1', 'true', 'yes'].includes(normalized)) throw new Error('AGENT_EMPLOYMENT_TEST_PREVIEW_INVALID')
  return true
}
