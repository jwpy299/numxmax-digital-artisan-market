import { sql } from 'drizzle-orm'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { assertRuntimePluginGrant, type RuntimePluginGrant } from './runtimePluginGrant'
import { getCachedAgentPluginVerification, verifyAndCacheAgentPluginPackage } from './agentPluginVerification'
import { RuntimeLeaseFenceError } from './runtimeLeaseFence'
import { readTrustedAgentPluginPublicKeys } from './agentPluginTrust'
import { toRuntimeUtcIso } from './runtimeOutboxMysql'

/** 只从 canonical MySQL 构造 grant；浏览器/事件包不得直接提交权限。 */
export async function readRuntimePluginGrant(args: { registrationId: number; packageId: number; factoryId: number }, db = getDb()): Promise<RuntimePluginGrant> {
  const row = rawRows(await db.execute(sql`
    SELECT i.registration_id AS registrationId, i.factory_id AS factoryId, u.departmentId AS departmentId, p.package_key AS packageKey,
           i.version, i.install_ticket AS installTicket, p.artifact_sha256 AS artifactSha256, i.status,
           p.manifest_json AS manifestJson, p.signature, p.signer_public_key AS signerPublicKey, e.status AS entitlementStatus, e.expires_at AS expiresAt
    FROM st_agent_plugin_installs i
    JOIN st_agent_plugin_packages p ON p.id=i.package_id AND p.status='active'
    JOIN st_agent_registrations r ON r.id=i.registration_id AND r.status='qualified'
    JOIN wb_users u ON u.id=r.owner_user_id AND u.factoryId=i.factory_id
    JOIN st_agent_plugin_entitlements e ON e.registration_id=i.registration_id AND e.package_id=i.package_id AND e.factory_id=i.factory_id
    WHERE i.registration_id=${args.registrationId} AND i.package_id=${args.packageId} AND i.factory_id=${args.factoryId}
      AND i.status='installed'
    ORDER BY i.id DESC LIMIT 1`))[0]
  if (!row) throw new RuntimeLeaseFenceError('runtime_plugin_grant_inactive')
  let trusted: string[]
  try { trusted = readTrustedAgentPluginPublicKeys() } catch { throw new RuntimeLeaseFenceError('runtime_plugin_trust_config_invalid') }
  const trustedKey = trusted.find((key) => key === String(row.signerPublicKey))
  if (!trustedKey) throw new RuntimeLeaseFenceError('runtime_plugin_signer_mismatch')
  const expected = { signerPublicKey: trustedKey, signature: String(row.signature), artifactSha256: String(row.artifactSha256) }
  let verification = getCachedAgentPluginVerification(expected.artifactSha256, expected)
  if (!verification) {
    const artifact = rawRows(await db.execute(sql`SELECT artifact_blob AS artifactBlob FROM st_agent_plugin_packages WHERE id=${Number(args.packageId)} AND artifact_sha256=${expected.artifactSha256} LIMIT 1`))[0]
    if (!artifact) throw new RuntimeLeaseFenceError('runtime_plugin_artifact_missing')
    try { verification = await verifyAndCacheAgentPluginPackage(Buffer.from(artifact.artifactBlob as Buffer), expected) }
    catch { throw new RuntimeLeaseFenceError('runtime_plugin_verification_failed') }
  }
  if (verification.manifest.id !== String(row.packageKey) || verification.manifest.version !== String(row.version)) throw new RuntimeLeaseFenceError('runtime_plugin_package_identity_mismatch')
  const departmentId = String(row.departmentId ?? '').trim()
  if (!departmentId) throw new RuntimeLeaseFenceError('runtime_plugin_owner_department_missing')
  let expiresAt: string | null = null
  try { expiresAt = toRuntimeUtcIso(row.expiresAt) ?? null } catch { throw new RuntimeLeaseFenceError('runtime_plugin_entitlement_expiry_invalid') }
  const grant: RuntimePluginGrant = {
    registrationId: Number(row.registrationId),
    factoryId: Number(row.factoryId),
    tenantId: `factory:${Number(row.factoryId)}`,
    departmentId,
    packageKey: verification.manifest.id,
    version: verification.manifest.version,
    installTicket: String(row.installTicket),
    artifactSha256: String(row.artifactSha256),
    status: 'installed',
    permissions: [...verification.manifest.permissions] as RuntimePluginGrant['permissions'],
    entitlementStatus: String(row.entitlementStatus) as RuntimePluginGrant['entitlementStatus'],
    expiresAt,
  }
  assertRuntimePluginGrant(grant)
  return grant
}
