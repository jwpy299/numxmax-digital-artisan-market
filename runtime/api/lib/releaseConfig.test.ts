import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })
describe('发布工作目录配置', () => {
  it('RELEASE_WORK_ROOT 统一驱动 manifest-history，显式覆盖仍优先', async () => {
    vi.stubEnv('RELEASE_WORK_ROOT', '/tmp/numx-release-custom')
    vi.resetModules()
    expect((await import('./releaseConfig')).RELEASE_MANIFEST_HISTORY_DIR).toBe('/tmp/numx-release-custom/manifest-history')
    vi.stubEnv('RELEASE_MANIFEST_HISTORY_DIR', '/tmp/numx-release-explicit')
    vi.resetModules()
    expect((await import('./releaseConfig')).RELEASE_MANIFEST_HISTORY_DIR).toBe('/tmp/numx-release-explicit')
  })
})
