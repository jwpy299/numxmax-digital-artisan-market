/**
 * wbDevices —— M17b 设备配对与台账·前端纯逻辑层。
 *
 * 与 api/routers/wbPair.ts（M17a 后端）契约对齐：
 * - 配对码明文 pd_+48hex 只出现在 open 响应与本模块入参，绝不写 localStorage/日志/埋点
 *   （组件仅内存态展示，关闭即丢弃）；
 * - 二维码 payload 为版本化 JSON { t:'pair', c:'pd_...', v:1 }，解析宽容（非法一律 null）；
 * - 在线判定：后端 list 已算好 status（lastSeenAt 距今 ≤90s 为 online），deviceStatusOf
 *   仅作展示层兜底/复算，口径与后端 ONLINE_GRACE_MS 完全一致；
 * - M17b REVISE（方案 a「工作台即设备」）：首次 status 拉取返回的 dt_ 明文保存到
 *   localStorage("wb_device_credential")（设计内唯一落盘点），驱动 30s 心跳循环
 *   （模块级单例；心跳 UNAUTHORIZED=凭证失效 → 清除并停止）；
 * - token 一律在请求体（useWbQuery/wbMutation 注入），本模块不碰 token。
 */

// ─── 配对码 ─────────────────────────────────────────────────────────────────

/** 配对码格式：pd_ + 48 hex（与后端 zod codeInput 一致） */
export const PAIR_CODE_RE = /^pd_[0-9a-f]{48}$/

export function isPairCode(code: string | null | undefined): boolean {
  return typeof code === 'string' && PAIR_CODE_RE.test(code.trim())
}

/** 配对码 TTL：固定 5 分钟（后端 WB_PAIR_TTL_SECONDS=300） */
export const PAIR_TTL_SECONDS = 300

/** 剩余秒数（≤0 视为过期）；非法时间返回 0 */
export function pairRemainingSeconds(expiresAt: string | Date, now: Date = new Date()): number {
  const ms = new Date(expiresAt).getTime() - now.getTime()
  if (Number.isNaN(ms)) return 0
  return Math.max(0, Math.ceil(ms / 1000))
}

/** 倒计时展示文案："4:32" / "0:09"；过期统一「已过期」 */
export function formatPairRemaining(expiresAt: string | Date, now: Date = new Date()): string {
  const sec = pairRemainingSeconds(expiresAt, now)
  if (sec <= 0) return '已过期'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// ─── 二维码 payload（{ t:'pair', c, v:1 }，版本化宽容解析）───────────────────

export interface PairQrPayload {
  t: 'pair'
  c: string
  v: number
}

/** 构造二维码 payload；码格式不符返回 null（不生成错误二维码） */
export function buildPairQrPayload(code: string): PairQrPayload | null {
  if (!isPairCode(code)) return null
  return { t: 'pair', c: code.trim(), v: 1 }
}

/**
 * 解析二维码 payload（对象或 JSON 字符串均可）。
 * 校验 t==='pair' 且 c 为合法 pd_ 码；任何不符一律返回 null（调用方统一提示「不支持此二维码」）。
 */
export function parsePairQrPayload(raw: unknown): string | null {
  try {
    const obj = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
    if (!obj || typeof obj !== 'object') return null
    const p = obj as { t?: unknown; c?: unknown }
    if (p.t !== 'pair' || typeof p.c !== 'string') return null
    return isPairCode(p.c) ? p.c.trim() : null
  } catch {
    return null
  }
}

// ─── 设备状态 ───────────────────────────────────────────────────────────────

export type WbDeviceStatus = 'online' | 'offline' | 'revoked'

/** 在线宽限：心跳周期 30s 的 3 倍（与后端 ONLINE_GRACE_MS 一致） */
export const ONLINE_GRACE_MS = 90_000

/** revoked > online（90s 内心跳）> offline；与后端 deviceStatus 同口径 */
export function deviceStatusOf(
  d: { lastSeenAt?: string | Date | null; revokedAt?: string | Date | null },
  now: Date = new Date(),
): WbDeviceStatus {
  if (d.revokedAt) return 'revoked'
  if (d.lastSeenAt) {
    const seen = new Date(d.lastSeenAt).getTime()
    if (!Number.isNaN(seen) && now.getTime() - seen <= ONLINE_GRACE_MS) return 'online'
  }
  return 'offline'
}

export const DEVICE_STATUS_LABEL: Record<WbDeviceStatus, string> = {
  online: '在线',
  offline: '离线',
  revoked: '已解绑',
}

export function deviceStatusLabel(status: string): string {
  return DEVICE_STATUS_LABEL[status as WbDeviceStatus] ?? status
}

export const DEVICE_TYPE_LABEL: Record<string, string> = {
  desktop: '桌面电脑',
  tablet: '平板',
  box: '盒子',
  other: '其他',
}

export function deviceTypeLabel(t: string): string {
  return DEVICE_TYPE_LABEL[t] ?? t
}

/** 解绑二次确认（C 级）文案 */
export const DEVICE_REVOKE_CONFIRM_TEXT = '解绑后设备将立即离线，需重新配对'

// ─── 设备凭证（dt_，方案 a「工作台即设备」：本机保存 + 心跳保活）──────────────

/** 设备凭证格式：dt_ + 48 hex（与后端 zod deviceTokenInput 一致） */
export const DEVICE_TOKEN_RE = /^dt_[0-9a-f]{48}$/

export function isDeviceToken(token: string | null | undefined): boolean {
  return typeof token === 'string' && DEVICE_TOKEN_RE.test(token.trim())
}

/** localStorage 键：本机设备凭证（设计内行为——工作台即设备，dt_ 明文仅此落盘点） */
export const WB_DEVICE_CREDENTIAL_KEY = 'wb_device_credential'

/** 心跳周期：30s（后端在线宽限 ONLINE_GRACE_MS 的 1/3） */
export const HEARTBEAT_INTERVAL_MS = 30_000

export interface WbDeviceCredential {
  deviceId: number
  deviceToken: string
}

interface CredentialStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function defaultStorage(): CredentialStorage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

/** 校验并归一凭证形状；任何不符返回 null（绝不修复/猜测） */
export function normalizeDeviceCredential(raw: unknown): WbDeviceCredential | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as { deviceId?: unknown; deviceToken?: unknown }
  const deviceId = Number(c.deviceId)
  if (!Number.isInteger(deviceId) || deviceId <= 0) return null
  if (typeof c.deviceToken !== 'string' || !isDeviceToken(c.deviceToken)) return null
  return { deviceId, deviceToken: c.deviceToken.trim() }
}

/** 保存本机设备凭证；形状非法或存储不可用返回 false（不落半成品） */
export function saveDeviceCredential(
  cred: unknown,
  storage: CredentialStorage | null = defaultStorage(),
): boolean {
  const valid = normalizeDeviceCredential(cred)
  if (!valid || !storage) return false
  try {
    storage.setItem(WB_DEVICE_CREDENTIAL_KEY, JSON.stringify(valid))
    return true
  } catch {
    return false
  }
}

/** 读取本机设备凭证；缺失/损坏/形状非法一律 null（读取失败不抛） */
export function loadDeviceCredential(
  storage: CredentialStorage | null = defaultStorage(),
): WbDeviceCredential | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(WB_DEVICE_CREDENTIAL_KEY)
    if (!raw) return null
    return normalizeDeviceCredential(JSON.parse(raw))
  } catch {
    return null
  }
}

/** 清除本机设备凭证（解绑/凭证失效/重配对时调用；幂等） */
export function clearDeviceCredential(storage: CredentialStorage | null = defaultStorage()): void {
  if (!storage) return
  try {
    storage.removeItem(WB_DEVICE_CREDENTIAL_KEY)
  } catch {
    // 存储不可用：无物可清
  }
}

// ─── 心跳循环（模块级单例：严格模式双挂载/多组件共存仅一条循环）──────────────

export interface HeartbeatLoopOptions {
  /** 单次心跳（wbPair.heartbeat，body 注入 dt_）；抛错由循环分类处理 */
  beat: () => Promise<unknown>
  /** 判定错误是否为凭证失效（UNAUTHORIZED：设备已被解绑/重配对） */
  isUnauthorized: (err: unknown) => boolean
  /** 凭证失效回调：清除本地凭证（循环已先行停止） */
  onUnauthorized: () => void
  intervalMs?: number
}

export interface HeartbeatHandle {
  stop: () => void
  running: () => boolean
}

/**
 * 启动心跳循环：立即打一拍，随后每 intervalMs 一拍。
 * - beat 抛 UNAUTHORIZED → 停循环并回调 onUnauthorized；
 * - 其它错误（网络抖动等）静默，下个周期重试；
 * - 拍内耗时超过周期不叠加（同拍并发守卫）。
 */
export function startHeartbeatLoop(opts: HeartbeatLoopOptions): HeartbeatHandle {
  const intervalMs = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS
  let stopped = false
  let inflight = false
  const tick = () => {
    if (stopped || inflight) return
    inflight = true
    opts
      .beat()
      .catch((err: unknown) => {
        if (opts.isUnauthorized(err)) {
          handle.stop()
          opts.onUnauthorized()
        }
        // 其它错误静默重试
      })
      .finally(() => {
        inflight = false
      })
  }
  const timer = setInterval(tick, intervalMs)
  const handle: HeartbeatHandle = {
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
    },
    running: () => !stopped,
  }
  tick()
  return handle
}

let singletonLoop: HeartbeatHandle | null = null

/** 模块级单例启动：已存在的循环先停（重启语义），保证全应用至多一条心跳循环 */
export function startDeviceHeartbeatSingleton(opts: HeartbeatLoopOptions): HeartbeatHandle {
  stopDeviceHeartbeat()
  singletonLoop = startHeartbeatLoop(opts)
  return singletonLoop
}

/** 停止单例循环（凭证失效/本机设备被解绑时调用；组件卸载不调——跨页面保活） */
export function stopDeviceHeartbeat(): void {
  singletonLoop?.stop()
  singletonLoop = null
}

export function deviceHeartbeatRunning(): boolean {
  return singletonLoop?.running() ?? false
}

// ─── 服务端响应类型（仅声明前端用到的形状）──────────────────────────────────

/** wbPair.open 输出（code 明文仅此一次，绝不落盘/打日志） */
export interface WbPairOpenResult {
  code: string
  qrPayload: PairQrPayload
  expiresAt: string | Date
}

/** wbPair.status 输出（本工作台即设备：首次拉取含 deviceToken 明文，仅存入 wb_device_credential 一处） */
export interface WbPairStatusResult {
  state: 'pending' | 'claimed' | 'expired'
  deviceId?: number
  deviceName?: string
  factoryName?: string | null
  deviceToken?: string // dt_ 明文仅首次 status 拉取返回一次（后端原子置 tokenPulledAt）
}

/** wbPair.list 行（绝不含 tokenHash；fingerprint 仅前 8 位） */
export interface WbDeviceRow {
  deviceId: number
  name: string
  deviceType: string
  status: WbDeviceStatus
  lastSeenAt: string | Date | null
  createdAt: string | Date
  claimedByName: string | null
  fingerprintHint: string
}
