// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import AgentEmployment from './AgentEmployment'

const mocks = vi.hoisted(() => ({ factoryLoading: false, myWorkLoading: false, myWorkTotals: 150, myWorkOffsets: [] as number[] }))

vi.mock('@/lib/wbSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/wbSession')>()
  return {
    ...actual,
    useWbSession: () => ({ session: { token: 'test-session', factoryId: 1, role: 'owner' } }),
    useWbQuery: (name: string, _session: unknown, input: { offset?: number }) => {
      if (name === 'agentWork.factory') return { data: undefined, loading: mocks.factoryLoading, error: null, refetch: vi.fn() }
      if (name === 'agentWork.identity') return { data: { departmentId: 'dept-a', orgRole: 'admin' }, loading: false, error: null, refetch: vi.fn() }
      if (name === 'agentWork.mine') {
        const offset = Number(input.offset ?? 0)
        mocks.myWorkOffsets.push(offset)
        const data = mocks.myWorkLoading ? undefined : { limit: 100, offset, applications: [], claims: [], wages: [], totals: { applications: mocks.myWorkTotals, claims: 0, wages: 0 } }
        return { data, loading: mocks.myWorkLoading, error: null, refetch: vi.fn() }
      }
      return { data: undefined, loading: false, error: null, refetch: vi.fn() }
    },
    callWb: vi.fn(async () => ({})),
  }
})
vi.mock('@/components/wb/ui', () => ({ WbError: () => null, WbLoading: ({ text }: { text: string }) => <div>{text}</div>, WbNotice: () => null }))

beforeEach(() => { mocks.factoryLoading = false; mocks.myWorkLoading = false; mocks.myWorkTotals = 150; mocks.myWorkOffsets = [] })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
describe('AgentEmployment 深链 tab', () => {
  it('?tab=enterprise 落到企业工作管理', () => {
    render(<MemoryRouter initialEntries={['/agent-employment?tab=enterprise']}><AgentEmployment /></MemoryRouter>)
    expect(screen.getByRole('button', { name: '企业工作管理' }).className).toContain('border-pulse-cyan')
  })
  it('?tab=market 落到岗位与任务市场', () => {
    render(<MemoryRouter initialEntries={['/agent-employment?tab=market']}><AgentEmployment /></MemoryRouter>)
    expect(screen.getByRole('button', { name: '岗位与任务市场' }).className).toContain('border-pulse-cyan')
  })

  it('企业查询加载中显示加载态，不提前渲染零列表', () => {
    mocks.factoryLoading = true
    render(<MemoryRouter initialEntries={['/agent-employment?tab=enterprise']}><AgentEmployment /></MemoryRouter>)
    expect(screen.getByText('读取企业任务与交付')).toBeTruthy()
    expect(screen.queryByText('岗位应聘复核（0）')).toBeNull()
  })
  it('下一页加载清空旧 data 时仍保持目标 offset', async () => {
    const { rerender } = render(<MemoryRouter initialEntries={['/agent-employment?tab=market']}><AgentEmployment /></MemoryRouter>)
    mocks.myWorkLoading = true
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(mocks.myWorkOffsets[mocks.myWorkOffsets.length - 1]).toBe(100))
    mocks.myWorkLoading = false
    rerender(<MemoryRouter initialEntries={['/agent-employment?tab=market']}><AgentEmployment /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/第\s*2\/2\s*页/)).toBeTruthy())
    expect(mocks.myWorkOffsets[mocks.myWorkOffsets.length - 1]).toBe(100)
  })
  it('我的交付总数缩小时自动夹回有效页 offset', async () => {
    const { rerender } = render(<MemoryRouter initialEntries={['/agent-employment?tab=market']}><AgentEmployment /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(mocks.myWorkOffsets[mocks.myWorkOffsets.length - 1]).toBe(100))
    mocks.myWorkTotals = 50
    rerender(<MemoryRouter initialEntries={['/agent-employment?tab=market']}><AgentEmployment /></MemoryRouter>)
    await waitFor(() => expect(mocks.myWorkOffsets[mocks.myWorkOffsets.length - 1]).toBe(0))
  })
})
