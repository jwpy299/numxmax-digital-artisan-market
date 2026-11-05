// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { useModalFocusTrap } from './useModalFocusTrap'

function Harness({ open, onClose, mediaQuery, initialMissing = false }: { open: boolean; onClose: () => void; mediaQuery?: string; initialMissing?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const initialFocusRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef<HTMLButtonElement>(null)
  useModalFocusTrap({ open, containerRef, initialFocusRef, restoreFocusRef, onClose, closeOnMediaQuery: mediaQuery })
  return <>
    <button ref={restoreFocusRef}>恢复焦点</button>
    <div data-testid="trap-container" ref={containerRef} style={{ display: open ? 'block' : 'none' }}>{!initialMissing && <button ref={initialFocusRef} style={{ display: open ? 'inline-block' : 'none' }}>关闭</button>}<a href="#target">导航链接</a><button tabIndex={-1}>仅程序焦点</button><div inert><button>inert 按钮</button></div><fieldset disabled><button>禁用域按钮</button></fieldset><div contentEditable suppressContentEditableWarning tabIndex={-1}>不可 Tab 编辑区</div></div>
  </>
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return (this.style.display === 'none' ? [] : [{}]) as unknown as DOMRectList
  })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); cleanup(); document.body.style.overflow = '' })

describe('useModalFocusTrap', () => {
  it('嵌套两层锁逐个关闭仍正确还原 overflow', () => {
    document.body.style.overflow = 'scroll'
    const first = render(<Harness open onClose={() => undefined} />)
    const second = render(<Harness open onClose={() => undefined} />)
    expect(document.body.style.overflow).toBe('hidden')
    second.unmount()
    expect(document.body.style.overflow).toBe('hidden')
    first.unmount()
    expect(document.body.style.overflow).toBe('scroll')
  })

  it('打开聚焦初始按钮，Escape 关闭并回到恢复按钮', async () => {
    const onClose = vi.fn()
    const { rerender } = render(<Harness open onClose={onClose} />)
    await waitFor(() => expect(document.activeElement?.textContent).toBe('关闭'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    rerender(<Harness open={false} onClose={onClose} />)
    await waitFor(() => expect(document.activeElement?.textContent).toBe('恢复焦点'))
  })

  it('断点命中自动关闭', () => {
    const listeners: Array<() => void> = []
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: (_name: string, fn: () => void) => { listeners.push(fn) }, removeEventListener: vi.fn() })))
    const onClose = vi.fn()
    render(<Harness open onClose={onClose} mediaQuery="(min-width: 1024px)" />)
    expect(onClose).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('Tab 不把 tabindex=-1 的元素误当最后一个焦点停靠点', async () => {
    render(<Harness open onClose={() => undefined} />)
    await waitFor(() => expect(document.activeElement?.textContent).toBe('关闭'))
    const link = document.querySelector('a')!
    link.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement?.textContent).toBe('关闭')
  })

  it('内部控件已处理 Escape 时不重复关闭弹层', async () => {
    const onClose = vi.fn()
    render(<Harness open onClose={onClose} />)
    await waitFor(() => expect(document.activeElement?.textContent).toBe('关闭'))
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    event.preventDefault()
    document.dispatchEvent(event)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('初始焦点重试耗尽后至少聚焦容器', async () => {
    vi.useFakeTimers()
    render(<Harness open initialMissing onClose={() => undefined} />)
    await vi.advanceTimersByTimeAsync(650)
    expect(document.activeElement).toBe(screen.getByTestId('trap-container'))
  })

  it('IME 组合输入期间不截获 Escape', async () => {
    const onClose = vi.fn()
    render(<Harness open onClose={onClose} />)
    await waitFor(() => expect(document.activeElement?.textContent).toBe('关闭'))
    const event = new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('恢复目标不可见时不把焦点强推到页面首个按钮', async () => {
    const outside = document.createElement('button')
    outside.textContent = '页面首个按钮'
    document.body.prepend(outside)
    const { rerender } = render(<Harness open onClose={() => undefined} />)
    await waitFor(() => expect(document.activeElement?.textContent).toBe('关闭'))
    ;(screen.getByText('恢复焦点') as HTMLButtonElement).style.display = 'none'
    rerender(<Harness open={false} onClose={() => undefined} />)
    expect(document.activeElement).not.toBe(outside)
    outside.remove()
  })

  it('重试窗口内上层弹层打开后，下层不得抢回焦点', async () => {
    vi.useFakeTimers()
    const first = render(<Harness open initialMissing onClose={() => undefined} />)
    const second = render(<Harness open onClose={() => undefined} />)
    await vi.advanceTimersByTimeAsync(650)
    expect(document.activeElement?.textContent).toBe('关闭')
    expect(document.activeElement).not.toBe(screen.getAllByTestId('trap-container')[0])
    first.unmount()
    second.unmount()
  })

  it('焦点位于容器内非 tabbable 元素时也阻止逃逸', async () => {
    render(<Harness open onClose={() => undefined} />)
    await waitFor(() => expect(document.activeElement?.textContent).toBe('关闭'))
    const programmatic = screen.getByText('仅程序焦点')
    programmatic.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement?.textContent).toBe('关闭')
  })
})
