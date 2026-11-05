import { procedureAllowed, requiresConfirmation } from './contract.js';
import { argsOf, procedureForPolicy, TOOL_POLICIES, tools } from './tools.js';

export { TOOL_POLICIES } from './tools.js';

function isReadOnly(policy, args) {
  return typeof policy.readOnly === 'function' ? policy.readOnly(args) : policy.readOnly === true;
}

export function procedureForExecution(exec, policies = TOOL_POLICIES) {
  if (!Object.hasOwn(policies, exec?.name)) return null;
  const policy = policies[exec.name];
  if (Array.isArray(policy.procedures)) return policy.procedures;
  return procedureForPolicy(policy, argsOf(exec?.arguments));
}

/** 接入 DSH 原生 approval 服务：只有真实用户的 allowed-once 才会放行，headless/无审批通道自动拒绝。 */
export function createApprovalGate(extraPolicies = {}, toolList = tools) {
  if (!extraPolicies || typeof extraPolicies !== 'object' || Array.isArray(extraPolicies)) throw new Error('org_plugin_policy_invalid');
  for (const toolName of Object.keys(extraPolicies)) {
    if (Object.hasOwn(TOOL_POLICIES, toolName)) throw new Error(`org_plugin_policy_conflict:${toolName}`);
  }
  const policies = { ...TOOL_POLICIES, ...extraPolicies };
  for (const toolName of Object.keys(extraPolicies)) {
    if (!toolList.some((tool) => tool.name === toolName)) throw new Error(`org_plugin_policy_unknown_tool:${toolName}`);
  }
  assertToolPoliciesComplete(toolList, policies);
  return async (exec, next) => {
    // DSH tools/pre-execute 是决策 waterfall：next() 只委托后续决策，不执行工具。
    // 无下游或下游未决不等于批准；本插件写操作仍必须提升为 ask。
    const downstream = typeof next === 'function' ? await next() : undefined;
    if (downstream !== undefined && downstream !== null && downstream?.kind !== 'allow') return downstream;
    const fallback = downstream ?? { kind: 'allow' };
    if (!Object.hasOwn(policies, exec?.name)) return downstream;
    const policy = policies[exec.name];
    const args = argsOf(exec?.arguments);
    const procedure = procedureForExecution(exec, policies);
    if (isReadOnly(policy, args)) {
      const allowed = Array.isArray(procedure) ? procedure.every((item) => procedureAllowed(item)) : procedureAllowed(procedure);
      if (!allowed) {
        return { kind: 'deny', reason: `org_plugin_read_denied:${exec.name}` };
      }
      return fallback;
    }
    if (!requiresConfirmation(procedure)) {
      return { kind: 'deny', reason: `org_plugin_confirmation_unmapped:${exec.name}` };
    }
    return { kind: 'ask', reason: `NumX 组织写操作 ${procedure} 需要本人单次确认` };
  };
}

function assertPolicyProcedure(toolName, procedure, write) {
  const allowed = write ? procedureAllowed(procedure, true) && requiresConfirmation(procedure) : procedureAllowed(procedure);
  if (!allowed) throw new Error(`org_plugin_policy_procedure_unknown:${toolName}:${procedure}:${write ? 'write' : 'read'}`);
}

function policySampleArguments(tool, policy) {
  if (policy.sampleArguments !== undefined) {
    const samples = policy.sampleArguments;
    if (!Array.isArray(samples) || !samples.length || samples.some((args) => !args || typeof args !== 'object' || Array.isArray(args))) {
      throw new Error(`org_plugin_policy_samples_invalid:${tool.name}`);
    }
    return samples;
  }
  const actions = tool.parameters?.properties?.action?.enum;
  if (Array.isArray(actions) && actions.length && actions.every((action) => typeof action === 'string')) return actions.map((action) => ({ action }));
  return [{}];
}

export function assertToolPoliciesComplete(toolList = tools, policies = TOOL_POLICIES) {
  for (const tool of toolList) {
    if (!Object.hasOwn(policies, tool.name)) throw new Error(`org_plugin_policy_missing:${tool.name}`);
    const policy = policies[tool.name];
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error(`org_plugin_policy_missing:${tool.name}`);
    if (Array.isArray(policy.procedures)) {
      if (!policy.procedures.length) throw new Error(`org_plugin_policy_procedures_empty:${tool.name}`);
      if (policy.readOnly !== true) throw new Error(`org_plugin_policy_plural_write:${tool.name}`);
      for (const procedure of policy.procedures) assertPolicyProcedure(tool.name, procedure, false);
      continue;
    }
    if (typeof policy.procedure === 'string') {
      assertPolicyProcedure(tool.name, policy.procedure, policy.readOnly !== true);
    } else if (typeof policy.procedure === 'function') {
      for (const args of policySampleArguments(tool, policy)) {
        const readOnly = isReadOnly(policy, args);
        assertPolicyProcedure(tool.name, policy.procedure(args), !readOnly);
      }
    } else {
      throw new Error(`org_plugin_policy_procedure_missing:${tool.name}`);
    }
  }
}
