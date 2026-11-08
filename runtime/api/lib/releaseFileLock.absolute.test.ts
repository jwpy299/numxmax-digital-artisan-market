import { describe, expect, it, vi } from 'vitest'
import { withReleaseFileLock } from './releaseFileLock'

const HAS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

describe.skipIf(!HAS_ROOT)('发布锁路径环境契约（root-only；公开 CI 另有特权复跑）', () => {
  it('相对 RELEASE_LOCK_FILE 明确拒绝，不与恢复脚本各自解析', async () => {
    vi.stubEnv('RELEASE_LOCK_FILE', 'relative/restore.lock')
    await expect(withReleaseFileLock(async () => ({ ok: true }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: '发布锁文件必须为绝对路径' })
    vi.unstubAllEnvs()
  })
})
