const MAX_PKX_BASE64_LENGTH = 7 * 1024 * 1024

export function safePluginFileName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.pkx$/.test(value) || value.includes('..')) throw new Error('插件下载文件名不合法')
  return value
}

export function pluginArtifactBytes(base64: string): Uint8Array<ArrayBuffer> {
  if (!base64 || base64.length > MAX_PKX_BASE64_LENGTH || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('插件制品 Base64 不合法或过大')
  const binary = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function pluginArtifactBlob(base64: string): Blob {
  return new Blob([pluginArtifactBytes(base64)], { type: 'application/vnd.numx.plugin+zip' })
}

export async function verifiedPluginArtifact(args: { fileName: string; artifactBase64: string; executable: boolean; artifactSha256: string }): Promise<{ fileName: string; blob: Blob }> {
  if (args.executable !== false) throw new Error('服务端未确认禁止执行，拒绝下载')
  if (!/^[a-f0-9]{64}$/.test(args.artifactSha256)) throw new Error('插件制品哈希不合法')
  const fileName = safePluginFileName(args.fileName)
  const bytes = pluginArtifactBytes(args.artifactBase64)
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  if (actual !== args.artifactSha256) throw new Error('下载制品 SHA-256 与服务端登记不一致')
  return { fileName, blob: new Blob([bytes as BufferSource], { type: 'application/vnd.numx.plugin+zip' }) }
}

export async function savePluginArtifact(args: { fileName: string; artifactBase64: string; executable: boolean; artifactSha256: string }): Promise<void> {
  const { fileName, blob } = await verifiedPluginArtifact(args)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
