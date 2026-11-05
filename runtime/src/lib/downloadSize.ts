import { formatByteSize } from './byteSize'

export function formatDownloadSize(bytes: unknown): string {
  if (bytes === null || bytes === undefined || bytes === '') return ''
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return ''
  return `约 ${formatByteSize(value).replace(' ', '')}`
}

/** 只读实际下载文件大小；HEAD 不受支持或取值失败时不显示大小，不回退旧硬编码。
 * Content-Length 需同源可读，或响应端允许 CORS 读取；失败/隐藏时同样不显示大小。
 */
export async function fetchDownloadSizeLabel(href: string, signal?: AbortSignal): Promise<string> {
  if (!href) return ''
  try {
    const response = await fetch(href, { method: 'HEAD', cache: 'no-store', signal })
    if (!response.ok) return ''
    if ((response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) return ''
    return formatDownloadSize(response.headers.get('content-length'))
  } catch {
    return ''
  }
}
