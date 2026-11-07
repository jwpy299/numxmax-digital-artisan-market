import { execFileSync } from 'node:child_process'
import { createHash, sign as signEd25519, createPrivateKey } from 'node:crypto'
import { agentPluginSigningPayload, type AgentPluginManifest, type AgentPluginUnsignedManifest } from './agentPluginManifest'

export function zipAgentPluginEntries(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const input = JSON.stringify({ entries: entries.map((entry) => ({ name: entry.name, data: entry.data.toString('base64') })) })
  const result = execFileSync('python3', ['scripts/agent_plugin_zip_writer.py'], { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return Buffer.from(result.trim(), 'base64')
}

/** 测试夹具专用：生成确定性 ZIP，不开放生产上传，也不执行其中代码。 */
export function makeSignedAgentPluginPackage(args: { id: string; name: string; version: string; entryCode: string; permissions: string[]; privateKey: string; publicKey: string; arch?: 'x64' | 'arm64'; dependencies?: string[] }): Buffer {
  const payload = Buffer.from(args.entryCode)
  const payloadSha256 = createHash('sha256').update(payload).digest('hex')
  const unsigned: AgentPluginUnsignedManifest = {
    id: args.id,
    name: args.name,
    version: args.version,
    entry: 'index.js',
    permissions: args.permissions,
    platform: 'linux',
    arch: args.arch ?? 'x64',
    dependencies: args.dependencies ?? ['runtime:oap-v0'],
    files: { 'index.js': payloadSha256 },
    payloadSha256,
  }
  const signature = signEd25519(null, agentPluginSigningPayload(unsigned), createPrivateKey({ key: Buffer.from(args.privateKey, 'base64'), format: 'der', type: 'pkcs8' }))
  const manifest: AgentPluginManifest = { ...unsigned, signature: signature.toString('base64'), signerPublicKey: args.publicKey }
  return zipAgentPluginEntries([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
    { name: 'index.js', data: payload },
  ])
}
