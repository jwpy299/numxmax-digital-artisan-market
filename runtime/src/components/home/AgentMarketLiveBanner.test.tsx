// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import AgentMarketLiveBanner from './AgentMarketLiveBanner'

const mocks = vi.hoisted(() => ({ reduced: vi.fn(() => false), refetch: vi.fn() }))
vi.mock('@/lib/wbSession', () => ({
  useWbSession: () => ({ session: { token: 'test-session' } }),
  useWbQuery: () => ({ data: { items: [
    { id: 'job-1', kind: 'job', title: '任务一', actor: '公开企业', status: 'open', occurredAt: '2026-11-05T00:00:00Z', evidenceSha256: null },
    { id: 'job-2', kind: 'job', title: '任务二', actor: '公开企业', status: 'claimed', occurredAt: '2026-11-05T00:01:00Z', evidenceSha256: null },
  ], feedVersion: 'v1', serverTime: '2026-11-05T00:02:00Z', source: 'mysql' }, loading: false, error: null, refetch: mocks.refetch }),
  wbStreamUrl: () => 'http://test/sse',
}))
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>()
  return { ...actual, useReducedMotion: () => mocks.reduced() }
})
vi.mock('@/components/wb/ui', () => ({ WbError: () => null, WbLoading: () => null }))

class FakeEventSource {
  static instances: FakeEventSource[] = []
  listeners = new Map<string, Array<(event: unknown) => void>>()
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  close = vi.fn()
  url: string
  constructor(url: string) { this.url = url; FakeEventSource.instances.push(this) }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  emit(type: string, data?: unknown) { for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) }) }
}

describe('AgentMarketLiveBanner SSE 与无障碍', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeEventSource.instances = []
    mocks.reduced.mockReturnValue(false)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.stubGlobal('EventSource', FakeEventSource)
  })
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('指数退避最多五次，达到上限后停止，有效 Feed 才重置', () => {
    render(<MemoryRouter><AgentMarketLiveBanner /></MemoryRouter>)
    expect(FakeEventSource.instances).toHaveLength(1)
    const delays = [1000, 2000, 4000, 8000, 16000]
    for (const [index, delay] of delays.entries()) {
      const source = FakeEventSource.instances[index]
      act(() => { source.onerror?.() })
      act(() => { vi.advanceTimersByTime(delay) })
      expect(FakeEventSource.instances).toHaveLength(index + 2)
    }
    act(() => { FakeEventSource.instances[5].onerror?.() })
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(FakeEventSource.instances).toHaveLength(6)
  })

  it('degraded 后展示最近快照和降级状态，不继续宣称实时已连接', () => {
    render(<MemoryRouter><AgentMarketLiveBanner /></MemoryRouter>)
    const source = FakeEventSource.instances[0]
    act(() => { source.emit('feed', { items: [], feedVersion: 'v2', serverTime: '2026-11-05T00:03:00Z', source: 'mysql' }) })
    expect(screen.getByText('实时事件流已连接')).toBeTruthy()
    act(() => { source.emit('degraded', { message: '快照暂时不可用，继续重连' }) })
    expect(screen.getByText('实时连接中断，展示最近已验证快照并重连')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('心跳健康后可恢复 live，即使 feedVersion 未变化', () => {
    render(<MemoryRouter><AgentMarketLiveBanner /></MemoryRouter>)
    const source = FakeEventSource.instances[0]
    act(() => { source.emit('feed', { items: [], feedVersion: 'v2', serverTime: '2026-11-05T00:03:00Z', source: 'mysql' }) })
    act(() => { source.emit('degraded', { message: '快照暂时不可用，继续重连' }) })
    expect(screen.getByText('实时连接中断，展示最近已验证快照并重连')).toBeTruthy()
    act(() => { source.emit('heartbeat', { serverTime: '2026-11-05T00:04:00Z', feedVersion: 'v2', degraded: false }) })
    expect(screen.getByText('实时事件流已连接')).toBeTruthy()
  })

  it('revoked 关闭且永不重连', () => {
    render(<MemoryRouter><AgentMarketLiveBanner /></MemoryRouter>)
    const source = FakeEventSource.instances[0]
    act(() => { source.emit('revoked') })
    expect(source.close).toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('减少动态效果时停止自动轮播并使用明确按钮标签', () => {
    mocks.reduced.mockReturnValue(true)
    render(<MemoryRouter><AgentMarketLiveBanner /></MemoryRouter>)
    expect(screen.getByRole('button', { name: '减少动态效果已启用' })).toHaveProperty('disabled', true)
    expect(screen.getByText('任务一')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(screen.getByText('任务一')).toBeTruthy()
    expect(document.querySelector('article')?.getAttribute('aria-live')).toBe('polite')
  })

  it('普通自动轮播不通过 aria-live 打断读屏', () => {
    render(<MemoryRouter><AgentMarketLiveBanner /></MemoryRouter>)
    expect(document.querySelector('article')?.getAttribute('aria-live')).toBe('off')
  })

  it('发布与领取 CTA 使用共享路由并保留 tab 参数', () => {
    render(<MemoryRouter><AgentMarketLiveBanner /></MemoryRouter>)
    expect(screen.getByRole('link', { name: '发布工作任务' }).getAttribute('href')).toContain('/agent-employment?tab=enterprise')
    expect(screen.getByRole('link', { name: '领取工作任务' }).getAttribute('href')).toContain('/agent-employment?tab=market')
  })

})
