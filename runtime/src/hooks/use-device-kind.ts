/**
 * useDeviceKind —— 设备类型单源判定（波四片 2 罚单归一：GetApp/HeroSection 同引，不再各写内联 UA 正则）。
 *
 * 三态：android / ios / pc。
 * iPadOS 13+ 桌面级 UA（Macintosh + Mobile/15E148）：以 maxTouchPoints>1 判 iOS——
 * iPad 装不了 Windows 安装程序，归移动面（给 APP/iOS 诚实条）。
 * 注意与 useIsMobile（视口宽 <768，响应式面）语义不同：本 hook 判「设备形态」，用于下载分流。
 */
import { useMemo } from 'react'

export type DeviceKind = 'android' | 'ios' | 'pc'

export function deviceKindOf(ua: string, maxTouchPoints: number): DeviceKind {
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  // iPadOS 13+ 桌面级 UA：Macintosh 皮 + 触屏心
  if (/Macintosh/i.test(ua) && maxTouchPoints > 1) return 'ios'
  return 'pc'
}

export function useDeviceKind(): DeviceKind {
  return useMemo(
    () => deviceKindOf(navigator.userAgent, navigator.maxTouchPoints ?? 0),
    [],
  )
}
