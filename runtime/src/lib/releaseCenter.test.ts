/**
 * releaseCenter web 适配器（admin 超终用）单元测试。
 *
 * 闸点：
 * 1. 七方法全部以 query 通道打 releaseCenter.<proc> 路径；
 * 2. token 由 callWb 注入请求体（适配器自身绝不拼 URL/header）；
 * 3. 可选参数省略时不带字段（list 无 channel / audit 无 releaseId）；
 * 4. 未登录（session=null）一律拒绝且不发请求。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { callWbMock } = vi.hoisted(() => ({ callWbMock: vi.fn() }))
vi.mock('./wbSession', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./wbSession')>()
  return { ...orig, callWb: callWbMock }
})

import {
  rcAdvise, rcAudit, rcConfirmTicket, rcList, rcMarkVerified, rcPropose, rcRequestTicket,
} from './releaseCenter'
import type { WbSession } from './wbSession'

const SESSION = { token: 'tk-test' } as WbSession

beforeEach(() => {
  callWbMock.mockReset()
  callWbMock.mockResolvedValue({ ok: true })
})

describe('releaseCenter web 适配器', () => {
  it('list：query 通道；无 channel 不带字段，有则透传', async () => {
    await rcList(SESSION)
    expect(callWbMock).toHaveBeenCalledWith('query', 'releaseCenter.list', SESSION, {})
    await rcList(SESSION, 'app_apk')
    expect(callWbMock).toHaveBeenCalledWith('query', 'releaseCenter.list', SESSION, { channel: 'app_apk' })
  })

  it('propose / markVerified：字段透传', async () => {
    const p = { channel: 'wb' as const, version: 'v1.5.0', note: '工作台更新' }
    await rcPropose(SESSION, p)
    expect(callWbMock).toHaveBeenCalledWith('query', 'releaseCenter.propose', SESSION, p)
    const v = { releaseId: 3, verifier: 'v124', reportRef: 'runs/x.json' }
    await rcMarkVerified(SESSION, v)
    expect(callWbMock).toHaveBeenCalledWith('query', 'releaseCenter.markVerified', SESSION, v)
  })

  it('requestTicket / confirmTicket：双签链路路径与参数', async () => {
    await rcRequestTicket(SESSION, 3, 'publish')
    expect(callWbMock).toHaveBeenCalledWith('query', 'releaseCenter.requestTicket', SESSION,
      { releaseId: 3, action: 'publish' })
    await rcConfirmTicket(SESSION, 'RLT-ABC123456789')
    expect(callWbMock).toHaveBeenCalledWith('query', 'releaseCenter.confirmTicket', SESSION,
      { ticketNo: 'RLT-ABC123456789' })
  })

  it('audit / advise：可选参数省略时不带字段', async () => {
    await rcAudit(SESSION)
    expect(callWbMock).toHaveBeenCalledWith('query', 'releaseCenter.audit', SESSION, { limit: 50 })
    await rcAudit(SESSION, 9, 20)
    expect(callWbMock).toHaveBeenCalledWith('query', 'releaseCenter.audit', SESSION, { releaseId: 9, limit: 20 })
    await rcAdvise(SESSION, 9)
    expect(callWbMock).toHaveBeenCalledWith('query', 'releaseCenter.advise', SESSION, { releaseId: 9 })
  })

  it('未登录：七方法一律拒绝且不发请求（纵深防御）', async () => {
    await expect(rcList(null)).rejects.toThrow('未登录')
    await expect(rcPropose(null, { channel: 'wb', version: 'v1' })).rejects.toThrow('未登录')
    await expect(rcMarkVerified(null, { releaseId: 1, verifier: 'v124' })).rejects.toThrow('未登录')
    await expect(rcRequestTicket(null, 1, 'publish')).rejects.toThrow('未登录')
    await expect(rcConfirmTicket(null, 'RLT-XXXXXXXXXXXX')).rejects.toThrow('未登录')
    await expect(rcAudit(null)).rejects.toThrow('未登录')
    await expect(rcAdvise(null, 1)).rejects.toThrow('未登录')
    expect(callWbMock).not.toHaveBeenCalled()
  })
})
