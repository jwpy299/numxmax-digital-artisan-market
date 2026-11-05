import { sql } from 'drizzle-orm'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { assertAgentTestDatabaseName, isAgentTestEconomy } from './agentEconomy'

/** 启动期回读当前连接的真实 DATABASE()；生产默认模式不增加额外查询。 */
export async function assertAgentTestDatabaseConnection(): Promise<void> {
  if (!isAgentTestEconomy()) return
  const row = rawRows(await getDb().execute(sql`SELECT DATABASE() AS name`))[0]
  const databaseName = String(row?.name ?? '')
  assertAgentTestDatabaseName(databaseName)
  console.warn(`[agent-economy] isolated test database verified (${databaseName})`)
}
