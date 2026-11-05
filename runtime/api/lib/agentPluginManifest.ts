import { createHash, verify as verifyEd25519, createPublicKey } from 'node:crypto'
import { execFileSync } from 'node:child_process'

export const AGENT_PLUGIN_PERMISSIONS = new Set(['tasks:read', 'tasks:write', 'evidence:read', 'training:read'])
export interface AgentPluginManifest {
  id: string
  name: string
  version: string
  entry: 'index.js'
  permissions: string[]
  platform: 'linux'
  arch: 'x64' | 'arm64'
  dependencies: string[]
  files: Record<string, string>
  payloadSha256: string
  signature: string
  signerPublicKey: string
}
export interface AgentPluginVerification { manifest: AgentPluginManifest; artifactSha256: string; files: string[] }
export type AgentPluginUnsignedManifest = Omit<AgentPluginManifest, 'signature' | 'signerPublicKey'>

function hash(data: Buffer | string): string { return createHash('sha256').update(data).digest('hex') }

export function readAgentPluginEntries(artifact: Buffer): Array<{ name: string; data: Buffer }> {
  if (!Buffer.isBuffer(artifact) || artifact.length < 22 || artifact.length > 5 * 1024 * 1024) throw new Error('agent_plugin_artifact_invalid')
  const result = execFileSync('python3', ['scripts/agent_plugin_zip_reader.py'], { input: artifact.toString('base64'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const parsed = JSON.parse(result) as { entries: Array<{ name: string; data: string }> }
  return parsed.entries.map((entry) => ({ name: entry.name, data: Buffer.from(entry.data, 'base64') }))
}

export function agentPluginSigningPayload(manifest: AgentPluginUnsignedManifest): Buffer {
  return Buffer.from(JSON.stringify({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    entry: manifest.entry,
    permissions: manifest.permissions,
    platform: manifest.platform,
    arch: manifest.arch,
    dependencies: manifest.dependencies,
    files: manifest.files,
    payloadSha256: manifest.payloadSha256,
  }))
}

export function verifyAgentPluginPackage(artifact: Buffer, expected?: { signerPublicKey?: string; signature?: string; artifactSha256?: string }): AgentPluginVerification {
  const entries = readAgentPluginEntries(artifact)
  const manifestEntry = entries.find((entry) => entry.name === 'manifest.json')
  if (!manifestEntry) throw new Error('agent_plugin_manifest_missing')
  const manifest = JSON.parse(manifestEntry.data.toString('utf8')) as AgentPluginManifest
  if (!manifest || typeof manifest.id !== 'string' || !/^[a-z][a-z0-9._-]{1,63}$/.test(manifest.id)) throw new Error('agent_plugin_id_invalid')
  if (typeof manifest.name !== 'string' || manifest.name.trim().length < 2 || manifest.name.length > 80) throw new Error('agent_plugin_name_invalid')
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(manifest.version)) throw new Error('agent_plugin_version_invalid')
  if (manifest.entry !== 'index.js' || !entries.some((entry) => entry.name === manifest.entry)) throw new Error('agent_plugin_entry_missing')
  if (manifest.platform !== 'linux' || !['x64', 'arm64'].includes(manifest.arch)) throw new Error('agent_plugin_platform_invalid')
  if (!Array.isArray(manifest.dependencies) || manifest.dependencies.length > 8 || new Set(manifest.dependencies).size !== manifest.dependencies.length || manifest.dependencies.some((dep) => typeof dep !== 'string' || !/^[a-z0-9][a-z0-9._:@/-]{0,63}$/.test(dep))) throw new Error('agent_plugin_dependencies_invalid')
  if (!Array.isArray(manifest.permissions) || manifest.permissions.length === 0 || manifest.permissions.length > 8 || new Set(manifest.permissions).size !== manifest.permissions.length || manifest.permissions.some((p) => !AGENT_PLUGIN_PERMISSIONS.has(p))) throw new Error('agent_plugin_permissions_invalid')
  const payloadEntries = entries.filter((entry) => entry.name !== 'manifest.json')
  const files: Record<string, string> = {}
  for (const entry of [...payloadEntries].sort((a, b) => a.name.localeCompare(b.name))) files[entry.name] = hash(entry.data)
  if (!manifest.files || typeof manifest.files !== 'object' || JSON.stringify(manifest.files) !== JSON.stringify(files)) throw new Error('agent_plugin_files_hash_mismatch')
  const payload = payloadEntries.find((entry) => entry.name === manifest.entry)?.data
  if (!payload || !/^[a-f0-9]{64}$/.test(manifest.payloadSha256) || hash(payload) !== manifest.payloadSha256) throw new Error('agent_plugin_payload_hash_mismatch')
  if (expected?.signerPublicKey !== undefined && manifest.signerPublicKey !== expected.signerPublicKey) throw new Error('agent_plugin_signer_mismatch')
  if (expected?.signature !== undefined && manifest.signature !== expected.signature) throw new Error('agent_plugin_signature_mismatch')
  const publicKey = createPublicKey({ key: Buffer.from(manifest.signerPublicKey, 'base64'), format: 'der', type: 'spki' })
  const unsigned: AgentPluginUnsignedManifest = {
    id: manifest.id, name: manifest.name, version: manifest.version, entry: manifest.entry,
    permissions: manifest.permissions, platform: manifest.platform, arch: manifest.arch,
    dependencies: manifest.dependencies, files: manifest.files, payloadSha256: manifest.payloadSha256,
  }
  if (!verifyEd25519(null, agentPluginSigningPayload(unsigned), publicKey, Buffer.from(manifest.signature, 'base64'))) throw new Error('agent_plugin_signature_invalid')
  const artifactSha256 = hash(artifact)
  if (expected?.artifactSha256 !== undefined && artifactSha256 !== expected.artifactSha256) throw new Error('agent_plugin_artifact_hash_mismatch')
  return { manifest, artifactSha256, files: entries.map((entry) => entry.name) }
}
