import { describe, expect, it } from 'vitest'
import { createHash, createPrivateKey, generateKeyPairSync, sign as signEd25519 } from 'node:crypto'
import os from 'node:os'
import { makeSignedAgentPluginPackage, zipAgentPluginEntries } from './agentPluginTestPackage'
import { agentPluginSigningPayload, readAgentPluginEntries, verifyAgentPluginPackage, verifyAgentPluginPackageAsync, type AgentPluginUnsignedManifest } from './agentPluginManifest'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
const publicDer = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const input = { id: 'agent.tasks', name: 'Agent 任务插件', version: '1.0.0', entryCode: 'export const plugin = { name: "tasks" }', permissions: ['tasks:read'], privateKey: privateDer, publicKey: publicDer }

describe('Agent 插件 PKX 与签名', () => {
  it('签名、ZIP 结构、权限与哈希全部通过', () => {
    const artifact = makeSignedAgentPluginPackage(input)
    const verified = verifyAgentPluginPackage(artifact)
    expect(verified.manifest['id']).toBe('agent.tasks')
    expect(verified.manifest).toMatchObject({ platform: 'linux', arch: 'x64', dependencies: ['runtime:oap-v0'] })
    expect(verified.files).toEqual(['manifest.json', 'index.js'])
    expect(verified.artifactSha256).toHaveLength(64)
    expect(readAgentPluginEntries(artifact)).toHaveLength(2)
    expect(() => verifyAgentPluginPackage(artifact, { signerPublicKey: 'MCowBQYDK2VwAyEAinvalid' })).toThrow('agent_plugin_signer_mismatch')
  })
  it('从非仓库工作目录调用也使用模块绝对路径，不依赖 CWD', () => {
    const artifact = makeSignedAgentPluginPackage(input)
    const previous = process.cwd()
    try {
      process.chdir(os.tmpdir())
      expect(verifyAgentPluginPackage(artifact).manifest.id).toBe('agent.tasks')
    } finally {
      process.chdir(previous)
    }
  })
  it('异步验签同样不依赖 CWD，并保持 manifest 与哈希一致', async () => {
    const artifact = makeSignedAgentPluginPackage(input)
    const previous = process.cwd()
    try {
      process.chdir(os.tmpdir())
      const verified = await verifyAgentPluginPackageAsync(artifact)
      expect(verified.manifest['id']).toBe('agent.tasks')
      expect(verified.artifactSha256).toHaveLength(64)
    } finally {
      process.chdir(previous)
    }
  })
  it('中央目录伪造未压缩大小时按限额读取并拒绝', () => {
    const artifact = makeSignedAgentPluginPackage(input)
    const central = artifact.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    expect(central).toBeGreaterThan(0)
    const forged = Buffer.from(artifact)
    forged.writeUInt32LE(1, central + 24)
    expect(() => readAgentPluginEntries(forged)).toThrow(/agent_plugin_(?:zip_invalid|zip_size_mismatch)/)
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
  it('合法 7 MiB 包不被 stdout 预算误杀，超过 8 MiB 总预算稳定拒绝', () => {
    const manifest = { name: 'manifest.json', data: Buffer.from('{}') }
    const sevenFiles = Array.from({ length: 7 }, (_, index) => ({ name: `payload-${index}.bin`, data: Buffer.alloc(1024 * 1024, index + 1) }))
    const sevenMiB = zipAgentPluginEntries([manifest, ...sevenFiles])
    expect(readAgentPluginEntries(sevenMiB)).toHaveLength(8)
    const eightMiB = zipAgentPluginEntries([...sevenFiles, { name: 'payload-7.bin', data: Buffer.alloc(1024 * 1024, 8) }, manifest])
    expect(() => readAgentPluginEntries(eightMiB)).toThrow('agent_plugin_zip_total_size_invalid')
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

  it('签名有效的多文件 manifest 不受 files 键顺序影响', () => {
    const indexPayload = Buffer.from(input.entryCode)
    const extraPayload = Buffer.from('export const extra = true')
    const indexHash = createHash('sha256').update(indexPayload).digest('hex')
    const unsigned: AgentPluginUnsignedManifest = {
      id: input.id, name: input.name, version: input.version, entry: 'index.js', permissions: input.permissions,
      platform: 'linux', arch: 'x64', dependencies: ['runtime:oap-v0'],
      files: { 'z-extra.js': createHash('sha256').update(extraPayload).digest('hex'), 'index.js': indexHash },
      payloadSha256: indexHash,
    }
    const signature = signEd25519(null, agentPluginSigningPayload(unsigned), createPrivateKey({ key: Buffer.from(privateDer, 'base64'), format: 'der', type: 'pkcs8' }))
    const manifest = { ...unsigned, signature: signature.toString('base64'), signerPublicKey: publicDer }
    const artifact = zipAgentPluginEntries([
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
      { name: 'index.js', data: indexPayload },
      { name: 'z-extra.js', data: extraPayload },
    ])
    const verified = verifyAgentPluginPackage(artifact)
    expect(verified.manifest.files['index.js']).toBe(indexHash)
    expect(verified.files).toEqual(['manifest.json', 'index.js', 'z-extra.js'])
  })
  it('坏 JSON、坏 DER 公钥与非字符串签名均返回稳定验签错误', () => {
    const malformed = zipAgentPluginEntries([{ name: 'manifest.json', data: Buffer.from('{not-json') }, { name: 'index.js', data: Buffer.from(input.entryCode) }])
    expect(() => verifyAgentPluginPackage(malformed)).toThrow('agent_plugin_manifest_invalid')
    expect(() => verifyAgentPluginPackage(makeSignedAgentPluginPackage({ ...input, publicKey: 'not-a-der-key' }))).toThrow('agent_plugin_signer_key_invalid')
    const entries = readAgentPluginEntries(makeSignedAgentPluginPackage(input)).map((entry) => ({ name: entry.name, data: entry.data }))
    const manifest = JSON.parse(entries.find((entry) => entry.name === 'manifest.json')!.data.toString('utf8'))
    manifest.signature = 42
    const tampered = zipAgentPluginEntries(entries.map((entry) => entry.name === 'manifest.json' ? { name: entry.name, data: Buffer.from(JSON.stringify(manifest)) } : entry))
    expect(() => verifyAgentPluginPackage(tampered)).toThrow('agent_plugin_signature_invalid')
  })
  it('__proto__ 文件键不会绕过文件哈希或原型污染', () => {
    const indexPayload = Buffer.from(input.entryCode)
    const extraPayload = Buffer.from('export const proto = true')
    const indexHash = createHash('sha256').update(indexPayload).digest('hex')
    const unsigned: AgentPluginUnsignedManifest = {
      id: input.id, name: input.name, version: input.version, entry: 'index.js', permissions: input.permissions,
      platform: 'linux', arch: 'x64', dependencies: ['runtime:oap-v0'],
      files: (() => { const value = Object.create(null); value['__proto__'] = createHash('sha256').update(extraPayload).digest('hex'); value['index.js'] = indexHash; return value })(),
      payloadSha256: indexHash,
    }
    const signature = signEd25519(null, agentPluginSigningPayload(unsigned), createPrivateKey({ key: Buffer.from(privateDer, 'base64'), format: 'der', type: 'pkcs8' }))
    const manifest = { ...unsigned, signature: signature.toString('base64'), signerPublicKey: publicDer }
    const artifact = zipAgentPluginEntries([
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
      { name: 'index.js', data: indexPayload },
      { name: '__proto__', data: extraPayload },
    ])
    const verified = verifyAgentPluginPackage(artifact)
    expect(verified.manifest.files['__proto__']).toBe(createHash('sha256').update(extraPayload).digest('hex'))
    expect(verified.manifest['id']).toBe('agent.tasks')
  })

})
