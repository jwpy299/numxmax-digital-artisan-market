import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
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

  it('锁文件验证后被替换时，助手按 dev/ino 身份拒绝接管', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-file-lock-race-'))
    roots.push(root)
    const lockPath = path.join(root, 'restore.lock')
    const replacement = path.join(root, 'replacement.lock')
    fs.writeFileSync(lockPath, '')
    fs.writeFileSync(replacement, '')
    vi.stubEnv('RELEASE_LOCK_FILE', lockPath)
    vi.resetModules()
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:child_process')>()
      return {
        ...actual,
        spawn: (command: string, args: string[], options: object) => {
          fs.renameSync(replacement, lockPath)
          return actual.spawn(command, args, options)
        },
      }
    })
    try {
      const { withReleaseFileLock: locked } = await import('./releaseFileLock')
      await expect(locked(async () => 'must-not-run')).rejects.toThrow('发布文件锁配置或权限异常')
    } finally {
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  }, 10_000)

  it('业务已写入但锁退出超时时返回 lockCleanupUnknown 而非简单失败', async () => {
    vi.resetModules()
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; signalCode: string | null; kill: ReturnType<typeof vi.fn> }
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null, kill: vi.fn() })
    vi.doMock('node:child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: () => child }))
    try {
      const { withReleaseFileLock: locked } = await import('./releaseFileLock')
      const pending = locked(async () => ({ ok: true as const }))
      await new Promise((resolve) => setTimeout(resolve, 20))
      child.stdout.emit('data', 'locked\n')
      const result = await pending
      expect(result).toMatchObject({ ok: true, lockCleanupUnknown: true })
      expect(result.warning).toContain('禁止盲目重试')
    } finally {
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  }, 10_000)
})
