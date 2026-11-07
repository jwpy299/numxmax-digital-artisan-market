import { createHash } from 'node:crypto'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import { createRouter, publicQuery } from '../middleware'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { isDupEntry } from '../queries/dupEntry'
import { sessionMe } from './wbSession'
import { getCachedAgentPluginVerification, verifyAndCacheAgentPluginPackage } from '../lib/agentPluginVerification'
import type { AgentPluginVerification } from '../lib/agentPluginManifest'
import { readTrustedAgentPluginPublicKeys } from '../lib/agentPluginTrust'

type Db = ReturnType<typeof getDb>
type DbExecutor = Pick<Db, 'execute'>
const registrationInput = z.object({ token: z.string().trim().min(1), registrationId: z.number().int().positive() })
const packageInput = registrationInput.extend({ packageId: z.number().int().positive() })

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function ticket(prefix: string, registrationId: number, packageId: number, version: string, artifactSha256: string): string {
  return `${prefix}_${hash(`${registrationId}|${packageId}|${version}|${artifactSha256}`).slice(0, 48)}`
}
async function nextTicket(db: DbExecutor, base: string, registrationId: number, packageId: number, version: string): Promise<string> {
  const row = rawRows(await db.execute(sql`SELECT COUNT(*) AS count FROM st_agent_plugin_installs WHERE registration_id=${registrationId} AND package_id=${packageId} AND version=${version} AND (install_ticket=${base} OR install_ticket LIKE ${`${base}_r%`})`))[0]
  const count = Number(row?.count ?? 0)
  return count === 0 ? base : `${base}_r${count}`
}
function trustedPublicKeys(): string[] {
  try { return readTrustedAgentPluginPublicKeys() } catch (error) {
    const missing = error instanceof Error && error.message === 'agent_plugin_trusted_key_missing'
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: missing ? '插件独立信任锚未配置，拒绝验签' : '插件信任公钥集合配置无效' })
  }
}
async function requireQualifiedRegistration(db: Db, registrationId: number, uid: number) {
  const row = rawRows(await db.execute(sql`SELECT owner_user_id AS ownerUserId, status FROM st_agent_registrations WHERE id=${registrationId} LIMIT 1`))[0]
  if (!row || Number(row.ownerUserId) !== uid || row.status !== 'qualified') throw new TRPCError({ code: 'FORBIDDEN', message: '仅训练达标 Agent 可安装插件' })
}
async function requireEntitlement(db: DbExecutor, registrationId: number, packageId: number, factoryId: number) {
  const row = rawRows(await db.execute(sql`SELECT status, expires_at AS expiresAt FROM st_agent_plugin_entitlements WHERE registration_id=${registrationId} AND package_id=${packageId} AND factory_id=${factoryId} LIMIT 1`))[0]
  if (!row || row.status !== 'active' || (row.expiresAt && new Date(String(row.expiresAt)).getTime() <= Date.now())) throw new TRPCError({ code: 'FORBIDDEN', message: '插件权益不存在、已撤销或已过期' })
}
export function assertVerifiedPackageIdentity(row: Record<string, unknown>, verification: AgentPluginVerification): void {
  if (verification.manifest.id !== String(row.packageKey) || verification.manifest.version !== String(row.version)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: '插件签名清单与目录包名或版本不一致' })
  }
}
async function packageArtifact(db: Db, packageId: number, version?: string, includeArtifact = false) {
  const row = rawRows(await db.execute(sql`SELECT id, package_key AS packageKey, name, version, description, price_cents AS priceCents, duration_days AS durationDays, manifest_json AS manifestJson, artifact_sha256 AS artifactSha256, signature, signer_public_key AS signerPublicKey, status, created_at AS createdAt FROM st_agent_plugin_packages WHERE id=${packageId} AND status='active' ${version ? sql`AND version=${version}` : sql``} LIMIT 1`))[0]
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: '插件包不存在或已下架' })
  const trusted = trustedPublicKeys().find((candidate) => candidate === String(row.signerPublicKey))
  if (!trusted) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '插件签名者不在独立信任公钥集合中' })
  const expected = { signerPublicKey: trusted, signature: String(row.signature), artifactSha256: String(row.artifactSha256) }
  const readBlob = async () => rawRows(await db.execute(sql`SELECT artifact_blob AS artifactBlob FROM st_agent_plugin_packages WHERE id=${packageId} AND status='active' AND artifact_sha256=${expected.artifactSha256} LIMIT 1`))[0]
  const artifact = includeArtifact ? await readBlob() : null
  if (includeArtifact && !artifact) throw new TRPCError({ code: 'NOT_FOUND', message: '插件制品不存在或已更换' })
  const cached = getCachedAgentPluginVerification(expected.artifactSha256, expected)
  if (cached) {
    if (includeArtifact && createHash('sha256').update(artifact!.artifactBlob as Buffer).digest('hex') !== expected.artifactSha256) throw new TRPCError({ code: 'FORBIDDEN', message: '插件实际下载内容与已验签哈希不一致' })
    assertVerifiedPackageIdentity(row, cached)
    return { row, verification: cached, trusted, artifact: includeArtifact ? artifact!.artifactBlob : undefined }
  }
  const artifactForVerification = includeArtifact ? artifact : await readBlob()
  if (!artifactForVerification) throw new TRPCError({ code: 'NOT_FOUND', message: '插件制品不存在或已更换' })
  let verification: AgentPluginVerification
  try { verification = await verifyAndCacheAgentPluginPackage(Buffer.from(artifactForVerification.artifactBlob as Buffer), expected) } catch (error) { throw new TRPCError({ code: 'FORBIDDEN', message: '插件制品验签失败', cause: error }) }
  assertVerifiedPackageIdentity(row, verification)
  return { row, verification, trusted, artifact: includeArtifact ? artifactForVerification.artifactBlob : undefined }
}

type AgentPluginListResult = { packages: Array<Record<string, unknown>>; skippedInvalidPackages: number }
const AGENT_PLUGIN_LIST_CACHE_MS = 30_000
let listCache: { expiresAt: number; value: AgentPluginListResult } | null = null
let listInFlight: Promise<AgentPluginListResult> | null = null
async function listVerifiedPackages(db: Db): Promise<AgentPluginListResult> {
  trustedPublicKeys()
  if (listCache && listCache.expiresAt > Date.now()) return listCache.value
  if (listInFlight) return listInFlight
  listInFlight = (async () => {
    const ids = rawRows(await db.execute(sql`SELECT id FROM st_agent_plugin_packages WHERE status='active' ORDER BY id DESC LIMIT 50`)).map((row) => Number(row.id))
    const packages = []
    let skippedInvalidPackages = 0
    for (const id of ids) {
      try {
        const { row, verification, trusted } = await packageArtifact(db, id)
        packages.push({
          id: Number(row.id), packageKey: String(row.packageKey), name: String(row.name), version: String(row.version),
          description: row.description ? String(row.description) : null, priceCents: Number(row.priceCents ?? 0), durationDays: Number(row.durationDays ?? 30), artifactSha256: verification.artifactSha256,
          status: String(row.status), createdAt: row.createdAt, manifest: verification.manifest,
          signatureVerified: true as const, trustedKeySha256: hash(trusted!),
        })
      } catch (error) {
        if (error instanceof TRPCError && error.code === 'PRECONDITION_FAILED' && /插件独立信任锚未配置|插件信任公钥集合配置无效/.test(error.message)) throw error
        skippedInvalidPackages += 1
        console.warn(`[agent-plugins] skipped package ${id}: ${error instanceof Error ? error.message : 'unknown'}`)
      }
    }
    packages.sort((a, b) => a.packageKey.localeCompare(b.packageKey) || b.version.localeCompare(a.version, undefined, { numeric: true }))
    const value = { packages, skippedInvalidPackages }
    listCache = { expiresAt: Date.now() + AGENT_PLUGIN_LIST_CACHE_MS, value }
    return value
  })()
  try { return await listInFlight } finally { listInFlight = null }
}

export const agentPluginsRouter = createRouter({
  list: publicQuery.query(async () => {
    const db = getDb()
    return listVerifiedPackages(db)
  }),
  mine: publicQuery.input(registrationInput).query(async ({ input }) => {
    const session = await sessionMe(input.token)
    const db = getDb()
    await requireQualifiedRegistration(db, input.registrationId, Number(session.user.id))
    const installs = rawRows(await db.execute(sql`
      SELECT i.id, i.registration_id AS registrationId, i.package_id AS packageId, i.version, i.status,
             i.install_ticket AS installTicket, i.rollback_of AS rollbackOf, i.installed_at AS installedAt,
             i.uninstalled_at AS uninstalledAt, i.last_readback_at AS lastReadbackAt,
             p.package_key AS packageKey, p.name, p.artifact_sha256 AS artifactSha256
      FROM st_agent_plugin_installs i JOIN st_agent_plugin_packages p ON p.id=i.package_id
      WHERE i.registration_id=${input.registrationId} AND i.factory_id=${Number(session.factory.id)} ORDER BY i.id DESC LIMIT 50`))
    const entitlements = rawRows(await db.execute(sql`SELECT package_id AS packageId, status, expires_at AS expiresAt FROM st_agent_plugin_entitlements WHERE registration_id=${input.registrationId} AND factory_id=${Number(session.factory.id)} ORDER BY package_id`)).map((row) => ({
      packageId: Number(row.packageId), status: String(row.status), expiresAt: row.expiresAt,
      effectiveStatus: row.status === 'active' && (!row.expiresAt || new Date(String(row.expiresAt)).getTime() > Date.now()) ? 'active' : 'inactive',
    }))
    return { installs, entitlements }
  }),
  install: publicQuery.input(packageInput).mutation(async ({ input }) => {
    const session = await sessionMe(input.token)
    const db = getDb()
    await requireQualifiedRegistration(db, input.registrationId, Number(session.user.id))
    await requireEntitlement(db, input.registrationId, input.packageId, Number(session.factory.id))
    const { row, verification } = await packageArtifact(db, input.packageId)
    const version = String(row.version)
    const base = ticket('pt', input.registrationId, input.packageId, version, verification.artifactSha256)
    let installTicket = base
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM st_agent_registrations WHERE id=${input.registrationId} FOR UPDATE`)
        const existing = rawRows(await tx.execute(sql`SELECT id, install_ticket AS installTicket FROM st_agent_plugin_installs WHERE registration_id=${input.registrationId} AND package_id=${input.packageId} AND version=${version} AND factory_id=${Number(session.factory.id)} AND status='installed' LIMIT 1`))[0]
        if (existing) return { ok: true as const, already: true as const, installTicket: String(existing.installTicket), status: 'installed' as const }
        installTicket = await nextTicket(tx, base, input.registrationId, input.packageId, version)
        await tx.execute(sql`UPDATE st_agent_plugin_installs i JOIN st_agent_plugin_packages p ON p.id=i.package_id JOIN st_agent_plugin_packages target ON target.id=${input.packageId} SET i.status='uninstalled', i.uninstalled_at=NOW(), i.last_readback_at=NOW() WHERE i.registration_id=${input.registrationId} AND p.package_key=target.package_key AND i.factory_id=${Number(session.factory.id)} AND i.status='installed'`)
        await tx.execute(sql`INSERT INTO st_agent_plugin_installs (registration_id, package_id, factory_id, version, status, install_ticket, installed_at, last_readback_at) VALUES (${input.registrationId}, ${input.packageId}, ${Number(session.factory.id)}, ${version}, 'installed', ${installTicket}, NOW(), NOW())`)
        return { ok: true as const, already: false as const, installTicket, status: 'installed' as const }
      })
    } catch (err) {
      if (!isDupEntry(err)) throw err
      const existing = rawRows(await db.execute(sql`SELECT install_ticket AS installTicket FROM st_agent_plugin_installs WHERE install_ticket=${installTicket} AND registration_id=${input.registrationId} AND factory_id=${Number(session.factory.id)} AND status='installed' LIMIT 1`))[0]
      if (!existing) throw err
      return { ok: true as const, already: true as const, installTicket: String(existing.installTicket), status: 'installed' as const }
    }
  }),
  download: publicQuery.input(packageInput).query(async ({ input }) => {
    const session = await sessionMe(input.token)
    const db = getDb()
    await requireQualifiedRegistration(db, input.registrationId, Number(session.user.id))
    await requireEntitlement(db, input.registrationId, input.packageId, Number(session.factory.id))
    const { row, verification, artifact } = await packageArtifact(db, input.packageId, undefined, true)
    return {
      fileName: `${String(row.packageKey)}-${String(row.version)}.pkx`,
      artifactBase64: Buffer.from(artifact as unknown as Buffer).toString('base64'),
      artifactSha256: verification.artifactSha256,
      manifest: verification.manifest,
      executable: false as const,
    }
  }),
  uninstall: publicQuery.input(packageInput).mutation(async ({ input }) => {
    const session = await sessionMe(input.token)
    const db = getDb()
    await requireQualifiedRegistration(db, input.registrationId, Number(session.user.id))
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM st_agent_registrations WHERE id=${input.registrationId} FOR UPDATE`)
      const result = await tx.execute(sql`UPDATE st_agent_plugin_installs SET status='uninstalled', uninstalled_at=NOW(), last_readback_at=NOW() WHERE registration_id=${input.registrationId} AND package_id=${input.packageId} AND factory_id=${Number(session.factory.id)} AND status='installed'`)
      const affectedRows = Number((Array.isArray(result) ? result[0] : result as { affectedRows?: number })?.affectedRows ?? 0)
      return { ok: true as const, status: 'uninstalled' as const, affectedRows, already: affectedRows === 0 }
    })
  }),
  rollback: publicQuery.input(packageInput).mutation(async ({ input }) => {
    const session = await sessionMe(input.token)
    const db = getDb()
    await requireQualifiedRegistration(db, input.registrationId, Number(session.user.id))
    await requireEntitlement(db, input.registrationId, input.packageId, Number(session.factory.id))
    const current = rawRows(await db.execute(sql`SELECT i.id, i.version, p.package_key AS packageKey FROM st_agent_plugin_installs i JOIN st_agent_plugin_packages p ON p.id=i.package_id WHERE i.registration_id=${input.registrationId} AND i.package_id=${input.packageId} AND i.factory_id=${Number(session.factory.id)} AND i.status='installed' ORDER BY i.id DESC LIMIT 1`))[0]
    if (!current) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '没有可回滚的当前安装' })
    const previous = rawRows(await db.execute(sql`SELECT i.id, i.package_id AS packageId, i.version FROM st_agent_plugin_installs i JOIN st_agent_plugin_packages p ON p.id=i.package_id WHERE i.registration_id=${input.registrationId} AND p.package_key=${String(current.packageKey)} AND i.factory_id=${Number(session.factory.id)} AND i.id<${Number(current.id)} AND i.version<>${current.version} ORDER BY i.id DESC LIMIT 1`))[0]
    if (!previous) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '没有可回滚的历史版本' })
    await requireEntitlement(db, input.registrationId, Number(previous.packageId), Number(session.factory.id))
    const { verification } = await packageArtifact(db, Number(previous.packageId), String(previous.version))
    const base = ticket('rpt', input.registrationId, Number(previous.packageId), String(previous.version), verification.artifactSha256)
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM st_agent_registrations WHERE id=${input.registrationId} FOR UPDATE`)
      const currentNow = rawRows(await tx.execute(sql`SELECT id FROM st_agent_plugin_installs WHERE id=${Number(current.id)} AND registration_id=${input.registrationId} AND factory_id=${Number(session.factory.id)} AND status='installed' LIMIT 1`))[0]
      const previousNow = rawRows(await tx.execute(sql`SELECT id FROM st_agent_plugin_installs WHERE id=${Number(previous.id)} AND registration_id=${input.registrationId} AND factory_id=${Number(session.factory.id)} LIMIT 1`))[0]
      if (!currentNow || !previousNow) throw new TRPCError({ code: 'CONFLICT', message: '回滚期间安装版本已变化，请重新读取后重试' })
      await requireEntitlement(tx, input.registrationId, Number(previous.packageId), Number(session.factory.id))
      const rollbackTicket = await nextTicket(tx, base, input.registrationId, Number(previous.packageId), String(previous.version))
      await tx.execute(sql`UPDATE st_agent_plugin_installs SET status='uninstalled', uninstalled_at=NOW(), last_readback_at=NOW() WHERE id=${Number(current.id)}`)
      await tx.execute(sql`INSERT INTO st_agent_plugin_installs (registration_id, package_id, factory_id, version, status, install_ticket, rollback_of, installed_at, last_readback_at) VALUES (${input.registrationId}, ${Number(previous.packageId)}, ${Number(session.factory.id)}, ${String(previous.version)}, 'installed', ${rollbackTicket}, ${Number(current.id)}, NOW(), NOW())`)
      return { ok: true as const, installTicket: rollbackTicket, rollbackOf: Number(current.id), status: 'installed' as const, version: previous.version }
    })
  }),
})
