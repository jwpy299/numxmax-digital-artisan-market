import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { TRPCError } from '@trpc/server'

const LOCK_HELPER = `
import ctypes,fcntl,os,signal,sys
libc=ctypes.CDLL(None)
parent_pid=os.getppid()
if libc.prctl(1,signal.SIGKILL) != 0:
 raise OSError('prctl_failed')
if os.getppid() != parent_pid:
 sys.exit(77)
fd=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT,0o600)
try:
 fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:
 print('busy',file=sys.stderr)
 sys.exit(75)
except Exception as exc:
 print(type(exc).__name__,file=sys.stderr)
 sys.exit(76)
print('locked',flush=True)
while True:
 signal.pause()
`

function lockError(code: 'CONFLICT' | 'PRECONDITION_FAILED' | 'INTERNAL_SERVER_ERROR', message: string) {
  return new TRPCError({ code, message })
}

function assertNoSymlinkTree(target: string): void {
  let current = target
  while (current !== '/') {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw lockError('INTERNAL_SERVER_ERROR', '发布锁路径不得包含符号链接')
    } catch (error) {
      if ((error as { code?: string })?.code !== 'ENOENT') throw error
    }
    current = path.dirname(current)
  }
}

/** 与恢复脚本共享 flock；所有等待有界，锁丢失先等业务落稳再报结果不确定。 */
export async function withReleaseFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const configuredSettleTimeout = process.env.RELEASE_BUSINESS_SETTLE_TIMEOUT_MS;
  const settleTimeoutMs = configuredSettleTimeout?.trim() ? Number(configuredSettleTimeout) : 10_000
  const configuredTimeout = process.env.RELEASE_FILE_LOCK_TIMEOUT_MS;
  const timeoutMs = configuredTimeout?.trim() ? Number(configuredTimeout) : 10_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw lockError('INTERNAL_SERVER_ERROR', '发布文件锁超时配置无效')
  if (!Number.isSafeInteger(settleTimeoutMs) || settleTimeoutMs <= 0 || settleTimeoutMs > 2_147_483_647) throw lockError('INTERNAL_SERVER_ERROR', '发布业务收敛超时配置无效')
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw lockError('INTERNAL_SERVER_ERROR', '发布文件锁要求 root 运行')
  const lockPath = path.resolve(process.env.RELEASE_LOCK_FILE || `${process.env.RELEASE_WORK_ROOT || "${process.cwd()}/release-work/numx-artifacts"}/restore.lock`)
  assertNoSymlinkTree(lockPath)
  const lockDir = path.dirname(lockPath)
  const lockDirExisted = fs.existsSync(lockDir)
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 })
  assertNoSymlinkTree(lockDir)
  if (!lockDirExisted) fs.chmodSync(lockDir, 0o700)
  const lockDirStat = fs.statSync(lockDir)
  if (lockDirStat.uid !== 0 || (lockDirStat.mode & 0o777) !== 0o700) throw lockError('INTERNAL_SERVER_ERROR', '发布锁目录必须为 root:700')
  if (fs.existsSync(lockPath)) {
    const stat = fs.lstatSync(lockPath)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.uid !== 0) throw lockError('INTERNAL_SERVER_ERROR', '发布锁文件形态或属主异常')
    if ((stat.mode & 0o777) !== 0o600) fs.chmodSync(lockPath, 0o600)
  } else {
    const fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600)
    fs.closeSync(fd)
  }

  const child = spawn('python3', ['-c', LOCK_HELPER, lockPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  let acquired = false
  let exited = false
  let lostError: TRPCError | null = null
  let onExit: (() => void) | null = null
  const lockLost = new Promise<never>((_, reject) => {
    onExit = () => {
      if (!acquired) return
      lostError = lockError('INTERNAL_SERVER_ERROR', '发布文件锁在执行期间丢失，发布结果必须人工核查')
      reject(lostError)
    }
    child.once('exit', onExit)
  })
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-500) })
  const running = () => child.exitCode === null && child.signalCode === null
  const waitExit = async (ms: number) => {
    if (!running()) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(lockError('INTERNAL_SERVER_ERROR', '发布文件锁退出等待超时')), ms)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
  const stopAndWait = async () => {
    if (!running()) return
    try { child.kill('SIGTERM') } catch { /* 已退出 */ }
    try {
      await waitExit(500)
    } catch {
      if (running()) {
        try { child.kill('SIGKILL') } catch { /* 已退出 */ }
        await waitExit(1_500)
      }
    }
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      void stopAndWait().then(() => reject(lockError('PRECONDITION_FAILED', '发布文件锁获取超时')), () => reject(lockError('PRECONDITION_FAILED', '发布文件锁获取超时')))
    }, timeoutMs)
    const fail = (error: TRPCError) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      void stopAndWait().then(() => reject(error), () => reject(error))
    }
    child.once('error', () => fail(lockError('INTERNAL_SERVER_ERROR', '发布文件锁不可用，请检查 python3/flock 环境')))
    child.once('exit', (code) => {
      exited = true;
      if (acquired) return
      if (code === 75) fail(lockError('CONFLICT', '另一发布/回滚正在执行——请稍后重试'))
      else fail(lockError('INTERNAL_SERVER_ERROR', `发布文件锁配置或权限异常${stderr ? `：${stderr.trim().slice(0, 160)}` : ''}`))
    })
    child.stdout.once('data', () => {
      if (settled || exited) return
      settled = true
      acquired = true
      clearTimeout(timeout)
      resolve()
    })
  })

  const business = Promise.resolve().then(fn)
  let businessError: unknown
  try {
    return await Promise.race([business, lockLost])
  } catch (error) {
    businessError = error
    throw error
  } finally {
    if (onExit) child.off('exit', onExit)
    let cleanupError: unknown
    try { await stopAndWait() } catch (error) { cleanupError = error }
    if (lostError) {
      let settleTimer: ReturnType<typeof setTimeout> | null = null
      try {
        const boundedSettle = new Promise<never>((_, reject) => {
          settleTimer = setTimeout(() => reject(lockError('INTERNAL_SERVER_ERROR', '发布业务在锁丢失后未能在限时内收敛，结果不确定')), settleTimeoutMs)
          settleTimer.unref?.()
        })
        await Promise.race([business, boundedSettle]).catch(() => undefined)
      } finally {
        if (settleTimer) clearTimeout(settleTimer)
      }
      throw lostError
    }
    if (cleanupError && businessError === undefined) throw cleanupError
  }
}
