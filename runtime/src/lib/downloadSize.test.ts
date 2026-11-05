import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchDownloadSizeLabel, formatDownloadSize } from './downloadSize'
import { formatByteSize } from './byteSize'

afterEach(() => vi.unstubAllGlobals())

describe('下载中心真实文件大小', () => {
  it('按实际字节数格式化 APP 与组织桌面包', () => {
    expect(formatDownloadSize(188269312)).toBe('约 179.5MB')
    expect(formatDownloadSize(77217623)).toBe('约 73.6MB')
    expect(formatByteSize(188269312)).toBe('179.5 MB')
    expect(formatByteSize(2048)).toBe('2 KB')
    expect(formatDownloadSize(0)).toBe('')
    expect(formatDownloadSize(null)).toBe('')
    expect(formatDownloadSize('not-a-number')).toBe('')
  })

  it('使用 HEAD + no-store 读取真实 Content-Length', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 200,
      headers: { 'Content-Length': '188269312' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchDownloadSizeLabel('/dl/numx-org-runtime-setup.exe')).resolves.toBe('约 179.5MB')
    expect(fetchMock).toHaveBeenCalledWith('/dl/numx-org-runtime-setup.exe', expect.objectContaining({ method: 'HEAD', cache: 'no-store' }))
  })

  it('404、HTML 落地页、缺长度和网络失败均不显示旧大小', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })))
    await expect(fetchDownloadSizeLabel('/missing.exe')).resolves.toBe('')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>login</html>', { status: 200, headers: { 'Content-Type': 'text/html', 'Content-Length': '999' } })))
    await expect(fetchDownloadSizeLabel('/redirected.exe')).resolves.toBe('')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
    await expect(fetchDownloadSizeLabel('/unknown.exe')).resolves.toBe('')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(fetchDownloadSizeLabel('/offline.exe')).resolves.toBe('')
    await expect(fetchDownloadSizeLabel('')).resolves.toBe('')
  })})
