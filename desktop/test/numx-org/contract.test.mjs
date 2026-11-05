import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import contract, { loadContract, procedureAllowed, assertNetworkAllowed, requiresConfirmation } from '../../src/plugins/numx-org/lib/contract.js';

const { walkFiles, assertCordisPlugin } = createRequire(import.meta.url)('../../scripts/check-org-plugin-contract.cjs');

test('契约：读写过程、网络域和确认边界', () => {
  assert.equal(procedureAllowed('entCabin.map'), true);
  assert.equal(procedureAllowed('harnessProxy.tasks'), true);
  assert.equal(procedureAllowed('harnessProxy.delegate', true), true);
  assert.equal(procedureAllowed('sms.sendCode'), false, '匿名 UI 过程不得进入模型只读工具');
  assert.equal(procedureAllowed('sms.sendCode', false, { publicOnly: true }), true);
  assert.equal(procedureAllowed('entCabin.map', false, { publicOnly: true }), false, '匿名白名单不得反向后退为私有读取');
  assert.equal(procedureAllowed('harnessProxy.delegate', true, { publicOnly: true }), false, '匿名调用即使声明 write 也不得越过公开白名单');
  assert.equal(procedureAllowed('dshGovernance.propose'), false);
  assert.equal(requiresConfirmation('harnessProxy.delegate'), true);
  assert.equal(requiresConfirmation('entCabin.map'), false, '只读过程不得要求写入确认');
  assert.equal(Object.isFrozen(contract), true);
  assert.equal(Object.isFrozen(contract.limits), true);
  assert.equal(Object.isFrozen(contract.procedures.read), true);
  assert.throws(() => { contract.limits.timeoutMs = 1; }, TypeError);
  assert.equal(assertNetworkAllowed(contract.network.endpoint), contract.network.endpoint);
  const endpoint = new URL(contract.network.endpoint);
  for (const value of [
    'not-a-url',
    `http://${endpoint.host}`,
    `${contract.network.endpoint}/api`,
    `https://user:pass@${endpoint.host}`,
    `https://${endpoint.host}.evil.example`,
  ]) {
    assert.throws(() => assertNetworkAllowed(value), /org_plugin_network_denied/);
  }
});

test('契约角色矩阵使用独立安全基线，不从被测配置推导期望', () => {
  const canonical = (value) => Object.fromEntries(Object.entries(value).map(([capability, roles]) => [capability, [...roles].sort()]));
  assert.deepEqual(canonical(contract.roleCapabilities), canonical({
    'plugin.install': ['manager'],
    'cabin.manage': ['admin', 'manager'],
    'member.invite': ['admin', 'manager'],
    'task.execute': ['staff'],
    'review.submit': ['staff'],
    'review.decide': ['admin', 'manager'],
    'collab.scoped': [],
    'digital_employee.invoke': [],
  }));
});

test('契约：缺失或损坏时给出可定位的加载错误', () => {
  assert.throws(
    () => loadContract('/definitely/missing/orgPlugin.v1.json'),
    /org_plugin_contract_load_failed:\/definitely\/missing\/orgPlugin\.v1\.json/,
  );
  const directory = mkdtempSync(path.join(tmpdir(), 'numx-org-contract-'));
  try {
    const malformed = path.join(directory, 'malformed.json');
    writeFileSync(malformed, JSON.stringify({ ...contract, limits: { ...contract.limits, timeoutMs: 0 } }));
    assert.throws(() => loadContract(malformed), /org_plugin_contract_invalid:.*malformed\.json/);
    const nonCanonical = path.join(directory, 'non-canonical.json');
    writeFileSync(nonCanonical, JSON.stringify({ ...contract, network: { ...contract.network, allowedOrigins: [contract.network.endpoint, `${contract.network.endpoint}/`] } }));
    assert.throws(() => loadContract(nonCanonical), /org_plugin_contract_invalid:.*non-canonical\.json/);
    const badOrdering = path.join(directory, 'bad-ordering.json');
    writeFileSync(badOrdering, JSON.stringify({ ...contract, limits: { ...contract.limits, queryLimitMin: contract.limits.queryLimitMax + 1 } }));
    assert.throws(() => loadContract(badOrdering), /org_plugin_contract_invalid:.*bad-ordering\.json/);
    const badProcedures = path.join(directory, 'bad-procedures.json');
    writeFileSync(badProcedures, JSON.stringify({ ...contract, confirmProcedures: 'not-an-array' }));
    assert.throws(() => loadContract(badProcedures), /org_plugin_contract_invalid:.*bad-procedures\.json/);
    const roleVariants = [
      ['role-empty', { ...contract, roleCapabilities: { ...contract.roleCapabilities, 'task.execute': [] } }],
      ['role-key-deleted', (() => {
        const value = JSON.parse(JSON.stringify(contract));
        delete value.roleCapabilities['member.invite'];
        return value;
      })()],
      ['role-extra', { ...contract, roleCapabilities: { ...contract.roleCapabilities, 'extra.capability': [] } }],
      ['role-escalated', { ...contract, roleCapabilities: { ...contract.roleCapabilities, 'review.decide': ['staff'] } }],
      ['role-unknown', { ...contract, roleCapabilities: { ...contract.roleCapabilities, 'task.execute': ['owner'] } }],
      ['role-duplicate', { ...contract, roleCapabilities: { ...contract.roleCapabilities, 'cabin.manage': ['admin', 'admin'] } }],
      ['role-matrix-missing', { ...contract, roleCapabilities: undefined }],
      ['role-string', { ...contract, roleCapabilities: 'manager' }],
      ['role-array', { ...contract, roleCapabilities: [] }],
      ['role-swap', (() => {
        const value = JSON.parse(JSON.stringify(contract));
        delete value.roleCapabilities['member.invite'];
        value.roleCapabilities['extra.capability'] = ['manager'];
        return value;
      })()],
    ];
    for (const [name, value] of roleVariants) {
      const file = path.join(directory, `${name}.json`);
      writeFileSync(file, JSON.stringify(value));
      assert.throws(() => loadContract(file), new RegExp(`org_plugin_contract_invalid:.*${name}\\.json`));
    }
    const roleOrder = path.join(directory, 'role-order.json');
    writeFileSync(roleOrder, JSON.stringify({ ...contract, roleCapabilities: { ...contract.roleCapabilities, 'cabin.manage': ['manager', 'admin'] } }));
    assert.doesNotThrow(() => loadContract(roleOrder), '等价角色顺序不得误判为契约漂移');
    const badProcedureName = path.join(directory, 'bad-procedure-name.json');
    writeFileSync(badProcedureName, JSON.stringify({ ...contract, procedures: { ...contract.procedures, read: ['bad procedure'] } }));
    assert.throws(() => loadContract(badProcedureName), /org_plugin_contract_invalid:.*bad-procedure-name\.json/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('清单：隐藏文件计入漂移，符号链接明确失败', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'numx-org-inventory-'));
  try {
    writeFileSync(path.join(directory, 'declared.js'), 'module.exports = 1\n');
    writeFileSync(path.join(directory, '.undeclared'), 'hidden\n');
    assert.deepEqual(walkFiles(directory).map((file) => path.basename(file)).sort(), ['.undeclared', 'declared.js']);
    assert.throws(() => walkFiles(path.join(directory, 'declared.js')), /路径不是目录/);
    assert.throws(() => walkFiles(path.join(directory, 'missing-directory')), /目录不存在/);
    if (process.platform === 'win32') { t.skip('Windows 符号链接权限由打包主机单独验证'); return; }
    symlinkSync(path.join(directory, 'declared.js'), path.join(directory, 'node_modules'));
    assert.doesNotThrow(() => walkFiles(directory), 'node_modules 符号链接必须先跳过，而不是计为源文件');
    rmSync(path.join(directory, 'node_modules'));
    symlinkSync(path.join(directory, 'declared.js'), path.join(directory, 'linked.js'));
    assert.throws(() => walkFiles(directory), /不得包含符号链接/);
    const danglingRoot = path.join(directory, 'dangling-root');
    symlinkSync(path.join(directory, 'missing-target'), danglingRoot);
    assert.throws(() => walkFiles(danglingRoot), /不得包含符号链接/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cordis 清单：id/name/inject 必须来自同一个连续插件条目', () => {
  const source = `- insert:\n    - id: other\n      name: other\n      inject: [tools, credentials]\n    - id: numx-org\n      name: numx-org\n      inject: [tools]\n`;
  assert.throws(() => assertCordisPlugin(source, 'numx-org'), /numx-org cordis 有效声明缺失：inject/);
  assert.throws(() => assertCordisPlugin(source, 'missing'), /id 声明数量必须为 1/);
  const valid = source.replace('name: numx-org\n      inject: [tools]', 'name: numx-org # org plugin\n      inject: [tools, credentials]');
  assert.doesNotThrow(() => assertCordisPlugin(valid, 'numx-org'));
  const crossBlock = `- insert:\n    - id: numx-org\n      name: numx-org\n    - name: other\n      inject: [tools, credentials]\n`;
  assert.throws(() => assertCordisPlugin(crossBlock, 'numx-org'), /inject/, '后一块的 inject 不得替前一块兜底');
});
