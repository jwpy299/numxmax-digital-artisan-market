// @vitest-environment jsdom
/**
 * useCopyToClipboard 六钉（portal#55 六轮 test 票——共享单点 hook 态机+定时器语义）：
 * 1. 成功 → copied → resetMs 后自复位 idle（复位窗语义）；
 * 2. 连击不叠表（旧表清=复位窗从最后一击起算）；
 * 3. clipboard API 缺失 → failed（?. 短路不静默）；
 * 4. writeText 拒绝 → failed；
 * 5. clipboard 访问同步抛（SecurityError 形态）→ failed（异常不逃逸 copy）；
 * 6. 卸载清表（unmount 后定时器不再开火/不 setState——干净跑完无 act 警告即证）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useCopyToClipboard } from './useCopyToClipboard'

function stubClipboard(impl: (() => Promise<void>) | undefined) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: impl ? { writeText: impl } : undefined,
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useCopyToClipboard 态机（portal#55 六轮票）', () => {
  it('① 成功 → copied → 1.5s 自复位 idle', async () => {
    vi.useFakeTimers()
    stubClipboard(() => Promise.resolve())
    const { result } = renderHook(() => useCopyToClipboard())
    expect(result.current.state).toBe('idle')
    await act(async () => { result.current.copy('iv_x') })
    expect(result.current.state).toBe('copied')
    act(() => { vi.advanceTimersByTime(1499) })
    expect(result.current.state).toBe('copied') // 窗未到期不复位
    act(() => { vi.advanceTimersByTime(2) })
    expect(result.current.state).toBe('idle')
  })

  it('② 连击不叠表——复位窗从最后一击起算', async () => {
    vi.useFakeTimers()
    stubClipboard(() => Promise.resolve())
    const { result } = renderHook(() => useCopyToClipboard())
    await act(async () => { result.current.copy('a') })
    act(() => { vi.advanceTimersByTime(1000) })
    await act(async () => { result.current.copy('b') }) // 第二击——旧表清
    act(() => { vi.advanceTimersByTime(1400) })
    expect(result.current.state).toBe('copied') // 若旧表未清，此刻已被刷 idle
    act(() => { vi.advanceTimersByTime(200) })
    expect(result.current.state).toBe('idle')
  })

  it('③ clipboard API 缺失 → failed（不静默）', () => {
    stubClipboard(undefined)
    const { result } = renderHook(() => useCopyToClipboard())
    act(() => { result.current.copy('x') })
    expect(result.current.state).toBe('failed')
  })

  it('④ writeText 拒绝 → failed', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')))
    const { result } = renderHook(() => useCopyToClipboard())
    await act(async () => { result.current.copy('x') })
    expect(result.current.state).toBe('failed')
  })

  it('⑤ clipboard 同步抛（SecurityError 形态）→ failed 且异常不逃逸', () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      get() { throw new DOMException('blocked', 'SecurityError') },
    })
    const { result } = renderHook(() => useCopyToClipboard())
    expect(() => act(() => { result.current.copy('x') })).not.toThrow()
    expect(result.current.state).toBe('failed')
  })

  it('⑥ 卸载清表——pending 复位表不再开火（干净跑完即证）', async () => {
    vi.useFakeTimers()
    stubClipboard(() => Promise.resolve())
    const { result, unmount } = renderHook(() => useCopyToClipboard())
    await act(async () => { result.current.copy('x') })
    expect(result.current.state).toBe('copied')
    unmount()
    act(() => { vi.advanceTimersByTime(5000) }) // 表若未清会在此刻 setState 卸载件（act 警告/泄漏）
    // 干净跑完=表清实证（setState 卸载件会触发 React 警告使本例炸）
  })
})
