import { describe, expect, it } from 'vitest'
import { resolveAgentSweepGate } from './agentSweepGate'

const base = { sweepFlag: '1', nodeEnv: 'production', explicitGateInstanceId: 's4-a', sweepInstance: 's4-a', isProduction: true, allowNonProd: undefined }

describe('agent sweep 实例门禁', () => {
  it('显式启用且实例匹配才允许启动', () => {
    expect(resolveAgentSweepGate(base).shouldStart).toBe(true)
  })

  it('缺少显式 GATE_INSTANCE_ID 时 fail-closed', () => {
    const result = resolveAgentSweepGate({ ...base, explicitGateInstanceId: undefined, sweepInstance: undefined })
    expect(result.hasExplicitGateInstanceId).toBe(false)
    expect(result.shouldStart).toBe(false)
  })

  it('指定实例不匹配时禁止其他副本启动', () => {
    expect(resolveAgentSweepGate({ ...base, sweepInstance: 's4-b' }).shouldStart).toBe(false)
    expect(resolveAgentSweepGate({ ...base, sweepInstance: undefined }).shouldStart).toBe(false)
  })

  it('测试环境与未显式启用均不启动', () => {
    expect(resolveAgentSweepGate({ ...base, nodeEnv: 'test' }).shouldStart).toBe(false)
    expect(resolveAgentSweepGate({ ...base, sweepFlag: undefined }).shouldStart).toBe(false)
    expect(resolveAgentSweepGate({ ...base, isProduction: false, nodeEnv: 'development' }).shouldStart).toBe(false)
    expect(resolveAgentSweepGate({ ...base, isProduction: false, nodeEnv: 'development', allowNonProd: '1' }).shouldStart).toBe(true)
  })
})
