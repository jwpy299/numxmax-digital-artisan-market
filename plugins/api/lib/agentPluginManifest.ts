import { createHash, verify as verifyEd25519, createPublicKey } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

export const AGENT_PLUGIN_PERMISSIONS = new Set(['tasks:read', 'tasks:write', 'evidence:read', 'training:read'])
export const AGENT_PLUGIN_MAX_ARTIFACT_BYTES = 5 * 1024 * 1024
export const AGENT_PLUGIN_MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024
// Python 输出为 Base64 JSON；stdout 预算必须覆盖合法总载荷及条目开销，不能在验签前以 ENOBUFS 变成 500。
const AGENT_PLUGIN_READER_MAX_BUFFER = Math.ceil(AGENT_PLUGIN_MAX_UNCOMPRESSED_BYTES / 3) * 4 + 256 * 1024
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

function agentPluginZipReaderPath(): string {
  const candidates = [
    fileURLToPath(new URL('../scripts/agent_plugin_zip_reader.py', import.meta.url)), // dist/boot.js → 包根 scripts
    fileURLToPath(new URL('../../scripts/agent_plugin_zip_reader.py', import.meta.url)), // api/lib 源码 → 包根 scripts
  ]
  const match = candidates.find((candidate) => existsSync(candidate))
  if (!match) throw new Error('agent_plugin_zip_reader_missing')
  return match
}

export function readAgentPluginEntries(artifact: Buffer): Array<{ name: string; data: Buffer }> {
  if (!Buffer.isBuffer(artifact) || artifact.length < 22 || artifact.length > AGENT_PLUGIN_MAX_ARTIFACT_BYTES) throw new Error('agent_plugin_artifact_invalid')
  let result: string
  try {
    result = execFileSync('python3', [agentPluginZipReaderPath()], { input: artifact.toString('base64'), encoding: 'utf8', maxBuffer: AGENT_PLUGIN_READER_MAX_BUFFER, timeout: 15_000 })
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '') : ''
    const code = /agent_plugin_[a-z0-9_]+/.exec(stderr)?.[0] ?? 'agent_plugin_zip_reader_failed'
    throw new Error(code)
  }
  try {
    const parsed = JSON.parse(result) as { entries?: Array<{ name?: unknown; data?: unknown }> }
    if (!parsed || !Array.isArray(parsed.entries) || parsed.entries.some((entry) => typeof entry?.name !== 'string' || typeof entry?.data !== 'string')) throw new Error('agent_plugin_zip_reader_invalid')
    return parsed.entries.map((entry) => ({ name: entry.name as string, data: Buffer.from(entry.data as string, 'base64') }))
  } catch (error) {
    if (error instanceof Error && error.message === 'agent_plugin_zip_reader_invalid') throw error
    throw new Error('agent_plugin_zip_reader_invalid')
  }
}


function readAgentPluginEntriesAsync(artifact: Buffer): Promise<Array<{ name: string; data: Buffer }>> {
  if (!Buffer.isBuffer(artifact) || artifact.length < 22 || artifact.length > AGENT_PLUGIN_MAX_ARTIFACT_BYTES) throw new Error('agent_plugin_artifact_invalid')
  return new Promise((resolve, reject) => {
    const child = execFile('python3', [agentPluginZipReaderPath()], { encoding: 'utf8', maxBuffer: AGENT_PLUGIN_READER_MAX_BUFFER, timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) {
        const code = /agent_plugin_[a-z0-9_]+/.exec(String(stderr ?? ''))?.[0] ?? 'agent_plugin_zip_reader_failed'
        reject(new Error(code)); return
      }
      try {
        const parsed = JSON.parse(stdout) as { entries?: Array<{ name?: unknown; data?: unknown }> }
        if (!parsed || !Array.isArray(parsed.entries) || parsed.entries.some((entry) => typeof entry?.name !== 'string' || typeof entry?.data !== 'string')) throw new Error('agent_plugin_zip_reader_invalid')
        resolve(parsed.entries.map((entry) => ({ name: entry.name as string, data: Buffer.from(entry.data as string, 'base64') })))
      } catch (parseError) {
        reject(new Error('agent_plugin_zip_reader_invalid'))
      }
    })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(artifact.toString('base64'))
  })
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

function verifyAgentPluginEntries(artifact: Buffer, entries: Array<{ name: string; data: Buffer }>, expected?: { signerPublicKey?: string; signature?: string; artifactSha256?: string }): AgentPluginVerification {
  const manifestEntry = entries.find((entry) => entry.name === 'manifest.json')
  if (!manifestEntry) throw new Error('agent_plugin_manifest_missing')
  let manifest: AgentPluginManifest
  try { manifest = JSON.parse(manifestEntry.data.toString('utf8')) as AgentPluginManifest } catch { throw new Error('agent_plugin_manifest_invalid') }
  if (!manifest || typeof manifest.id !== 'string' || !/^[a-z][a-z0-9._-]{1,63}$/.test(manifest.id)) throw new Error('agent_plugin_id_invalid')
  if (typeof manifest.name !== 'string' || manifest.name.trim().length < 2 || manifest.name.length > 80) throw new Error('agent_plugin_name_invalid')
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(manifest.version)) throw new Error('agent_plugin_version_invalid')
  if (manifest.entry !== 'index.js' || !entries.some((entry) => entry.name === manifest.entry)) throw new Error('agent_plugin_entry_missing')
  if (manifest.platform !== 'linux' || !['x64', 'arm64'].includes(manifest.arch)) throw new Error('agent_plugin_platform_invalid')
  if (!Array.isArray(manifest.dependencies) || manifest.dependencies.length > 8 || new Set(manifest.dependencies).size !== manifest.dependencies.length || manifest.dependencies.some((dep) => typeof dep !== 'string' || !/^[a-z0-9][a-z0-9._:@/-]{0,63}$/.test(dep))) throw new Error('agent_plugin_dependencies_invalid')
  if (!Array.isArray(manifest.permissions) || manifest.permissions.length === 0 || manifest.permissions.length > 8 || new Set(manifest.permissions).size !== manifest.permissions.length || manifest.permissions.some((p) => !AGENT_PLUGIN_PERMISSIONS.has(p))) throw new Error('agent_plugin_permissions_invalid')
  const payloadEntries = entries.filter((entry) => entry.name !== 'manifest.json')
  const files: Record<string, string> = Object.create(null)
  for (const entry of [...payloadEntries].sort((a, b) => a.name.localeCompare(b.name))) files[entry.name] = hash(entry.data)
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('agent_plugin_files_hash_mismatch')
  const manifestFileNames = Object.keys(manifest.files)
  if (manifestFileNames.length !== Object.keys(files).length || manifestFileNames.some((name) => manifest.files[name] !== files[name])) throw new Error('agent_plugin_files_hash_mismatch')
  const payload = payloadEntries.find((entry) => entry.name === manifest.entry)?.data
  if (!payload || !/^[a-f0-9]{64}$/.test(manifest.payloadSha256) || hash(payload) !== manifest.payloadSha256) throw new Error('agent_plugin_payload_hash_mismatch')
  if (expected?.signerPublicKey !== undefined && manifest.signerPublicKey !== expected.signerPublicKey) throw new Error('agent_plugin_signer_mismatch')
  if (expected?.signature !== undefined && manifest.signature !== expected.signature) throw new Error('agent_plugin_signature_mismatch')
  if (typeof manifest.signerPublicKey !== 'string' || manifest.signerPublicKey.length === 0) throw new Error('agent_plugin_signer_key_invalid')
  if (typeof manifest.signature !== 'string' || manifest.signature.length === 0) throw new Error('agent_plugin_signature_invalid')
  let publicKey: ReturnType<typeof createPublicKey>
  try { publicKey = createPublicKey({ key: Buffer.from(manifest.signerPublicKey, 'base64'), format: 'der', type: 'spki' }) } catch { throw new Error('agent_plugin_signer_key_invalid') }
  const unsigned: AgentPluginUnsignedManifest = {
    id: manifest.id, name: manifest.name, version: manifest.version, entry: manifest.entry,
    permissions: manifest.permissions, platform: manifest.platform, arch: manifest.arch,
    dependencies: manifest.dependencies, files: manifest.files, payloadSha256: manifest.payloadSha256,
  }
  let signatureValid = false
  try { signatureValid = verifyEd25519(null, agentPluginSigningPayload(unsigned), publicKey, Buffer.from(manifest.signature, 'base64')) } catch { throw new Error('agent_plugin_signature_invalid') }
  if (!signatureValid) throw new Error('agent_plugin_signature_invalid')
  const artifactSha256 = hash(artifact)
  if (expected?.artifactSha256 !== undefined && artifactSha256 !== expected.artifactSha256) throw new Error('agent_plugin_artifact_hash_mismatch')
  return { manifest, artifactSha256, files: entries.map((entry) => entry.name) }
}

export function verifyAgentPluginPackage(artifact: Buffer, expected?: { signerPublicKey?: string; signature?: string; artifactSha256?: string }): AgentPluginVerification {
  return verifyAgentPluginEntries(artifact, readAgentPluginEntries(artifact), expected)
}

export async function verifyAgentPluginPackageAsync(artifact: Buffer, expected?: { signerPublicKey?: string; signature?: string; artifactSha256?: string }): Promise<AgentPluginVerification> {
  return verifyAgentPluginEntries(artifact, await readAgentPluginEntriesAsync(artifact), expected)
}
