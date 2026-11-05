import { describe, expect, it, vi } from 'vitest'
import { insertWalletFlow, WalletFlowContractError } from './walletFlow'

const base = { ownerType: 'enterprise' as const, ownerId: 1, direction: 'out' as const, amount: 1, balanceAfter: 0, bizType: 'test_flow', refId: 'test:1' }

describe('walletFlow canonical 输入契约', () => {
  it('零金额与负金额不得形成台账', async () => {
    for (const amount of [0, -1, 1.5, Number.NaN]) {
      await expect(insertWalletFlow({ execute: vi.fn() } as never, { ...base, amount })).rejects.toThrow(WalletFlowContractError)
    }
  })
  it('运行时方向非法直接拒绝，不写 SQL', async () => {
    const execute = vi.fn()
    await expect(insertWalletFlow({ execute } as never, { ...base, direction: 'sideways' as never })).rejects.toThrow('wallet_flow_direction_invalid')
    expect(execute).not.toHaveBeenCalled()
  })
  it('合法正向流水仍正常写入', async () => {
    const execute = vi.fn(async () => [{ affectedRows: 1 }])
    await insertWalletFlow({ execute } as never, base)
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
