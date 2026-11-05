import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apply, createTools, inject, name } from '../../src/plugins/dept-finance/lib/index.js';
import { FINANCE_POLICIES } from '../../src/plugins/dept-finance/lib/tools.js';
import { assertFinanceManifest, FINANCE_MANIFEST } from '../../src/plugins/dept-finance/lib/manifest.js';

const cloneManifest = () => JSON.parse(JSON.stringify(FINANCE_MANIFEST));
const packageDefinition = JSON.parse(readFileSync(new URL('../../src/plugins/dept-finance/package.json', import.meta.url), 'utf8'));
let mutationSequence = 0;
async function assertManifestMutation(tools, mutate, expected, mutatePackage) {
  const directory = mkdtempSync(join(tmpdir(), 'finance-manifest-'));
  try {
    mkdirSync(join(directory, 'lib'));
    mkdirSync(join(directory, 'node_modules'));
    symlinkSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/plugins/numx-org'), join(directory, 'node_modules', 'numx-org'), 'junction');
    const value = cloneManifest();
    mutate(value);
    const definition = mutatePackage ? mutatePackage({ ...packageDefinition, type: 'module' }) : { ...packageDefinition, type: 'module' };
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(value));
    writeFileSync(join(directory, 'package.json'), JSON.stringify(definition));
    copyFileSync(new URL('../../src/plugins/dept-finance/lib/manifest.js', import.meta.url), join(directory, 'lib', 'manifest.js'));
    mutationSequence += 1;
    const loaded = await import(`${pathToFileURL(join(directory, 'lib', 'manifest.js')).href}?mutation=${mutationSequence}`);
    if (expected === null) assert.doesNotThrow(() => loaded.assertFinanceManifest(tools, FINANCE_POLICIES), '等价顺序变化不得误判为 manifest 漂移');
    else assert.throws(() => loaded.assertFinanceManifest(tools, FINANCE_POLICIES), expected);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('财务舱：命名导出、真实工具注册与 manifest 闭环', () => {
  assert.equal(name, 'dept-finance');
  assert.deepEqual(inject, ['tools', 'credentials']);
  const registered = [];
  const activeTools = new Set();
  const listeners = new Map();
  const tools = createTools({ credentials: { readRecord: async () => undefined, deleteRecord: async () => {} } });
  assertFinanceManifest(tools, FINANCE_POLICIES);
  const dispose = apply({
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    tools: { register: (tool) => { registered.push(tool); activeTools.add(tool.name); return () => activeTools.delete(tool.name); } },
    credentials: { readRecord: async () => undefined },
  });
  assert.equal(typeof dispose, 'function');
  assert.equal(FINANCE_MANIFEST.dept, 'finance');
  assert.deepEqual(FINANCE_MANIFEST.roleCapabilities['plugin.install'], ['manager']);
  assert.deepEqual(FINANCE_MANIFEST.roleCapabilities['task.execute'], ['staff']);
  assert.deepEqual(FINANCE_MANIFEST.roleCapabilities['collab.scoped'], []);
  assert.deepEqual(FINANCE_MANIFEST.roleCapabilities['digital_employee.invoke'], []);
  assert.equal(FINANCE_MANIFEST.roleCapabilities['plugin.install'].includes('admin'), false, '部门包安装不得扩成 admin');
  assert.deepEqual(registered.map((tool) => tool.name).sort(), tools.map((tool) => tool.name).sort());
  assert.ok(registered.every((tool) => {
    const branches = tool.output?.schema?.oneOf;
    return typeof tool.output.render === 'function' && Array.isArray(branches)
      && branches.every((branch) => typeof branch.type === 'string')
      && ['object', 'array', 'null'].every((type) => branches.some((branch) => branch.type === type));
  }), '财务工具输出必须使用 DSH 支持的 oneOf 单类型分支');
  assert.ok(registered.every((tool) => Object.hasOwn(FINANCE_POLICIES, tool.name)));
  assert.equal(typeof listeners.get('tools/pre-execute'), 'function');
  assert.equal(Object.isFrozen(FINANCE_POLICIES.finance_tasks), true);
  const require = createRequire(import.meta.url);
  const rootPackage = require('../../package.json');
  assert.equal(rootPackage.optionalDependencies['dept-finance'], 'file:src/plugins/dept-finance');
  assert.doesNotThrow(() => require.resolve('dept-finance/package.json'), '部门包必须真实安装，而非仅有源码目录');
  assert.throws(() => assertFinanceManifest([{ name: 'bad' }], { bad: { readOnly: true } }), /dept_finance_manifest_procedure_missing/);
  assert.throws(() => assertFinanceManifest(tools, { ...FINANCE_POLICIES, finance_tasks: { readOnly: true, procedure: 'harnessProxy.notices' } }), /dept_finance_manifest_procedure_drift:read/);
  dispose();
  assert.equal(listeners.size, 0);
  assert.equal(activeTools.size, 0);
});

test('财务舱：生产入口只认隔离真包，全部 manifest 漂移均 fail-closed', async () => {
  const tools = createTools({ credentials: { readRecord: async () => undefined, deleteRecord: async () => {} } });
  const cases = [
    [(value) => { value.allowedProcedures.read.reverse(); value.roleCapabilities['cabin.manage'].reverse(); }, null],
    [(value) => { value.roleCapabilities['review.decide'] = ['staff']; }, /dept_finance_manifest_invalid:role_capabilities:review.decide/],
    [(value) => { delete value.roleCapabilities['task.execute']; }, /dept_finance_manifest_invalid:role_capabilities$/],
    [(value) => { value.roleCapabilities['extra.capability'] = ['staff']; }, /dept_finance_manifest_invalid:role_capabilities/],
    [(value) => { value.roleCapabilities['collab.scoped'] = null; }, /dept_finance_manifest_invalid:role_capabilities:collab.scoped/],
    [(value) => { value.roleCapabilities['cabin.manage'] = ['admin', 'admin']; }, /dept_finance_manifest_invalid:role_capabilities:cabin.manage/],
    [(value) => { value.roleCapabilities['cabin.manage'] = ['staff', 'manager']; }, /dept_finance_manifest_invalid:role_capabilities:cabin.manage/],
    [(value) => { delete value.roleCapabilities['plugin.install']; }, /dept_finance_manifest_invalid:role_capabilities$/],
    [(value) => { delete value.roleCapabilities; }, /dept_finance_manifest_invalid:role_capabilities$/],
    [(value) => { value.roleCapabilities = []; }, /dept_finance_manifest_invalid:role_capabilities$/],
    [(value) => { value.allowedProcedures.read = value.allowedProcedures.read.filter((procedure) => procedure !== 'harnessProxy.tasks'); }, /dept_finance_manifest_procedure_drift:read/],
    [(value) => { value.version = '9.9.9'; }, /dept_finance_manifest_invalid$/],
    [(value) => { value.dept = 'produce'; }, /dept_finance_manifest_invalid:dept/],
    [(value) => { value.leadStationKey = 'dept-produce-lead'; }, /dept_finance_manifest_invalid:lead_station/],
    [(value) => { value.roleCapabilities['plugin.install'] = ['admin', 'manager']; }, /dept_finance_manifest_invalid:role_capabilities:plugin.install/],
  ];
  for (const [mutate, expected] of cases) await assertManifestMutation(tools, mutate, expected);
  await assertManifestMutation(tools, () => {}, /dept_finance_manifest_invalid:package_name/, (definition) => { definition.name = 'finance-pack'; return definition; });
});

test('财务舱：读工具放行，所有写工具都要求人工确认', async () => {
  const listeners = new Map();
  const dispose = apply({
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    tools: { register: () => () => {} },
    credentials: { readRecord: async () => undefined },
  });
  const gate = listeners.get('tools/pre-execute');
  const readOnlyTools = Object.entries(FINANCE_POLICIES).filter(([, policy]) => policy.readOnly === true).map(([toolName]) => toolName);
  const writeTools = Object.entries(FINANCE_POLICIES).filter(([, policy]) => policy.readOnly !== true).map(([toolName]) => toolName);
  const toolNames = createTools({ credentials: { readRecord: async () => undefined } }).map((tool) => tool.name);
  assert.deepEqual([...readOnlyTools, ...writeTools].sort(), toolNames.sort());
  for (const toolName of readOnlyTools) {
    assert.deepEqual(await gate({ name: toolName, arguments: {} }, async () => ({ kind: 'allow' })), { kind: 'allow' });
  }
  for (const toolName of writeTools) {
    const decision = await gate({ name: toolName, arguments: {} });
    assert.equal(decision.kind, 'ask', `${toolName} 缺少审批`);
    assert.match(decision.reason, /harnessProxy\./);
  }
  assert.equal(await gate({ name: 'bash', arguments: {} }, async () => undefined), undefined);
  dispose();
});

test('财务舱：缺少 DSH 凭据服务时 fail-closed，且不注册工具', () => {
  const registered = [];
  assert.throws(() => apply({
    on: () => () => {},
    tools: { register: (tool) => registered.push(tool) },
    credentials: {},
  }), /dept_finance_credentials_unavailable/);
  assert.equal(registered.length, 0);
});

test('财务舱：注册结果不确定时注销已确认工具并保守保留审批门', () => {
  const listeners = new Map();
  const activeTools = new Set();
  let calls = 0;
  assert.throws(() => apply({
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    tools: { register: (tool) => {
      calls += 1;
      activeTools.add(tool.name);
      if (calls === 3) throw new Error('finance_register_failed');
      return () => activeTools.delete(tool.name);
    } },
    credentials: { readRecord: async () => undefined },
  }), /finance_register_failed/);
  assert.equal(activeTools.size, 1, '注册抛出前的潜在孤儿工具无法被证明不存在');
  assert.equal(listeners.size, 1, '注册结果不确定时必须保留审批门');
});

test('财务舱：宿主不支持工具注销时保留审批门保护孤儿工具', () => {
  const listeners = new Map();
  const activeTools = new Set();
  let calls = 0;
  assert.throws(() => apply({
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    tools: { register: (tool) => {
      calls += 1;
      activeTools.add(tool.name);
      if (calls === 3) return undefined;
      return () => activeTools.delete(tool.name);
    } },
    credentials: { readRecord: async () => undefined },
  }), (error) => error.message === 'dept_finance_tool_disposer_unavailable:finance_employees');
  assert.equal(activeTools.size, 1);
  assert.equal(listeners.size, 1, '审批门不得先于孤儿工具被释放');
});

test('财务舱：工具注销失败时不得先撤审批门', () => {
  const listeners = new Map();
  const activeTools = new Set();
  const dispose = apply({
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    tools: { register: (tool) => {
      activeTools.add(tool.name);
      return () => {
        if (tool.name === 'finance_delegate') throw new Error('finance_dispose_failed');
        activeTools.delete(tool.name);
      };
    } },
    credentials: { readRecord: async () => undefined },
  });
  assert.throws(dispose, /finance_dispose_failed/);
  assert.equal(activeTools.has('finance_delegate'), true);
  assert.equal(activeTools.size, 1, '其他已确认注销的工具不应被重复计数');
  assert.equal(listeners.size, 1, '仍有工具可能活跃时审批门必须保留');
});
