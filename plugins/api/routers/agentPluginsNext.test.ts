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
  ownerFactoryId = Number(owner.factoryId)
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


describe('Agent 插件同版本回滚与验签错误码', () => {
  it('当前版本不能作为回滚目标，验签失败返回 FORBIDDEN 而非 500', async () => {
    if (!enabled) return
    await caller.install({ token: ownerToken, registrationId, packageId: packageV2 })
    await expect(caller.rollback({ token: ownerToken, registrationId, packageId: packageV2 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const original = rawRows(await db.execute(sql`SELECT artifact_sha256 AS artifactSha256, artifact_blob AS artifactBlob FROM st_agent_plugin_packages WHERE id=${packageV1}`))[0]
    try {
      await db.execute(sql`UPDATE st_agent_plugin_packages SET artifact_sha256=SHA2('tampered-plugin', 256), artifact_blob=FROM_BASE64('YnJva2Vu') WHERE id=${packageV1}`)
      await expect(caller.install({ token: ownerToken, registrationId, packageId: packageV1 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    } finally {
      await db.execute(sql`UPDATE st_agent_plugin_packages SET artifact_sha256=${String(original.artifactSha256)}, artifact_blob=FROM_BASE64(${Buffer.from(original.artifactBlob as Buffer).toString('base64')}) WHERE id=${packageV1}`)
    }
  })
  it('目录包名或版本被独立篡改时，签名清单身份不一致必须拒绝安装', async () => {
    if (!enabled) return
    const original = rawRows(await db.execute(sql`SELECT version FROM st_agent_plugin_packages WHERE id=${packageV1}`))[0]
    try {
      await db.execute(sql`UPDATE st_agent_plugin_packages SET version='9.9.9' WHERE id=${packageV1}`)
      await expect(caller.install({ token: ownerToken, registrationId, packageId: packageV1 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    } finally {
      await db.execute(sql`UPDATE st_agent_plugin_packages SET version=${String(original.version)} WHERE id=${packageV1}`)
    }
  })

  it('下载时即使命中验签缓存，实际 blob 被换也必须拒绝', async () => {
    if (!enabled) return
    const original = rawRows(await db.execute(sql`SELECT artifact_blob AS artifactBlob FROM st_agent_plugin_packages WHERE id=${packageV1}`))[0]
    await caller.download({ token: ownerToken, registrationId, packageId: packageV1 })
    const replacement = makeSignedAgentPluginPackage({ id: 'agent.tasks', name: 'Agent 任务插件', version: '1.0.0', entryCode: 'export const replaced = true', permissions: ['tasks:read'], privateKey: privateDer, publicKey: publicDer })
    try {
      await db.execute(sql`UPDATE st_agent_plugin_packages SET artifact_blob=FROM_BASE64(${replacement.toString('base64')}) WHERE id=${packageV1}`)
      await expect(caller.download({ token: ownerToken, registrationId, packageId: packageV1 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    } finally {
      await db.execute(sql`UPDATE st_agent_plugin_packages SET artifact_blob=FROM_BASE64(${Buffer.from(original.artifactBlob as Buffer).toString('base64')}) WHERE id=${packageV1}`)
    }
  })

})
