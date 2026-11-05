import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { pluginArtifactBlob, safePluginFileName, verifiedPluginArtifact } from './agentPluginDownload'

describe('Agent 插件下载边界', () => {
  it('合法 PKX 转成 ZIP Blob，文件名和哈希必须受控', async () => {
    const blob = pluginArtifactBlob(btoa('PK-test'))
    expect(blob.type).toBe('application/vnd.numx.plugin+zip')
    expect(await blob.text()).toBe('PK-test')
    expect(safePluginFileName('agent.tasks-1.0.0.pkx')).toBe('agent.tasks-1.0.0.pkx')
  })
  it('路径穿越、非法 Base64 和空制品全部拒绝', () => {
    expect(() => safePluginFileName('../evil.pkx')).toThrow()
    expect(() => safePluginFileName('evil.exe')).toThrow()
    expect(() => pluginArtifactBlob('')).toThrow()
    expect(() => pluginArtifactBlob('not base64!')).toThrow()
  })
  it('下载前在浏览器复算 SHA-256，匹配才放行，篡改必拒', async () => {
    const artifactBase64 = btoa('PK-test')
    const artifactSha256 = createHash('sha256').update('PK-test').digest('hex')
    const verified = await verifiedPluginArtifact({ fileName: 'agent.tasks-1.0.0.pkx', artifactBase64, artifactSha256, executable: false })
    expect(await verified.blob.text()).toBe('PK-test')
    await expect(verifiedPluginArtifact({ fileName: 'agent.tasks-1.0.0.pkx', artifactBase64: btoa('PK-tampered'), artifactSha256, executable: false })).rejects.toThrow('SHA-256')
  })
})
