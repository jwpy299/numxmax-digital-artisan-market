import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

const verifyAsync = vi.hoisted(() => vi.fn())
vi.mock('./agentPluginManifest', () => ({ verifyAgentPluginPackageAsync: verifyAsync }))
import type { AgentPluginVerification } from './agentPluginManifest'
import { getCachedAgentPluginVerification, verifyAndCacheAgentPluginPackage } from './agentPluginVerification'

function verification(version: string): AgentPluginVerification {
  return {
    artifactSha256: 'a'.repeat(64),
    files: ['manifest.json', 'index.js'],
    manifest: {
      id: 'agent.tasks', name: '任务插件', version, entry: 'index.js', permissions: ['tasks:read'], platform: 'linux', arch: 'x64', dependencies: [], files: {}, payloadSha256: 'b'.repeat(64), signature: `sig-${version}`, signerPublicKey: `key-${version}`,
    },
  }
}

describe('Agent 插件验签缓存信任锚', () => {
  it('同一制品不同签名者或签名不得复用旧验证结果', async () => {
    const artifact = Buffer.from('same-artifact')
    const artifactSha256 = createHash('sha256').update(artifact).digest('hex')
    const first = verification('1.0.0')
    const second = verification('1.1.0')
    verifyAsync.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const expectedA = { artifactSha256, signerPublicKey: 'key-a', signature: 'sig-a' }
    const expectedB = { artifactSha256, signerPublicKey: 'key-b', signature: 'sig-b' }
    await expect(verifyAndCacheAgentPluginPackage(artifact, expectedA)).resolves.toBe(first)
    await expect(verifyAndCacheAgentPluginPackage(artifact, expectedA)).resolves.toBe(first)
    expect(verifyAsync).toHaveBeenCalledTimes(1)
    await expect(verifyAndCacheAgentPluginPackage(Buffer.from('tampered-artifact'), expectedA)).rejects.toThrow('agent_plugin_artifact_hash_mismatch')
    expect(verifyAsync).toHaveBeenCalledTimes(1)
    await expect(verifyAndCacheAgentPluginPackage(artifact, expectedB)).resolves.toBe(second)
    expect(verifyAsync).toHaveBeenCalledTimes(2)
    expect(getCachedAgentPluginVerification(artifactSha256, expectedA)).toBe(first)
    expect(getCachedAgentPluginVerification(artifactSha256, expectedB)).toBe(second)
    expect(getCachedAgentPluginVerification(artifactSha256, { signerPublicKey: 'key-c', signature: 'sig-c' })).toBeNull()
  })
})
