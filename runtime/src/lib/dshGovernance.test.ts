/**
 * dshGovernance web 适配器（wb/admin 共用）单元测试。
 *
 * 闸点：
 * 1. 九方法全部以 query 通道打 dshGovernance.<proc> 路径；
 * 2. token 由 callWb 注入请求体（适配器自身绝不拼 URL/header）；
 * 3. 输入透传（propose/trial 展开、contracts/audit 可选参数省略时不带字段）；
 * 4. 未登录（session=null）一律拒绝且不发请求；
 * 5. 客户端绝无 factoryId 字段（越权红线）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { callWbMock } = vi.hoisted(() => ({ callWbMock: vi.fn() }))
vi.mock('./wbSession', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./wbSession')>()
  return { ...orig, callWb: callWbMock }
})

import {
  dshGovAudit, dshGovConfirmTicket, dshGovContracts, dshGovEvaluate, dshGovPropose,
  dshGovRequestTicket, dshGovRetire, dshGovRollback, dshGovTrial,
} from './dshGovernance'
import type { WbSession } from './wbSession'

const SESSION = { token: 'tk-test' } as WbSession

beforeEach(() => {
  callWbMock.mockReset()
  callWbMock.mockResolvedValue({ ok: true })
})

describe('dshGovernance web 适配器', () => {
  it('contracts：query 通道 + 无参不带 status 字段', async () => {
    await dshGovContracts(SESSION)
    expect(callWbMock).toHaveBeenCalledWith('query', 'dshGovernance.contracts', SESSION, {})
    await dshGovContracts(SESSION, 'active')
    expect(callWbMock).toHaveBeenCalledWith('query', 'dshGovernance.contracts', SESSION, { status: 'active' })
  })

  it('propose：九字段透传（requestId 幂等键原样带上）', async () => {
    const input = {
      requestId: 'req-1', capabilityKey: 'invoice.ocr', kind: 'skill' as const,
      risk: 'C' as const, autonomy: 'L2' as const, permissions: ['invoice.read'], budgetMonthly: 500,
    }
    await dshGovPropose(SESSION, input)
    expect(callWbMock).toHaveBeenCalledWith('query', 'dshGovernance.propose', SESSION, input)
  })

  it('requestTicket / confirmTicket：双签链路路径与参数', async () => {
    await dshGovRequestTicket(SESSION, 7, 'rollback')
    expect(callWbMock).toHaveBeenCalledWith('query', 'dshGovernance.requestTicket', SESSION, { contractId: 7, action: 'rollback' })
    await dshGovConfirmTicket(SESSION, 'TKT-9')
    expect(callWbMock).toHaveBeenCalledWith('query', 'dshGovernance.confirmTicket', SESSION, { ticketNo: 'TKT-9' })
  })

  it('trial / evaluate / rollback / retire：路径与透传', async () => {
    const trial = { contractId: 3, success: true, cost: 2 }
    await dshGovTrial(SESSION, trial)
    expect(callWbMock).toHaveBeenCalledWith('query', 'dshGovernance.trial', SESSION, trial)
    await dshGovEvaluate(SESSION, 3)
    expect(callWbMock).toHaveBeenCalledWith('query', 'dshGovernance.evaluate', SESSION, { contractId: 3 })
    await dshGovRollback(SESSION, 3, 'r')
    expect(callWbMock).toHaveBeenCalledWith('query', 'dshGovernance.rollback', SESSION, { contractId: 3, reason: 'r' })
    await dshGovRetire(SESSION, 3, 'r')
    expect(callWbMock).toHaveBeenCalledWith('query', 'dshGovernance.retire', SESSION, { contractId: 3, reason: 'r' })
  })

  it('audit：可选 contractId', async () => {
    await dshGovAudit(SESSION)
    expect(callWbMock).toHaveBeenCalledWith('query', 'dshGovernance.audit', SESSION, {})
    await dshGovAudit(SESSION, 5)
    expect(callWbMock).toHaveBeenCalledWith('query', 'dshGovernance.audit', SESSION, { contractId: 5 })
  })

  it('未登录：九方法全部拒绝且零请求', async () => {
    const calls = [
      () => dshGovContracts(null), () => dshGovPropose(null, {} as never),
      () => dshGovRequestTicket(null, 1, 'retire'), () => dshGovConfirmTicket(null, 'T'),
      () => dshGovTrial(null, {} as never), () => dshGovEvaluate(null, 1),
      () => dshGovRollback(null, 1, 'r'), () => dshGovRetire(null, 1, 'r'),
      () => dshGovAudit(null),
    ]
    for (const fn of calls) await expect(fn()).rejects.toThrow()
    expect(callWbMock).not.toHaveBeenCalled()
  })

  it('红线：全部输入序列化后绝无 factoryId', async () => {
    await dshGovPropose(SESSION, {
      requestId: 'r', capabilityKey: 'k', kind: 'skill', risk: 'A', autonomy: 'L0', budgetMonthly: 1,
    })
    await dshGovTrial(SESSION, { contractId: 1, success: true })
    for (const c of callWbMock.mock.calls) {
      expect(JSON.stringify(c[3] ?? {})).not.toContain('factoryId')
    }
  })
})
