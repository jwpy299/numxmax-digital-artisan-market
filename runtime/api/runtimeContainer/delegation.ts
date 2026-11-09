import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'

const PREFIX = 'art_'
function key(): Buffer {
  const value = String(process.env.AGENT_RUNTIME_DELEGATION_KEY ?? '').trim()
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('agent_runtime_delegation_key_required')
  return Buffer.from(value, 'hex')
}
export function assertRuntimeDelegationConfigured(): void { void key() }
function hash(token: string): string { return createHash('sha256').update(token).digest('hex') }
function encrypt(token: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') })
}
function decrypt(payload: string): string {
  const parsed = JSON.parse(payload) as { iv: string; tag: string; data: string }
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(parsed.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]).toString('utf8')
}
export async function issueSubmitDelegation(roleId: number, claimId: number, ownerUserId: number, factoryId: number): Promise<string> {
  assertRuntimeDelegationConfigured()
  const token = `${PREFIX}${randomBytes(32).toString('hex')}`
  await getDb().execute(sql`INSERT INTO st_agent_runtime_delegations
    (role_id, claim_id, owner_user_id, factory_id, token_hash, token_ciphertext, scope, expires_at, revoked_at)
    VALUES (${roleId}, ${claimId}, ${ownerUserId}, ${factoryId}, ${hash(token)}, ${encrypt(token)}, 'submitTask', DATE_ADD(NOW(), INTERVAL 2 HOUR), NULL)
    ON DUPLICATE KEY UPDATE claim_id=VALUES(claim_id), owner_user_id=VALUES(owner_user_id), factory_id=VALUES(factory_id), token_hash=VALUES(token_hash), token_ciphertext=VALUES(token_ciphertext), scope='submitTask', expires_at=VALUES(expires_at), revoked_at=NULL`)
  return token
}
export async function readSubmitDelegation(roleId: number): Promise<{ token: string; claimId: number } | null> {
  const row = rawRows(await getDb().execute(sql`SELECT claim_id AS claimId, token_ciphertext AS ciphertext FROM st_agent_runtime_delegations WHERE role_id=${roleId} AND scope='submitTask' AND revoked_at IS NULL AND expires_at>NOW() LIMIT 1`))[0]
  if (!row) return null
  return { token: decrypt(String(row.ciphertext)), claimId: Number(row.claimId) }
}
export async function revokeSubmitDelegation(roleId: number): Promise<void> {
  await getDb().execute(sql`UPDATE st_agent_runtime_delegations SET revoked_at=NOW() WHERE role_id=${roleId} AND revoked_at IS NULL`)
}
