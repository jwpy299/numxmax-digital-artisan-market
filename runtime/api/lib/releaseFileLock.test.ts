import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { withReleaseFileLock } from './releaseFileLock'

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })

})

const HAS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

describe.skipIf(!HAS_ROOT)('发布文件锁（root-only；公开 CI 另有特权复跑）', () => {
  it('同一文件锁只允许一个发布方，释放后可重入', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-file-lock-'))
    roots.push(root)
    vi.stubEnv('RELEASE_LOCK_FILE', path.join(root, 'restore.lock'))
    vi.stubEnv('RELEASE_FILE_LOCK_TIMEOUT_MS', '200')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = withReleaseFileLock(() => gate)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await expect(withReleaseFileLock(async () => 'second')).rejects.toThrow('另一发布/回滚')
    release()
    await first
    await expect(withReleaseFileLock(async () => 'second')).resolves.toBe('second')
  })
  it('SIGWINCH 等无关信号不会提前释放文件锁', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-file-lock-signal-'))
    roots.push(root)
    const lockPath = path.join(root, 'restore.lock')
    vi.stubEnv('RELEASE_LOCK_FILE', lockPath)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = withReleaseFileLock(() => gate)
    try {
      await new Promise((resolve) => setTimeout(resolve, 80))
      const processes = execFileSync('ps', ['-o', 'pid=,args=', '--ppid', String(process.pid)], { encoding: 'utf8' })
      const line = processes.split('\n').find((row) => row.includes('python3') && row.includes(lockPath))
      expect(line).toBeTruthy()
      const helperPid = Number(line!.trim().split(/\s+/)[0])
      process.kill(helperPid, 'SIGWINCH')
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(() => process.kill(helperPid, 0)).not.toThrow()
      await expect(withReleaseFileLock(async () => 'overlap')).rejects.toThrow('另一发布/回滚')
    } finally {
      release()
      await first
    }
  }, 10_000)
})
