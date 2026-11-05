import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { makeSignedAgentPluginPackage, zipAgentPluginEntries } from './agentPluginTestPackage'
import { readAgentPluginEntries, verifyAgentPluginPackage } from './agentPluginManifest'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
const publicDer = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const input = { id: 'agent.tasks', name: 'Agent 任务插件', version: '1.0.0', entryCode: 'export const plugin = { name: "tasks" }', permissions: ['tasks:read'], privateKey: privateDer, publicKey: publicDer }

describe('Agent 插件 PKX 与签名', () => {
  it('签名、ZIP 结构、权限与哈希全部通过', () => {
    const artifact = makeSignedAgentPluginPackage(input)
    const verified = verifyAgentPluginPackage(artifact)
    expect(verified.manifest.id).toBe('agent.tasks')
    expect(verified.manifest).toMatchObject({ platform: 'linux', arch: 'x64', dependencies: ['runtime:oap-v0'] })
    expect(verified.files).toEqual(['manifest.json', 'index.js'])
    expect(verified.artifactSha256).toHaveLength(64)
    expect(readAgentPluginEntries(artifact)).toHaveLength(2)
    expect(() => verifyAgentPluginPackage(artifact, { signerPublicKey: 'MCowBQYDK2VwAyEAinvalid' })).toThrow('agent_plugin_signer_mismatch')
  })
  it('权限越界、载荷篡改与签名错误全部 fail-closed', () => {
    expect(() => makeSignedAgentPluginPackage(input)).not.toThrow()
    expect(() => verifyAgentPluginPackage(makeSignedAgentPluginPackage({ ...input, permissions: ['wallet:write'] }))).toThrow('agent_plugin_permissions_invalid')
    const artifact = makeSignedAgentPluginPackage(input)
    const tampered = Buffer.from(artifact)
    tampered[tampered.indexOf('export const plugin') + 1] = 0x58
    expect(() => verifyAgentPluginPackage(tampered)).toThrow()
    const badSignature = makeSignedAgentPluginPackage({ ...input, publicKey: publicDer.replace(/A/g, 'B') })
    expect(() => verifyAgentPluginPackage(badSignature)).toThrow()
  })
  it('名称与权限在有效白名单内被篡改但仍未重签时，签名校验拒绝', () => {
    const artifact = makeSignedAgentPluginPackage(input)
    const entries = readAgentPluginEntries(artifact).map((entry) => ({ name: entry.name, data: entry.data }))
    const manifest = JSON.parse(entries.find((entry) => entry.name === 'manifest.json')!.data.toString('utf8'))
    manifest.name = '被篡改名称'
    manifest.permissions = ['evidence:read']
    const tampered = zipAgentPluginEntries(entries.map((entry) => entry.name === 'manifest.json' ? { name: entry.name, data: Buffer.from(JSON.stringify(manifest)) } : entry))
    expect(() => verifyAgentPluginPackage(tampered)).toThrow('agent_plugin_signature_invalid')
  })
})
