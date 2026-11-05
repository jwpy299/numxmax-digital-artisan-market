/**
 * useCopyToClipboard —— 复制到剪贴板共享 hook（portal#55 复审票收口单点）。
 *
 * 三态机 idle/copied/failed（互斥天然成立——双旗标 copied+fail 同真矛盾态封死）；
 * 1.5s 复位窗（可配）+clipboard API 缺失/同步抛双显式判（?. 短路整链+SecurityError 逃逸=静默坑双钉）+复位定时器 unmount/重击两路清。
 * 迁移面挂账 P-COPY-HOOK-SWEEP：AdminBeta/Packages/WbLingshuPanel(InviteCopyCard) 内联复刻下轮收口换引本件。
 */
import { useEffect, useRef, useState } from 'react'

export type CopyState = 'idle' | 'copied' | 'failed'

export function useCopyToClipboard(resetMs = 1500) {
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)
  // 清表单点（portal#55 五轮票：失败路不清挂起表=旧表误把 failed 刷回 idle——定时器只许属于约它的那个态）
  function clearTimer() {
    if (timer.current) clearTimeout(timer.current)
  }
  // mounted 闸（五轮票：卸载后晚到的 resolve 会约新表+setState 卸载件=泄漏——effect 体重置 true 兼容 StrictMode 双挂）
  useEffect(() => {
    mounted.current = true
    // cleanup 内联 clearTimeout（portal#55 六轮票：clearTimer 每渲染新建——入 [] 依赖 exhaustive-deps 告警面封死）
    return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current) }
  }, [])

  function copy(text: string) {
    // 同步抛也兜（portal#55 六轮票：SecurityError[跨域 iframe/permissions-policy]+writeText 同步 throw=
    // 异常逃逸 copy() .catch 永不跑=state 卡 idle 静默面封死——WbOrg.copyInviteLink 同 pattern）
    let write: Promise<void> | undefined
    try {
      write = navigator.clipboard?.writeText(text)
    } catch {
      clearTimer(); setState('failed'); return
    }
    if (!write) { clearTimer(); setState('failed'); return } // API 缺失（HTTP 面/老浏览器）——显式判不静默
    write
      .then(() => {
        if (!mounted.current) return
        setState('copied')
        clearTimer() // 重击先清旧表——连点不叠表
        timer.current = setTimeout(() => setState('idle'), resetMs)
      })
      .catch(() => { if (!mounted.current) return; clearTimer(); setState('failed') })
  }

  return { state, copy } as const
}
