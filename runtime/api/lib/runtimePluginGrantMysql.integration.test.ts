import { beforeAll, describe, expect, it } from 'vitest'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { AGENT_TEST_DATABASE_PREFIX } from './agentEconomy'
import { makeSignedAgentPluginPackage } from './agentPluginTestPackage'
import { verifyAgentPluginPackage } from './agentPluginManifest'
import { readRuntimePluginGrant } from './runtimePluginGrantMysql'

const enabled = process.env.AGENT_EMPLOYMENT_MYSQL_TEST === '1'
const db = enabled ? getDb() : (undefined as unknown as ReturnType<typeof getDb>)
let registrationId = 0
let packageId = 0
let factoryId = 1
const packageKey = `agent.governance.${randomBytes(3).toString('hex')}`

beforeAll(async () => {
  if (!enabled) return
  const database = rawRows(await db.execute(sql`SELECT DATABASE() AS name`))[0]
  if (!String(database?.name ?? '').startsWith(AGENT_TEST_DATABASE_PREFIX)) throw new Error('RUNTIME_GRANT_TEST_DATABASE_REQUIRED')
  const owner = rawRows(await db.execute(sql`SELECT id, factoryId FROM wb_users WHERE id=1 LIMIT 1`))[0]
  if (!owner) throw new Error('grant owner fixture missing')
  factoryId = Number(owner.factoryId)
  const registrationNo = `AR_grant_${randomBytes(6).toString('hex')}`
  const inserted = await db.execute(sql`INSERT INTO st_agent_registrations (registration_no, agent_key, owner_user_id, agent_name, status, fee_status, current_attempt_no, idempotency_key, qualified_at) VALUES (${registrationNo}, ${`agent_grant_${randomBytes(6).toString('hex')}`}, ${Number(owner.id)}, '授权运行时Agent', 'qualified', 'refunded', 1, ${`reg-${randomBytes(6).toString('hex')}`}, NOW())`)
  registrationId = Number((Array.isArray(inserted) ? inserted[0] : inserted as { insertId?: number })?.insertId ?? 0)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  const publicDer = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const artifact = makeSignedAgentPluginPackage({ id: packageKey, name: '治理授权插件', version: '1.0.0', entryCode: 'export const grant = true', permissions: ['tasks:read'], privateKey: privateDer, publicKey: publicDer })
  const verified = verifyAgentPluginPackage(artifact)
  const insertedPackage = await db.execute(sql`INSERT INTO st_agent_plugin_packages (package_key, name, version, description, manifest_json, artifact_sha256, signature, signer_public_key, artifact_blob) VALUES (${packageKey}, '治理授权插件', '1.0.0', '真实签名授权制品', ${JSON.stringify(verified.manifest)}, ${verified.artifactSha256}, ${verified.manifest.signature}, ${publicDer}, FROM_BASE64(${artifact.toString('base64')}))`)
  packageId = Number((Array.isArray(insertedPackage) ? insertedPackage[0] : insertedPackage as { insertId?: number })?.insertId ?? 0)
  await db.execute(sql`INSERT INTO st_agent_plugin_entitlements (registration_id, package_id, factory_id, status) VALUES (${registrationId}, ${packageId}, ${factoryId}, 'active')`)
  await db.execute(sql`INSERT INTO st_agent_plugin_installs (registration_id, package_id, factory_id, version, status, install_ticket, installed_at, last_readback_at) VALUES (${registrationId}, ${packageId}, ${factoryId}, '1.0.0', 'installed', ${`pt_${randomBytes(24).toString('hex')}`}, NOW(), NOW())`)
})

describe('canonical runtime plugin grant MySQL', () => {
  it('有效票据可构造 grant；跨企业、过期和卸载全部拒绝', async () => {
    if (!enabled) return
    const grant = await readRuntimePluginGrant({ registrationId, packageId, factoryId }, db)
    expect(grant).toMatchObject({ registrationId, factoryId, tenantId: `factory:${factoryId}`, departmentId: 'dept-a', packageKey, status: 'installed', entitlementStatus: 'active', permissions: ['tasks:read'] })
    await expect(readRuntimePluginGrant({ registrationId, packageId, factoryId: 999 }, db)).rejects.toThrow('runtime_plugin_grant_inactive')
    await db.execute(sql`UPDATE st_agent_plugin_entitlements SET expires_at=DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE registration_id=${registrationId} AND package_id=${packageId} AND factory_id=${factoryId}`)
    await expect(readRuntimePluginGrant({ registrationId, packageId, factoryId }, db)).rejects.toThrow('runtime_plugin_entitlement_expired')
    await db.execute(sql`UPDATE st_agent_plugin_entitlements SET expires_at=NULL WHERE registration_id=${registrationId} AND package_id=${packageId} AND factory_id=${factoryId}`)
    await db.execute(sql`UPDATE st_agent_plugin_installs SET status='uninstalled' WHERE registration_id=${registrationId} AND package_id=${packageId} AND factory_id=${factoryId}`)
    await expect(readRuntimePluginGrant({ registrationId, packageId, factoryId }, db)).rejects.toThrow('runtime_plugin_grant_inactive')
  })
})
