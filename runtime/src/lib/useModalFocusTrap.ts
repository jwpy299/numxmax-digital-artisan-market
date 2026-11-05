import { useEffect, useRef, type RefObject } from 'react'

const FOCUS_RETRY_MS = 600
const FOCUS_RETRY_INTERVAL_MS = 50

type ElementRef = RefObject<HTMLElement | null>

let bodyLockCount = 0
let originalBodyOverflow: string | null = null
const trapStack: { token: symbol; containerRef: ElementRef }[] = []

function canReceiveFocus(element: HTMLElement | null): element is HTMLElement {
  return Boolean(element?.isConnected && element.getClientRects().length > 0 && !element.hasAttribute('disabled') && window.getComputedStyle(element).visibility !== 'hidden')
}
function isTabbableCandidate(element: HTMLElement): boolean {
  if (!canReceiveFocus(element) || element.tabIndex < 0 || element.closest('[inert]')) return false
  if (element.closest('fieldset:disabled')) return false
  return true
}

interface ModalFocusTrapOptions {
  open: boolean
  containerRef: ElementRef
  initialFocusRef: ElementRef
  restoreFocusRef?: ElementRef
  onClose: () => void
  /** 调用方传入与 CSS 断点一致的 media query；未传入时不按宽度自动关闭。 */
  closeOnMediaQuery?: string
}

/** 移动抽屉与确认弹窗共用：body 锁、Escape、Tab 循环、焦点恢复及可选桌面断点收口。 */
export function useModalFocusTrap({ open, containerRef, initialFocusRef, restoreFocusRef, onClose, closeOnMediaQuery }: ModalFocusTrapOptions) {
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  useEffect(() => {
    if (!open) return
    const mql = closeOnMediaQuery ? window.matchMedia(closeOnMediaQuery) : null
    if (mql?.matches) { onCloseRef.current(); return }
    const trapToken = Symbol('modal-focus-trap')
    trapStack.push({ token: trapToken, containerRef })
    const container = containerRef.current
    const previousTabIndex = container?.getAttribute('tabindex') ?? null
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (bodyLockCount === 0) originalBodyOverflow = document.body.style.overflow
    bodyLockCount += 1
    document.body.style.overflow = 'hidden'
    let focusTimer: number | null = null
    const focusDeadline = Date.now() + FOCUS_RETRY_MS
    const focusInitial = () => {
      if (trapStack[trapStack.length - 1]?.token !== trapToken) return
      const target = initialFocusRef.current
      if (!target) {
        if (Date.now() < focusDeadline) focusTimer = window.setTimeout(focusInitial, FOCUS_RETRY_INTERVAL_MS)
        else container?.focus()
        return
      }
      if (container?.contains(document.activeElement)) return
      target.focus()
      if (document.activeElement === target) return
      if (Date.now() >= focusDeadline) {
        container?.focus()
        return
      }
      focusTimer = window.setTimeout(focusInitial, FOCUS_RETRY_INTERVAL_MS)
    }
    container?.setAttribute('tabindex', '-1')
    focusInitial()

    const onBreakpoint = () => { if (mql?.matches) onCloseRef.current() }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const focusedElement = document.activeElement
      const owner = [...trapStack].reverse().find((trap) => trap.containerRef.current?.contains(focusedElement)) ?? trapStack[trapStack.length - 1]
      if (owner?.token !== trapToken) return
      if (event.key === 'Escape') {
        event.stopPropagation()
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const container = containerRef.current
      if (!container) return
      const focusable = Array.from(container.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [contenteditable]:not([contenteditable="false"]), audio[controls], video[controls], iframe, [tabindex]:not([tabindex="-1"])'))
        .filter(isTabbableCandidate)
      if (focusable.length === 0) {
        event.preventDefault()
        container.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const activeElement = document.activeElement
      const focusInside = activeElement !== container && container.contains(activeElement)
      if (focusInside && !focusable.includes(activeElement as HTMLElement)) {
        event.preventDefault()
        const target = event.shiftKey ? last : first
        target.focus()
        return
      }
      if (event.shiftKey && (activeElement === first || !focusInside)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (activeElement === last || !focusInside)) {
        event.preventDefault()
        first.focus()
      }
    }
    mql?.addEventListener('change', onBreakpoint)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      const stackIndex = trapStack.findIndex((trap) => trap.token === trapToken)
      if (stackIndex >= 0) trapStack.splice(stackIndex, 1)
      if (focusTimer !== null) window.clearTimeout(focusTimer)
      mql?.removeEventListener('change', onBreakpoint)
      document.removeEventListener('keydown', onKeyDown)
      const ownedFocus = container?.contains(document.activeElement) ?? false
      bodyLockCount = Math.max(0, bodyLockCount - 1)
      if (bodyLockCount === 0) {
        document.body.style.overflow = originalBodyOverflow ?? ''
        originalBodyOverflow = null
      }
      if (trapStack.length === 0 || ownedFocus || document.activeElement === document.body) {
        const previousUsable = previousFocus !== null && previousFocus !== document.body && previousFocus !== document.documentElement && canReceiveFocus(previousFocus)
        if (previousUsable) previousFocus.focus()
        let focusRestored = previousUsable && document.activeElement === previousFocus
        if (!focusRestored) {
          const fallback = restoreFocusRef?.current ?? null
          if (canReceiveFocus(fallback)) {
            fallback.focus()
            focusRestored = document.activeElement === fallback
          }
        }
        if (!focusRestored && canReceiveFocus(container)) container.focus()
      }
      // 焦点尝试完成后才还原，避免恢复目标或新节点继承错误的 tabindex。
      if (previousTabIndex === null) container?.removeAttribute('tabindex')
      else container?.setAttribute('tabindex', previousTabIndex)
    }
  }, [open, closeOnMediaQuery, containerRef, initialFocusRef, restoreFocusRef])
}
