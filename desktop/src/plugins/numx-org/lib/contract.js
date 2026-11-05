import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transport } from './transport-loader.js';

const { isSecureUrl } = transport;

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export const CONTRACT_VERSION = 1;
// 有意的双写安全基线：本矩阵与 contracts/orgPlugin.v1.json 必须同步修改并逐键比对，任何单边漂移都拒绝加载。
const ORG_WORKSPACE_EXPECTED_MATRIX = deepFreeze({
  'plugin.install': ['manager'],
  'cabin.manage': ['admin', 'manager'],
  'member.invite': ['admin', 'manager'],
  'task.execute': ['staff'],
  'review.submit': ['staff'],
  'review.decide': ['admin', 'manager'],
  'collab.scoped': [],
  'digital_employee.invoke': [],
});

const PROCEDURE_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]*$/;

export function isProcedureName(value) {
  return typeof value === 'string' && PROCEDURE_PATTERN.test(value);
}

function canonicalSecureOrigin(value, allowInsecureLoopback) {
  if (typeof value !== 'string') return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  return isSecureUrl(url, allowInsecureLoopback) && url.origin === value && !url.username && !url.password;
}

export function roleCapabilityValuesMatch(actual, expected) {
  return Array.isArray(actual) && Array.isArray(expected)
    && new Set(actual).size === actual.length
    && new Set(expected).size === expected.length
    && actual.length === expected.length
    && actual.every((role) => expected.includes(role));
}

export function roleCapabilitiesMatch(candidate, expected) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
    || !expected || typeof expected !== 'object' || Array.isArray(expected)) return false;
  const actualKeys = Object.keys(candidate).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every((key, index) => key === actualKeys[index] && roleCapabilityValuesMatch(candidate[key], expected[key]));
}

export function loadContract(contractPath) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  } catch (error) {
    throw new Error(`org_plugin_contract_load_failed:${contractPath}`, { cause: error });
  }
  const roleCapabilities = value?.roleCapabilities;
  const roleCapabilitiesValid = roleCapabilitiesMatch(roleCapabilities, ORG_WORKSPACE_EXPECTED_MATRIX);
  const read = value?.procedures?.read;
  const write = value?.procedures?.write;
  const confirm = value?.confirmProcedures;
  const publicProcedures = value?.procedures?.public;
  const proceduresValid = [read, write, confirm, publicProcedures].every((group) => Array.isArray(group) && group.length > 0
    && group.every(isProcedureName));
  const allProcedures = proceduresValid ? [...read, ...write] : [];
  const numericLimits = Object.keys(value?.limits || {});
  const orderingValid = value?.limits
    && value.limits.queryLimitMin <= value.limits.queryLimitMax
    && value.limits.idemKeyMinChars <= value.limits.idemKeyChars
    && value.limits.collabListLimit >= value.limits.queryLimitMin
    && value.limits.collabListLimit <= value.limits.queryLimitMax
    && value.limits.maxIpcEnvelopeBytes <= value.limits.maxResponseBytes;
  const valid = value?.version === CONTRACT_VERSION
    && typeof value.network?.endpoint === 'string'
    && Array.isArray(value.network?.allowedOrigins) && value.network.allowedOrigins.length > 0
    && typeof value.network?.allowInsecureLoopback === 'boolean'
    && value.network.allowedOrigins.every((origin) => canonicalSecureOrigin(origin, value.network.allowInsecureLoopback))
    && canonicalSecureOrigin(value.network.endpoint, value.network.allowInsecureLoopback)
    && value.network.allowedOrigins.includes(value.network.endpoint)
    && value.limits && numericLimits.length > 0 && numericLimits.every((key) => Number.isInteger(value.limits[key]) && value.limits[key] > 0)
    && orderingValid
    && proceduresValid
    && roleCapabilitiesValid
    && new Set(allProcedures).size === allProcedures.length
    && new Set(publicProcedures).size === publicProcedures.length
    // public 是独立的 UI 匿名白名单，不并入模型只读工具；匿名过程同样不得成为写过程。
    && publicProcedures.every((procedure) => !write.includes(procedure))
    && Array.isArray(confirm) && new Set(confirm).size === confirm.length
    && confirm.every((procedure) => write.includes(procedure))
    && write.every((procedure) => confirm.includes(procedure));
  if (!valid) throw new Error(`org_plugin_contract_invalid:${contractPath}`);
  return deepFreeze(value);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const contract = loadContract(path.join(here, '..', 'contracts', 'orgPlugin.v1.json'));

export function procedureAllowed(procedure, write = false, { publicOnly = false } = {}) {
  if (publicOnly) return contract.procedures.public.includes(procedure);
  const group = write ? contract.procedures.write : contract.procedures.read;
  return group.includes(procedure);
}

export function assertProcedureAllowed(procedure, write = false, options) {
  if (!procedureAllowed(procedure, write, options)) {
    throw new Error(write ? 'org_plugin_write_denied' : 'org_plugin_read_denied');
  }
}

export function assertNetworkAllowed(apiBase) {
  let url;
  try { url = new URL(apiBase); } catch { throw new Error('org_plugin_network_denied'); }
  const secure = isSecureUrl(url, contract.network.allowInsecureLoopback);
  if (!secure || !contract.network.allowedOrigins.includes(url.origin) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('org_plugin_network_denied');
  }
  return url.origin;
}

export function limits() {
  return contract.limits;
}

export function requiresConfirmation(procedure) {
  return contract.confirmProcedures.includes(procedure);
}

export default contract;
