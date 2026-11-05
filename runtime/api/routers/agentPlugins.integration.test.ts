/** 真实 MySQL Agent 插件验签、权益、安装、下载与回滚验证；默认跳过，只在隔离库运行。 */
import { beforeAll, describe, expect, it } from 'vitest'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { authTokenHash } from '../auth/revocation'
import { agentPluginsRouter } from './agentPlugins'
import { makeSignedAgentPluginPackage } from '../lib/agentPluginTestPackage'
import { AGENT_TEST_DATABASE_PREFIX } from '../lib/agentEconomy'

const enabled = process.env.AGENT_EMPLOYMENT_MYSQL_TEST === '1'
const db = enabled ? getDb() : (undefined as unknown as ReturnType<typeof getDb>)
const caller = agentPluginsRouter.createCaller({ clientIp: '127.0.0.1' } as never)
const ownerToken = `nt_plugin_owner_${randomBytes(12).toString('hex')}`
const otherToken = `nt_plugin_other_${randomBytes(12).toString('hex')}`
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
const publicDer = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
let registrationId = 0
let otherRegistrationId = 0
let packageV1 = 0
let packageV2 = 0
let ownerFactoryId = 0

async function seedPackage(version: string): Promise<number> {
  const artifact = makeSignedAgentPluginPackage({ id: 'agent.tasks', name: 'Agent 任务插件', version, entryCode: `export const version = '${version}'`, permissions: ['tasks:read'], privateKey: privateDer, publicKey: publicDer })
  const manifest = (await import('../lib/agentPluginManifest')).verifyAgentPluginPackage(artifact)
  const result = await db.execute(sql`INSERT INTO st_agent_plugin_packages
    (package_key, name, version, description, manifest_json, artifact_sha256, signature, signer_public_key, artifact_blob)
    VALUES ('agent.tasks', 'Agent 任务插件', ${version}, '真实签名任务插件', ${JSON.stringify(manifest.manifest)}, ${manifest.artifactSha256}, ${manifest.manifest.signature}, ${publicDer}, FROM_BASE64(${artifact.toString('base64')}))`)
  return Number((Array.isArray(result) ? result[0] : result as { insertId?: number })?.insertId ?? 0)
}

beforeAll(async () => {
  if (!enabled) return
  const database = rawRows(await db.execute(sql`SELECT DATABASE() AS name`))[0]
  if (!String(database?.name ?? '').startsWith(AGENT_TEST_DATABASE_PREFIX)) throw new Error('AGENT_PLUGINS_TEST_DATABASE_REQUIRED')
  process.env.AGENT_PLUGIN_TRUSTED_PUBLIC_KEY = publicDer
  await db.execute(sql`DELETE i FROM st_agent_plugin_installs i JOIN st_agent_plugin_packages p ON p.id=i.package_id WHERE p.package_key='agent.tasks'`)
  await db.execute(sql`DELETE e FROM st_agent_plugin_entitlements e JOIN st_agent_plugin_packages p ON p.id=e.package_id WHERE p.package_key='agent.tasks'`)
  await db.execute(sql`DELETE FROM st_agent_plugin_packages WHERE package_key='agent.tasks'`)
  const owner = rawRows(await db.execute(sql`SELECT id, factoryId FROM wb_users WHERE role IN ('member','owner') ORDER BY id LIMIT 1`))[0]
  const other = rawRows(await db.execute(sql`SELECT id FROM wb_users WHERE role IN ('member','owner') ORDER BY id DESC LIMIT 1`))[0]
  await db.execute(sql`UPDATE wb_users SET authToken=${authTokenHash(ownerToken)} WHERE id=${Number(owner.id)}`)
  await db.execute(sql`UPDATE wb_users SET authToken=${authTokenHash(otherToken)} WHERE id=${Number(other.id)}`)
  for (const [index, ownerId] of [Number(owner.id), Number(other.id)].entries()) {
    const registrationNo = `AR_plugin_${index}_${randomBytes(5).toString('hex')}`
    const inserted = await db.execute(sql`INSERT INTO st_agent_registrations
      (registration_no, agent_key, owner_user_id, agent_name, status, fee_status, current_attempt_no, idempotency_key, qualified_at)
      VALUES (${registrationNo}, ${`agent_plugin_${randomBytes(6).toString('hex')}`}, ${ownerId}, '插件Agent', 'qualified', 'refunded', 1, ${`reg-${randomBytes(6).toString('hex')}`}, NOW())`)
    const id = Number((Array.isArray(inserted) ? inserted[0] : inserted as { insertId?: number })?.insertId ?? 0)
    if (index === 0) registrationId = id
    else otherRegistrationId = id
  }
  packageV1 = await seedPackage('1.0.0')
  packageV2 = await seedPackage('1.1.0')
  const trustRows = rawRows(await db.execute(sql`SELECT signer_public_key AS signerPublicKey FROM st_agent_plugin_packages WHERE status='active'`))
  process.env.AGENT_PLUGIN_TRUSTED_PUBLIC_KEYS = JSON.stringify([...new Set([...trustRows.map((row) => String(row.signerPublicKey)), publicDer])])
  await db.execute(sql`INSERT INTO st_agent_plugin_entitlements (registration_id, package_id, factory_id, status) VALUES (${registrationId}, ${packageV1}, ${Number(owner.factoryId)}, 'active'), (${registrationId}, ${packageV2}, ${Number(owner.factoryId)}, 'active')`)
})

describe('Agent 插件工作台', () => {
  it('验签安装、幂等回执、真实下载、卸载与回滚', async () => {
    if (!enabled) return
    const listed = await caller.list()
    const listedTasks = listed.packages.filter((item) => item.packageKey === 'agent.tasks')
    expect(listedTasks).toHaveLength(2)
    expect(listedTasks[0]).toMatchObject({ signatureVerified: true })
    expect(listedTasks[0]?.manifest).toMatchObject({ entry: 'index.js', platform: 'linux', arch: 'x64', permissions: ['tasks:read'], dependencies: ['runtime:oap-v0'] })
    const first = await caller.install({ token: ownerToken, registrationId, packageId: packageV1 })
    const replay = await caller.install({ token: ownerToken, registrationId, packageId: packageV1 })
    expect(first.installTicket).toBe(replay.installTicket)
    expect(replay.already).toBe(true)
    expect((await caller.uninstall({ token: ownerToken, registrationId, packageId: packageV1 })).affectedRows).toBe(1)
    expect((await caller.uninstall({ token: ownerToken, registrationId, packageId: packageV1 })).already).toBe(true)
    const reinstalled = await caller.install({ token: ownerToken, registrationId, packageId: packageV1 })
    expect(reinstalled.installTicket).not.toBe(first.installTicket)
    const download = await caller.download({ token: ownerToken, registrationId, packageId: packageV1 })
    expect(Buffer.from(download.artifactBase64, 'base64')).toEqual(makeSignedAgentPluginPackage({ id: 'agent.tasks', name: 'Agent 任务插件', version: '1.0.0', entryCode: "export const version = '1.0.0'", permissions: ['tasks:read'], privateKey: privateDer, publicKey: publicDer }))
    expect(download.executable).toBe(false)
    expect((await caller.uninstall({ token: ownerToken, registrationId, packageId: packageV1 })).status).toBe('uninstalled')
    await caller.install({ token: ownerToken, registrationId, packageId: packageV2 })
    const rollback = await caller.rollback({ token: ownerToken, registrationId, packageId: packageV2 })
    expect(rollback.version).toBe('1.0.0')
    expect(rollback.rollbackOf).toBeGreaterThan(0)
    await caller.install({ token: ownerToken, registrationId, packageId: packageV2 })
    const rollbackAgain = await caller.rollback({ token: ownerToken, registrationId, packageId: packageV2 })
    expect(rollbackAgain.version).toBe('1.0.0')
    expect(rollbackAgain.installTicket).not.toBe(rollback.installTicket)
    const mine = await caller.mine({ token: ownerToken, registrationId })
    expect(mine.entitlements).toHaveLength(2)
    expect(mine.installs.some((item) => item.installTicket === rollbackAgain.installTicket && item.status === 'installed')).toBe(true)
    await db.execute(sql`UPDATE st_agent_plugin_entitlements SET factory_id=999 WHERE registration_id=${registrationId} AND package_id=${packageV1}`)
    await expect(caller.download({ token: ownerToken, registrationId, packageId: packageV1 })).rejects.toThrow()
    await db.execute(sql`UPDATE st_agent_plugin_entitlements SET factory_id=${ownerFactoryId} WHERE registration_id=${registrationId} AND package_id=${packageV1}`)
    await expect(caller.install({ token: otherToken, registrationId: otherRegistrationId, packageId: packageV1 })).rejects.toThrow()
  })
})
