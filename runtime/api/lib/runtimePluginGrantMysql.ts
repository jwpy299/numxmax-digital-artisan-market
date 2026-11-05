import { sql } from 'drizzle-orm'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { assertRuntimePluginGrant, type RuntimePluginGrant } from './runtimePluginGrant'
import { RuntimeLeaseFenceError } from './runtimeLeaseFence'

/** 只从 canonical MySQL 构造 grant；浏览器/事件包不得直接提交权限。 */
export async function readRuntimePluginGrant(args: { registrationId: number; packageId: number; factoryId: number }, db = getDb()): Promise<RuntimePluginGrant> {
  const row = rawRows(await db.execute(sql`
    SELECT i.registration_id AS registrationId, i.factory_id AS factoryId, u.departmentId AS departmentId, p.package_key AS packageKey,
           i.version, i.install_ticket AS installTicket, p.artifact_sha256 AS artifactSha256, i.status,
           p.manifest_json AS manifestJson, e.status AS entitlementStatus, e.expires_at AS expiresAt
    FROM st_agent_plugin_installs i
    JOIN st_agent_plugin_packages p ON p.id=i.package_id
    JOIN st_agent_registrations r ON r.id=i.registration_id
    JOIN wb_users u ON u.id=r.owner_user_id
    JOIN st_agent_plugin_entitlements e ON e.registration_id=i.registration_id AND e.package_id=i.package_id AND e.factory_id=i.factory_id
    WHERE i.registration_id=${args.registrationId} AND i.package_id=${args.packageId} AND i.factory_id=${args.factoryId}
      AND i.status='installed'
    ORDER BY i.id DESC LIMIT 1`))[0]
  if (!row) throw new RuntimeLeaseFenceError('runtime_plugin_grant_inactive')
  const manifest = (typeof row.manifestJson === 'string' ? JSON.parse(row.manifestJson) : row.manifestJson) as { permissions?: RuntimePluginGrant['permissions'] }
  const grant: RuntimePluginGrant = {
    registrationId: Number(row.registrationId),
    factoryId: Number(row.factoryId),
    tenantId: `factory:${Number(row.factoryId)}`,
    departmentId: String(row.departmentId ?? ''),
    packageKey: String(row.packageKey),
    version: String(row.version),
    installTicket: String(row.installTicket),
    artifactSha256: String(row.artifactSha256),
    status: 'installed',
    permissions: manifest.permissions ?? [],
    entitlementStatus: String(row.entitlementStatus) as RuntimePluginGrant['entitlementStatus'],
    expiresAt: row.expiresAt ? String(row.expiresAt) : null,
  }
  assertRuntimePluginGrant(grant)
  return grant
}
