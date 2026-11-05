import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertToolPoliciesComplete } from 'numx-org/lib/approval.js';
import contract, { deepFreeze, limits, roleCapabilitiesMatch, roleCapabilityValuesMatch } from 'numx-org/lib/contract.js';

const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'manifest.json');
let manifest;
let packageDefinition;
try {
  const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('manifest_not_object');
  manifest = deepFreeze(value);
  packageDefinition = JSON.parse(fs.readFileSync(path.join(path.dirname(manifestPath), 'package.json'), 'utf8'));
  if (!packageDefinition || typeof packageDefinition !== 'object' || Array.isArray(packageDefinition)) throw new Error('dept_finance_manifest_invalid:package');
} catch (error) {
  throw new Error('dept_finance_manifest_invalid:load', { cause: error });
}

const DEPT_PACKAGE_PREFIX = 'dept-';
export const FINANCE_DEPT = manifest.dept;
export const FINANCE_LEAD_STATION = manifest.leadStationKey;
export const FINANCE_MANIFEST = manifest;

function sameMembers(left, right) {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function assertFinanceRoleCapabilities(roleCapabilities) {
  // manifest.json 是有意的双写安全基线：任何矩阵变更都必须同步重签部门包，禁止静默漂移上架。
  const expectedRoleCapabilities = contract.roleCapabilities;
  if (roleCapabilitiesMatch(roleCapabilities, expectedRoleCapabilities)) return;
  if (!roleCapabilities || typeof roleCapabilities !== 'object' || Array.isArray(roleCapabilities)) throw new Error('dept_finance_manifest_invalid:role_capabilities');
  const actualKeys = Object.keys(roleCapabilities).sort();
  const expectedKeys = Object.keys(expectedRoleCapabilities).sort();
  if (!sameMembers(actualKeys, expectedKeys)) throw new Error('dept_finance_manifest_invalid:role_capabilities');
  for (const [capability, expectedRoles] of Object.entries(expectedRoleCapabilities)) {
    if (!roleCapabilityValuesMatch(roleCapabilities[capability], expectedRoles)) {
      throw new Error(`dept_finance_manifest_invalid:role_capabilities:${capability}`);
    }
  }
}

/** 生产只校验本目录已冻结的真包清单；测试篡改样本通过隔离包加载，不向本函数注入副本。 */
export function assertFinanceManifest(tools, policies) {
  const current = manifest;
  if (!Array.isArray(tools) || !policies || typeof policies !== 'object') throw new Error('dept_finance_manifest_invalid:tools');
  if (!current.allowedProcedures || typeof current.allowedProcedures !== 'object' || Array.isArray(current.allowedProcedures)) throw new Error('dept_finance_manifest_invalid:procedures');
  const packageName = packageDefinition.name;
  if (typeof packageName !== 'string' || !packageName.startsWith(DEPT_PACKAGE_PREFIX)) throw new Error('dept_finance_manifest_invalid:package_name');
  if (current.id !== packageName || current.entry !== packageDefinition.main || current.version !== packageDefinition.version) throw new Error('dept_finance_manifest_invalid');
  const expectedDept = packageName.slice(DEPT_PACKAGE_PREFIX.length);
  if (typeof current.dept !== 'string' || current.dept !== expectedDept || !/^[a-z][a-z0-9-]{0,30}$/.test(current.dept)) throw new Error('dept_finance_manifest_invalid:dept');
  if (typeof current.leadStationKey !== 'string' || current.leadStationKey !== `dept-${current.dept}-lead` || current.leadStationKey.length > limits().stationKeyChars) throw new Error('dept_finance_manifest_invalid:lead_station');
  assertFinanceRoleCapabilities(current.roleCapabilities);
  for (const group of ['read', 'write']) {
    const values = current.allowedProcedures[group];
    if (!Array.isArray(values) || !values.length || values.some((value) => typeof value !== 'string' || !value) || new Set(values).size !== values.length) {
      throw new Error(`dept_finance_manifest_invalid:${group}`);
    }
  }
  for (const tool of tools) {
    if (typeof policies[tool.name]?.procedure !== 'string') throw new Error(`dept_finance_manifest_procedure_missing:${tool.name}`);
  }
  assertToolPoliciesComplete(tools, policies);
  const expected = { read: new Set(), write: new Set(), confirm: new Set() };
  for (const tool of tools) {
    const policy = policies[tool.name];
    const readOnly = policy.readOnly === true;
    const group = readOnly ? 'read' : 'write';
    expected[group].add(policy.procedure);
    if (!readOnly) expected.confirm.add(policy.procedure);
  }
  for (const group of ['read', 'write', 'confirm']) {
    const actual = group === 'confirm' ? current.allowedProcedures.write : current.allowedProcedures[group]
    if (!sameMembers([...expected[group]], actual)) {
      throw new Error(`dept_finance_manifest_procedure_drift:${group}`);
    }
  }
}
