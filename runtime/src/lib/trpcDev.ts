import { trpc } from '@/providers/trpc'

/**
 * 开发者生态（developer.*）、匠人排行榜（leaderboard.*）、工业 Token 经济（tokenEconomy.*）
 * 三组路由由后端并行代理挂载到 appRouter；主 AppRouter 类型合并完成前，
 * 这里以 any 形式按字符串契约调用（与 src/lib/trpcRecruitLoop.ts 同一意图）。
 * 运行时 trpc 是 proxy，路径存在与否只取决于服务端挂载，类型缺失不影响执行。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const trpcDev: any = trpc

/** 开发者中心会话 localStorage 键 */
export const NEBULA_DEV_STORAGE_KEY = 'nebula_dev'

export interface DevSession {
  token: string
  account?: {
    id?: number
    username?: string
    displayName?: string
    contact?: string
    role?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export function loadDevSession(): DevSession | null {
  try {
    const raw = localStorage.getItem(NEBULA_DEV_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DevSession
    return typeof parsed?.token === 'string' && parsed.token ? parsed : null
  } catch {
    return null
  }
}

export function saveDevSession(session: DevSession): void {
  localStorage.setItem(NEBULA_DEV_STORAGE_KEY, JSON.stringify(session))
}

export function clearDevSession(): void {
  localStorage.removeItem(NEBULA_DEV_STORAGE_KEY)
}
