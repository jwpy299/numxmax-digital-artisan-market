// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Login from './Login'

const mocks = vi.hoisted(() => ({ save: vi.fn(), navigate: vi.fn() }))
vi.mock('@/lib/wbSession', () => ({
  saveWbSession: mocks.save,
  wbMutation: vi.fn(async () => ({ kind: 'enterprise' })),
  wbErrorMessage: (error: unknown) => String(error),
}))
vi.mock('react-router', async (importOriginal) => ({ ...await importOriginal<typeof import('react-router')>(), useNavigate: () => mocks.navigate }))
vi.mock('@/components/HudCorner', () => ({ default: () => null }))
vi.mock('@/components/auth/PortalRegisterForms', () => ({
  EntRegisterForm: ({ onSuccess }: { onSuccess: (session: { kind: string }) => void }) => <button onClick={() => onSuccess({ kind: 'enterprise' })}>模拟企业注册成功</button>,
  PersonRegisterForm: ({ onSuccess }: { onSuccess: (session: { kind: string }) => void }) => <button onClick={() => onSuccess({ kind: 'person' })}>模拟个人注册成功</button>,
}))
vi.mock('@/components/auth/SmsCodeRow', () => ({ SmsCodeRow: () => null }))
vi.mock('@/components/wb/ui', () => ({ WbError: ({ message }: { message: string }) => <div>{message}</div>, wbInputCls: '', wbLabelCls: '' }))

afterEach(() => { cleanup(); vi.clearAllMocks() })
describe('Login 注册后本地会话保存失败', () => {
  it('账号已创建时切到登录并禁止重复注册，不触发跳转', () => {
    mocks.save.mockReturnValue({ ok: false, error: '存储失败' })
    render(<MemoryRouter><Login /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: '企业注册' }))
    fireEvent.click(screen.getByRole('button', { name: '模拟企业注册成功' }))
    expect(screen.getByText(/账号已创建，但本地会话保存失败，请直接登录，禁止重复注册/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '模拟企业注册成功' })).toBeNull()
    expect(document.querySelector('button[type="submit"]')!).toBeTruthy()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
  it('普通登录保存失败保留原错误且不切 tab', async () => {
    mocks.save.mockReturnValue({ ok: false, error: '存储失败' })
    render(<MemoryRouter><Login /></MemoryRouter>)
    fireEvent.change(screen.getByPlaceholderText('注册时使用的手机号'), { target: { value: '13800138000' } })
    fireEvent.change(screen.getByPlaceholderText('登录密码'), { target: { value: 'test-password' } })
    fireEvent.click(document.querySelector('button[type="submit"]')!)
    expect(await screen.findByText('存储失败')).toBeTruthy()
    expect(screen.queryByText(/账号已创建/)).toBeNull()
    expect(document.querySelector('button[type="submit"]')!).toBeTruthy()
  })
})
