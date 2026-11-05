import { getDb } from '../queries/connection'
import { readRuntimePluginGrant } from './runtimePluginGrantMysql'
import { createRuntimePluginEventAuthorizer, type RuntimePluginPermission } from './runtimePluginGrant'
import { executeRuntimeOutboxEvent, type RuntimeExecutionEvidence, type RuntimeExecutorResult, type RuntimeOutboxEvidenceStore } from './runtimeOutboxExecutor'
import type { RuntimeLeaseContext } from './runtimeLeaseFence'

/** dispatch 唯一插件执行入口：canonical grant → mandatory authorizer → outbox。 */
export async function executeCanonicalPluginOutboxEvent(args: {
  value: unknown
  registrationId: number
  packageId: number
  factoryId: number
  action: RuntimePluginPermission
  readLease: () => Promise<RuntimeLeaseContext>
  store: RuntimeOutboxEvidenceStore
  executor: (event: Parameters<RuntimeOutboxEvidenceStore['claim']>[0]) => Promise<RuntimeExecutorResult>
  db?: ReturnType<typeof getDb>
}): Promise<RuntimeExecutionEvidence | { status: 'duplicate'; delivered: false }> {
  const grant = await readRuntimePluginGrant({ registrationId: args.registrationId, packageId: args.packageId, factoryId: args.factoryId }, args.db)
  const authorize = createRuntimePluginEventAuthorizer(grant, args.action)
  return executeRuntimeOutboxEvent(args.value, args.readLease, args.store, args.executor, authorize)
}
