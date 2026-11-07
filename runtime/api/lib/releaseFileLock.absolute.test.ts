import { describe, expect, it, vi } from 'vitest'
import { withReleaseFileLock } from './releaseFileLock'

describe('发布锁路径环境契约', () => {
  it('相对 RELEASE_LOCK_FILE 明确拒绝，不与恢复脚本各自解析', async () => {
    vi.stubEnv('RELEASE_LOCK_FILE', 'relative/restore.lock')
    await expect(withReleaseFileLock(async () => ({ ok: true }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: '发布锁文件必须为绝对路径' })
    vi.unstubAllEnvs()
  })
})
