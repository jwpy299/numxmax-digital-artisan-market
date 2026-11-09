import { describe, expect, it } from 'vitest'
import { deriveRuntimePlanStatus, runtimeEventBackoffSeconds } from './service'

describe('runtime 编排纯状态与退避', () => {
  it('executed/submitted 不等于 done，全部接受才完成', () => {
    expect(deriveRuntimePlanStatus([{ status: 'awaiting_review' }, { status: 'accepted' }])).toBe('awaiting_review')
    expect(deriveRuntimePlanStatus([{ status: 'accepted' }, { status: 'accepted' }])).toBe('completed')
    expect(deriveRuntimePlanStatus([{ status: 'executing' }, { status: 'accepted' }])).toBe('running')
    expect(deriveRuntimePlanStatus([{ status: 'accepted' }, { status: 'cancelled' }])).toBe('attention_required')
  })
  it('竞岗、待派发和异常状态不被覆盖成完成', () => {
    expect(deriveRuntimePlanStatus([{ status: 'awaiting_selection' }, { status: 'selected' }])).toBe('awaiting_selection')
    expect(deriveRuntimePlanStatus([{ status: 'selected' }, { status: 'selected' }])).toBe('ready_to_dispatch')
    expect(deriveRuntimePlanStatus([{ status: 'failed' }, { status: 'accepted' }])).toBe('attention_required')
  })
  it('事件重试退避有界且确定', () => {
    expect(runtimeEventBackoffSeconds(1)).toBe(2)
    expect(runtimeEventBackoffSeconds(3)).toBe(8)
    expect(runtimeEventBackoffSeconds(20)).toBe(60)
  })
})
