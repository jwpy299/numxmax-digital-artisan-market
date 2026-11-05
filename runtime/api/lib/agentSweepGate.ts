export interface AgentSweepGateInput {
  sweepFlag: string | undefined
  nodeEnv: string | undefined
  explicitGateInstanceId: string | undefined
  sweepInstance: string | undefined
  isProduction: boolean
  allowNonProd: string | undefined
}

/** sweep 只在显式启用、环境许可、显式实例身份且指定实例匹配时启动。 */
export function resolveAgentSweepGate(input: AgentSweepGateInput) {
  const normalizedFlag = input.sweepFlag?.trim().toLowerCase() ?? ''
  const requested = ['1', 'true', 'yes'].includes(normalizedFlag) && input.nodeEnv !== 'test'
  const configurationInvalid = normalizedFlag !== '' && (!['1', 'true', 'yes'].includes(normalizedFlag) || input.nodeEnv === 'test')
  const explicitGateInstanceId = input.explicitGateInstanceId?.trim() ?? ''
  const sweepInstance = input.sweepInstance?.trim() ?? ''
  const hasExplicitGateInstanceId = explicitGateInstanceId.length > 0
  const hasSweepInstance = sweepInstance.length > 0
  const environmentAllowed = input.isProduction || input.allowNonProd === '1'
  const instanceMatches = hasExplicitGateInstanceId && hasSweepInstance && sweepInstance === explicitGateInstanceId
  return {
    requested,
    explicitGateInstanceId,
    sweepInstance,
    hasExplicitGateInstanceId,
    hasSweepInstance,
    environmentAllowed,
    configurationInvalid,
    instanceMatches,
    shouldStart: requested && !configurationInvalid && environmentAllowed && instanceMatches,
  }
}
