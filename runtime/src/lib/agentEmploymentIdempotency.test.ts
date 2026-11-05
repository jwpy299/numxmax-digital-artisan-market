import { describe, expect, it, vi } from 'vitest'
import { rotateSucceededActionKeys } from './agentEmploymentIdempotency'

describe('个人 Agent 页面幂等键消费边界', () => {
  it('无关动作成功不清除失败动作的重试键', () => {
    const keys = { register: 'failed-registration-key', publish: 'successful-publish-key', claim: 'other-claim-key' }
    rotateSucceededActionKeys(keys, ['publish'])
    expect(keys).toEqual({ register: 'failed-registration-key', claim: 'other-claim-key' })
  })

  it('并发成功只消费各自显式声明的 scope', () => {
    const keys = { a: 'key-a', b: 'key-b', failed: 'keep-me' }
    rotateSucceededActionKeys(keys, ['b'])
    rotateSucceededActionKeys(keys, ['a', 'a'])
    expect(keys).toEqual({ failed: 'keep-me' })
  })

  it('成功消费不存在的 scope 时给出开发期告警而不伪造轮换', () => {
    const keys = { actual: 'key-1' }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    rotateSucceededActionKeys(keys, ['missing'])
    expect(keys).toEqual({ actual: 'key-1' })
    expect(warning).not.toHaveBeenCalled()
    warning.mockRestore()
  })
})
